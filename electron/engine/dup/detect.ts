import type {
  DupCategory,
  DupFailure,
  DupFileEntry,
  DupGroup,
  DupPhase,
} from '../../../shared/dup-types';
import type { DupCandidate } from './scan';
import {
  FULL_HASH_LIMIT_BYTES,
  hashFullFilesDetailed,
  hashPartialsDetailed,
  dupHashConcurrency,
} from './hash';

/**
 * 三级判定流水线与结果分组（FR-03 ~ FR-05）。
 *
 * 判定按「代价由低到高」推进，每级淘汰后不再进入下一级：
 * 1. **按大小分桶（零 I/O）**：size 唯一的文件直接出局，不读一个字节；
 * 2. **首尾 64 KiB 局部哈希**：只对同桶候选计算；
 * 3. **全量 SHA-256**：只对局部哈希仍相同的候选计算。
 *
 * 超过 256 MiB 的文件跳过全量校验，标记「疑似重复（未全量校验）」，
 * 与确定结果分栏展示，绝不混入确定结果（FR-03）。
 */

/** 大小写不敏感文件系统（Windows / macOS）：同名判定按文件系统语义归一 */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

/** 副本标记：文件名含这些特征时不被选为组主（FR-07） */
const COPY_MARKER_TEXT = /副本/i;
const COPY_MARKER_NUMBER = /\(\d+\)/;
const COPY_MARKER_WORD = /copy/i;

export interface DetectProgressUpdate {
  phase: DupPhase;
  label: string;
  done: number;
  total: number;
  bytesRead: number;
}

export interface DetectInput {
  /** 扫描根 */
  root: string;
  /** 参与判定的文件 */
  candidates: DupCandidate[];
  /** 取消判定 */
  isCancelled?: () => boolean;
  /** 阶段进度回调 */
  onProgress?: (update: DetectProgressUpdate) => void;
  /** 抑制判定：该内容哈希是否已被黑名单抑制 */
  isSuppressed?: (sha256: string) => boolean;
  /** 命中抑制时的回调（用于累计命中次数） */
  onSuppressed?: (sha256: string) => void;
}

export interface DetectResult {
  /** 内容重复组（哈希完全相同） */
  identicalGroups: DupGroup[];
  /** 疑似重复组（大文件未做全量校验） */
  suspectedGroups: DupGroup[];
  /** 同名不同内容组（独立告警区） */
  nameConflictGroups: DupGroup[];
  /** 判定失败的文件：无法完成哈希，不参与任何分组 */
  failures: DupFailure[];
  /** 因抑制黑名单跳过的组数 */
  skippedSuppressed: number;
  /** 参与局部哈希的文件数 */
  partialHashedFiles: number;
  /** 参与全量哈希的文件数 */
  hashedFiles: number;
  /** 判定阶段读取的总字节 */
  bytesRead: number;
  /** 是否被取消 */
  cancelled: boolean;
}

/** 取消信号：在进度回调里抛出以立刻中断当前阶段 */
class DetectCancelled extends Error {
  constructor() {
    super('扫描已取消');
    this.name = 'DetectCancelled';
  }
}

function posixCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 文件名是否带副本标记。
 *
 * 覆盖需求列举的 `(1)`、`副本`、`copy`、`Copy`、` - Copy`；
 * 数字副本标记放宽为 `(1)`、`(2)` 这类通用写法——它们的语义完全一致。
 */
export function hasCopyMarker(fileName: string): boolean {
  return COPY_MARKER_TEXT.test(fileName) || COPY_MARKER_NUMBER.test(fileName) || COPY_MARKER_WORD.test(fileName);
}

/**
 * 选出组内建议保留的那一份（FR-07）。
 *
 * 优先级：
 * 1. 文件名不含副本标记者优先；
 * 2. 修改时间最早者优先（副本的 mtime 通常等于复制时间，晚于原件）；
 * 3. 路径最短者优先；
 * 4. 路径字典序兜底。
 *
 * 组主只是**建议**，不会自动删除任何文件。
 */
export function pickGroupKeeper(entries: DupFileEntry[]): DupFileEntry | undefined {
  if (entries.length === 0) return undefined;
  return [...entries].sort((a, b) => {
    const markerA = hasCopyMarker(a.fileName) ? 1 : 0;
    const markerB = hasCopyMarker(b.fileName) ? 1 : 0;
    if (markerA !== markerB) return markerA - markerB;
    if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs - b.mtimeMs;
    if (a.absPath.length !== b.absPath.length) return a.absPath.length - b.absPath.length;
    return posixCompare(a.absPath, b.absPath);
  })[0];
}

/** 条目稳定标识：绝对路径 + 内容哈希前缀，同一根目录内唯一 */
function entryId(file: DupCandidate, hash: string): string {
  return `${file.absPath}::${hash.slice(0, 16)}`;
}

function toEntry(
  file: DupCandidate,
  hash: string,
  options: { partialHash?: string; suspected?: boolean } = {},
): DupFileEntry {
  return {
    id: entryId(file, hash),
    absPath: file.absPath,
    relPath: file.relPath,
    dirPath: file.dirPath,
    fileName: file.fileName,
    size: file.size,
    mtimeMs: file.mtimeMs,
    dev: file.dev,
    ino: file.ino,
    sha256: hash,
    partialHash: options.partialHash,
    suspected: options.suspected,
    state: 'pending',
  };
}

/**
 * 组标识：
 * - 内容重复组用内容哈希（稳定、可直接作为抑制键）；
 * - 疑似组用局部哈希并加前缀，避免与内容哈希混淆；
 * - 同名不同内容组由「父目录 + 文件名」派生。
 */
function groupId(category: DupCategory, key: string): string {
  if (category === 'identical') return `c:${key}`;
  if (category === 'suspected') return `s:${key}`;
  return `n:${key}`;
}

/** 构建一个结果组：份数、可回收空间、建议保留项 */
function buildGroup(
  category: DupCategory,
  id: string,
  fingerprint: string,
  sha256: string | undefined,
  entries: DupFileEntry[],
  extra: { dirPath?: string; fileName?: string } = {},
): DupGroup {
  const size = entries[0]?.size ?? 0;
  // 可回收空间 =（份数 − 1）× 单份大小；同名不同内容组恒为 0（FR-17）
  const reclaimableBytes = category === 'same-name-diff-content' ? 0 : Math.max(0, entries.length - 1) * size;
  const keeper = pickGroupKeeper(entries);
  return {
    id,
    category,
    fingerprint,
    sha256,
    entries,
    size,
    reclaimableBytes,
    suggestedKeeperId: keeper?.id,
    dirPath: extra.dirPath,
    fileName: extra.fileName,
  };
}

/**
 * 同名判定的键：同一父目录 + 同一文件名（按文件系统语义归一）。
 *
 * 归一规则对齐 §12.2 的风险缓解口径：
 * - **Unicode 归一（NFC）**：NTFS 不做 Unicode 规范化，NFC 与 NFD 两种写法
 *   在磁盘上是两个文件，对用户而言却是同一个名字，必须归一后才算同名；
 * - **大小写**：只在大小写不敏感的文件系统（Windows / macOS）上折叠，
 *   避免在大小写敏感卷上把 `Report.txt` 与 `report.txt` 误判成同名冲突。
 */
function nameKey(dirPath: string, fileName: string): string {
  const normalized = fileName.normalize('NFC');
  const name = CASE_INSENSITIVE_FS ? normalized.toLowerCase() : normalized;
  return `${dirPath}\u0000${name}`;
}

/**
 * 同名不同内容分组（FR-05）。
 *
 * 判定范围：**同一父目录内**同名、且内容哈希不同的文件。
 * 跨目录同名文件不进入本类——同名不构成重复，它们只是各自目录里的普通文件。
 *
 * 单独导出以便单元测试直接用构造好的条目验证判定口径。
 */
export function groupNameConflicts(entries: DupFileEntry[]): DupGroup[] {
  const buckets = new Map<string, { dirPath: string; fileName: string; entries: DupFileEntry[] }>();
  for (const entry of entries) {
    const key = nameKey(entry.dirPath, entry.fileName);
    const bucket = buckets.get(key);
    if (bucket) bucket.entries.push(entry);
    else buckets.set(key, { dirPath: entry.dirPath, fileName: entry.fileName, entries: [entry] });
  }

  const groups: DupGroup[] = [];
  for (const [key, bucket] of buckets) {
    if (bucket.entries.length < 2) continue;
    // 内容哈希全相同 → 属于「内容重复」，不在本类重复出现（FR-04 验收）
    const distinct = new Set(bucket.entries.map((entry) => entry.sha256));
    if (distinct.size < 2) continue;
    const sorted = [...bucket.entries].sort((a, b) => posixCompare(a.absPath, b.absPath));
    const fingerprint = sorted[0].sha256.slice(0, 8);
    groups.push(
      buildGroup('same-name-diff-content', groupId('same-name-diff-content', key), fingerprint, undefined, sorted, {
        dirPath: bucket.dirPath,
        fileName: bucket.fileName,
      }),
    );
  }
  return groups.sort((a, b) => posixCompare(a.id, b.id));
}

/**
 * 执行三级判定流水线并产出结果分组。
 *
 * 语义边界：
 * - 只读：全程只做 stat / read，不写被检测目录；
 * - 判定失败的文件不参与任何分组，也不等于「不重复」；
 * - 被取消时返回已完成的部分结果，`cancelled` 为 true，绝不报完成。
 */
export async function detectDuplicates(input: DetectInput): Promise<DetectResult> {
  const failures: DupFailure[] = [];
  const identicalGroups: DupGroup[] = [];
  const suspectedGroups: DupGroup[] = [];
  let skippedSuppressed = 0;
  let partialHashedFiles = 0;
  let hashedFiles = 0;
  let bytesRead = 0;
  let cancelled = false;

  const report = (phase: DupPhase, label: string, done: number, total: number): void => {
    input.onProgress?.({ phase, label, done, total, bytesRead });
  };
  const checkCancelled = (): void => {
    if (input.isCancelled?.()) throw new DetectCancelled();
  };

  try {
    // ---- 第一阶段：按大小分桶（零 I/O）----
    report('bucketing', '大小分桶', 0, input.candidates.length);
    const buckets = new Map<number, DupCandidate[]>();
    for (const file of input.candidates) {
      const bucket = buckets.get(file.size);
      if (bucket) bucket.push(file);
      else buckets.set(file.size, [file]);
    }
    // size 唯一的文件直接出局：不读一个字节（FR-03）
    const partialTargets: DupCandidate[] = [];
    for (const bucket of buckets.values()) {
      if (bucket.length >= 2) partialTargets.push(...bucket);
    }
    checkCancelled();

    // ---- 第二阶段：首尾 64 KiB 局部哈希 ----
    report('partial-hashing', '局部哈希', 0, partialTargets.length);
    let partialBytes = 0;
    const partial = await hashPartialsDetailed(
      partialTargets.map((file) => ({ key: file.absPath, path: file.absPath, size: file.size })),
      dupHashConcurrency(),
      (done, total, read) => {
        partialBytes = read;
        report('partial-hashing', '局部哈希', done, total);
        checkCancelled();
      },
    );
    partialHashedFiles = partialTargets.length;
    bytesRead += partialBytes;
    for (const [key, reason] of partial.errors) {
      const file = partialTargets.find((item) => item.absPath === key);
      failures.push({ absPath: key, relPath: file?.relPath ?? key, reason: `局部哈希失败：${reason}` });
    }

    // 局部哈希分组：同 size 且局部哈希相同才进入下一级
    const partialBuckets = new Map<string, DupCandidate[]>();
    for (const file of partialTargets) {
      const hash = partial.hashes.get(file.absPath);
      if (!hash) continue;
      const key = `${file.size}:${hash}`;
      const bucket = partialBuckets.get(key);
      if (bucket) bucket.push(file);
      else partialBuckets.set(key, [file]);
    }
    checkCancelled();

    // ---- 第三阶段：全量 SHA-256（疑似区不参与）----
    const fullTargets: DupCandidate[] = [];
    const suspectedBuckets: { key: string; members: DupCandidate[]; partialHash: string }[] = [];
    for (const [key, members] of partialBuckets) {
      if (members.length < 2) continue;
      if (members[0].size > FULL_HASH_LIMIT_BYTES) {
        suspectedBuckets.push({ key, members, partialHash: key.slice(key.indexOf(':') + 1) });
        continue;
      }
      fullTargets.push(...members);
    }

    // 同名不同内容区需要内容哈希做差异证据（FR-05）。
    // 同一父目录内同名在真实文件系统上几乎不会出现，因此这里的额外读取量趋近于零。
    const nameBuckets = new Map<string, DupCandidate[]>();
    for (const file of input.candidates) {
      const key = nameKey(file.dirPath, file.fileName);
      const bucket = nameBuckets.get(key);
      if (bucket) bucket.push(file);
      else nameBuckets.set(key, [file]);
    }
    const fullSet = new Set(fullTargets.map((file) => file.absPath));
    for (const bucket of nameBuckets.values()) {
      if (bucket.length < 2) continue;
      for (const file of bucket) {
        if (!fullSet.has(file.absPath)) {
          fullSet.add(file.absPath);
          fullTargets.push(file);
        }
      }
    }

    report('hashing', '全量哈希', 0, fullTargets.length);
    let fullBytes = 0;
    const full = await hashFullFilesDetailed(
      fullTargets.map((file) => ({ key: file.absPath, path: file.absPath, size: file.size })),
      dupHashConcurrency(),
      (done, total, read) => {
        fullBytes = read;
        report('hashing', '全量哈希', done, total);
        checkCancelled();
      },
    );
    hashedFiles = fullTargets.length;
    bytesRead += fullBytes;
    for (const [key, reason] of full.errors) {
      const file = fullTargets.find((item) => item.absPath === key);
      failures.push({ absPath: key, relPath: file?.relPath ?? key, reason: `全量哈希失败：${reason}` });
    }
    checkCancelled();

    // ---- 汇总阶段：把判定结果归并成三个结果区（FR-05、FR-15）----
    report('summarizing', '汇总', 0, partialBuckets.size);

    // ---- 汇总：内容重复组 ----
    for (const members of partialBuckets.values()) {
      if (members.length < 2) continue;
      if (members[0].size > FULL_HASH_LIMIT_BYTES) continue; // 疑似区单独处理
      const byHash = new Map<string, DupCandidate[]>();
      for (const file of members) {
        const hash = full.hashes.get(file.absPath);
        if (!hash) continue; // 哈希失败的文件不参与分组
        const bucket = byHash.get(hash);
        if (bucket) bucket.push(file);
        else byHash.set(hash, [file]);
      }
      for (const [hash, group] of byHash) {
        if (group.length < 2) continue;
        if (input.isSuppressed?.(hash)) {
          skippedSuppressed++;
          input.onSuppressed?.(hash);
          continue;
        }
        const entries = group
          .map((file) => toEntry(file, hash, { partialHash: partial.hashes.get(file.absPath) }))
          .sort((a, b) => posixCompare(a.absPath, b.absPath));
        identicalGroups.push(
          buildGroup('identical', groupId('identical', hash), hash.slice(0, 8), hash, entries),
        );
      }
    }

    // ---- 汇总：疑似重复组（大文件未做全量校验）----
    for (const bucket of suspectedBuckets) {
      const entries = bucket.members
        .map((file) => toEntry(file, bucket.partialHash, { partialHash: bucket.partialHash, suspected: true }))
        .sort((a, b) => posixCompare(a.absPath, b.absPath));
      if (input.isSuppressed?.(bucket.partialHash)) {
        skippedSuppressed++;
        input.onSuppressed?.(bucket.partialHash);
        continue;
      }
      suspectedGroups.push(
        buildGroup(
          'suspected',
          groupId('suspected', bucket.partialHash),
          bucket.partialHash.slice(0, 8),
          bucket.partialHash,
          entries,
        ),
      );
    }

    // ---- 汇总：同名不同内容组 ----
    const nameEntries: DupFileEntry[] = [];
    for (const bucket of nameBuckets.values()) {
      if (bucket.length < 2) continue;
      for (const file of bucket) {
        const hash = full.hashes.get(file.absPath) ?? partial.hashes.get(file.absPath);
        if (!hash) continue; // 判定失败的文件无法证明「内容不同」
        nameEntries.push(toEntry(file, hash, { partialHash: partial.hashes.get(file.absPath) }));
      }
    }
    const nameConflictGroups = groupNameConflicts(nameEntries);

    identicalGroups.sort((a, b) => b.reclaimableBytes - a.reclaimableBytes || posixCompare(a.id, b.id));
    suspectedGroups.sort((a, b) => b.reclaimableBytes - a.reclaimableBytes || posixCompare(a.id, b.id));

    return {
      identicalGroups,
      suspectedGroups,
      nameConflictGroups,
      failures,
      skippedSuppressed,
      partialHashedFiles,
      hashedFiles,
      bytesRead,
      cancelled: false,
    };
  } catch (err) {
    if (err instanceof DetectCancelled) {
      cancelled = true;
    } else {
      throw err;
    }
    return {
      identicalGroups,
      suspectedGroups,
      nameConflictGroups: [],
      failures,
      skippedSuppressed,
      partialHashedFiles,
      hashedFiles,
      bytesRead,
      cancelled,
    };
  }
}
