import path from 'node:path';
import { hashFilesDetailed, hashConcurrency } from '../hash';
import type { ScannedFile, ScannedTree } from '../scan';
import type { Manifest } from '../manifest';
import type {
  DupBasis,
  DupCopy,
  DupExclusionEntry,
  DupFailure,
  DupGroup,
  DupSide,
} from '../../../shared/dup-types';

/** 渲染层预览的分组上限；截断只影响呈现，统计始终基于全量 */
export const MAX_PREVIEW_GROUPS = 2000;
/** 单组内保留的副本上限，防止零字节组把 IPC 打爆 */
export const MAX_COPIES_PER_GROUP = 200;

export interface DetectInput {
  sourceRoot: string;
  targetRoot: string;
  source: ScannedTree;
  target: ScannedTree;
  manifest: Manifest | null;
  /** 源端排除记录：relPath -> 排除时的哈希与元数据 */
  exclusions?: Record<string, DupExclusionEntry>;
  onProgress?: (stage: string, done: number, total: number) => void;
  isCancelled?: () => boolean;
}

export interface DetectResult {
  groups: DupGroup[];
  failures: DupFailure[];
  /** 实际参与哈希计算的文件数 */
  hashedFiles: number;
  /** 参与判定的文件数 */
  scannedFiles: number;
  cancelled: boolean;
}

/** 一个物理文件（源端或目标端各自独立） */
interface Physical {
  side: DupSide;
  relPath: string;
  size: number;
  mtimeMs: number;
  absPath: string;
}

/** 一个逻辑文件：相对路径相同的源端与目标端文件合并为一条 */
interface Logical {
  relPath: string;
  source?: ScannedFile;
  target?: ScannedFile;
  hash?: string;
  basis?: DupBasis;
}

const HASH_BATCH = 256;

function posixCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 判定已知哈希是否可以安全复用。
 *
 * 源端与目标端的规则**刻意不同**：
 * - 目标端：manifest 记录的就是目标文件的 size/mtime 与其内容哈希，两者同时吻合即可复用。
 * - 源端：**绝不复用 manifest 的哈希**。清单里的 mtime 是目标端落盘时间，
 *   不是源端修改时间，拿它冒充源端当前哈希会让「同尺寸原地改动」漏判。
 *   源端只复用排除记录里的历史值——那才是源端自己的 mtime。
 */
function reusableHash(
  file: ScannedFile,
  side: DupSide,
  manifest: Manifest | null,
  exclusions: Record<string, DupExclusionEntry>,
): { hash: string; basis: DupBasis } | undefined {
  if (side === 'target') {
    const memo = manifest?.files?.[file.relPath];
    if (memo && memo.sha256 && memo.size === file.size && memo.mtimeMs === file.mtimeMs) {
      return { hash: memo.sha256, basis: 'manifest' };
    }
    return undefined;
  }
  const memo = exclusions[file.relPath];
  if (memo && memo.hash && memo.size === file.size && memo.mtimeMs === file.mtimeMs) {
    return { hash: memo.hash, basis: 'exclusion' };
  }
  return undefined;
}

export async function detectDuplicates(input: DetectInput): Promise<DetectResult> {
  const report = input.onProgress ?? (() => {});
  const exclusions = input.exclusions ?? {};
  const cancelled = () => input.isCancelled?.() === true;

  // ---- 建立物理文件清单 ----
  const physical: Physical[] = [];
  for (const file of input.source.files.values()) {
    physical.push({
      side: 'source',
      relPath: file.relPath,
      size: file.size,
      mtimeMs: file.mtimeMs,
      absPath: path.join(input.sourceRoot, file.relPath),
    });
  }
  for (const file of input.target.files.values()) {
    physical.push({
      side: 'target',
      relPath: file.relPath,
      size: file.size,
      mtimeMs: file.mtimeMs,
      absPath: path.join(input.targetRoot, file.relPath),
    });
  }

  // ---- 第一阶段：按 size 分桶 ----
  // 大多数目录里绝大多数文件 size 唯一，这一刀把哈希成本压到最低。
  report('分桶', 0, physical.length);
  const buckets = new Map<number, Physical[]>();
  for (const file of physical) {
    const bucket = buckets.get(file.size);
    if (bucket) bucket.push(file);
    else buckets.set(file.size, [file]);
  }

  const candidates: Physical[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length >= 2) candidates.push(...bucket);
  }

  // ---- 第二阶段：只对候选计算哈希 ----
  const known = new Map<string, { hash: string; basis: DupBasis }>();
  const pending: { key: string; path: string }[] = [];
  const keyOf = (file: Physical) => `${file.side}\u0000${file.relPath}`;

  for (const file of candidates) {
    const scanned = file.side === 'source' ? input.source.files.get(file.relPath) : input.target.files.get(file.relPath);
    if (!scanned) continue;
    const reused = reusableHash(scanned, file.side, input.manifest, exclusions);
    if (reused) known.set(keyOf(file), reused);
    else pending.push({ key: keyOf(file), path: file.absPath });
  }

  const hashes = new Map<string, string>();
  const failures: DupFailure[] = [];
  let hashedFiles = 0;
  let done = 0;

  for (let i = 0; i < pending.length; i += HASH_BATCH) {
    if (cancelled()) {
      return { groups: [], failures, hashedFiles, scannedFiles: physical.length, cancelled: true };
    }
    const batch = pending.slice(i, i + HASH_BATCH);
    const result = await hashFilesDetailed(batch, hashConcurrency(), (batchDone, batchTotal) => {
      done += batchDone;
      report('计算哈希', done, pending.length);
      void batchTotal;
    });
    for (const [key, hash] of result.hashes) hashes.set(key, hash);
    for (const [key, reason] of result.errors) {
      const [side, relPath] = key.split('\u0000');
      failures.push({ relPath, side: side === 'source' ? 'source' : 'target', reason });
    }
    hashedFiles += batch.length;
  }

  // ---- 按哈希分组 ----
  // resolved 记录每个候选的哈希与其来源（实算 / 清单复用 / 排除记录复用），
  // 报告里要如实区分，不能把复用来的哈希说成实算。
  const resolved = new Map<string, { hash: string; basis: DupBasis }>();
  for (const [key, value] of known) resolved.set(key, value);
  for (const [key, hash] of hashes) {
    if (!resolved.has(key)) resolved.set(key, { hash, basis: 'computed' });
  }

  const byHash = new Map<string, Physical[]>();
  for (const file of candidates) {
    const value = resolved.get(keyOf(file));
    if (!value) continue;
    const bucket = byHash.get(value.hash);
    if (bucket) bucket.push(file);
    else byHash.set(value.hash, [file]);
  }

  const groups: DupGroup[] = [];
  for (const [hash, members] of byHash) {
    // 同一相对路径的源端与目标端文件内容相同 → 它们是同一份数据的两个副本，
    // 合并成一条逻辑副本。合并后只剩一条就不是重复，不应出现在报告里。
    const byRel = new Map<string, Physical[]>();
    for (const member of members) {
      const list = byRel.get(member.relPath);
      if (list) list.push(member);
      else byRel.set(member.relPath, [member]);
    }
    if (byRel.size < 2) continue;

    const copies: DupCopy[] = [];
    const logical: Logical[] = [];
    for (const [relPath, list] of byRel) {
      const source = list.find((x) => x.side === 'source');
      const target = list.find((x) => x.side === 'target');
      // 判定依据取该副本哈希的来源；同一逻辑副本的源/目标两侧都参与判定
      const basis: DupBasis = resolved.get(keyOf(list[0]))?.basis ?? 'computed';
      const copy: DupCopy = {
        relPath,
        side: source && target ? 'both' : source ? 'source' : 'target',
        size: (source ?? target)!.size,
        mtimeMs: (source ?? target)!.mtimeMs,
        basis,
      };
      const sourceScanned = source ? input.source.files.get(relPath) : undefined;
      const targetScanned = target ? input.target.files.get(relPath) : undefined;
      const inodes = new Set<number>();
      if (sourceScanned?.ino !== undefined) inodes.add(sourceScanned.ino);
      if (targetScanned?.ino !== undefined) inodes.add(targetScanned.ino);
      if (inodes.size === 1) copy.inode = String([...inodes][0]);
      copies.push(copy);
      logical.push({ relPath, source: sourceScanned, target: targetScanned, hash });
    }

    copies.sort((a, b) => posixCompare(a.relPath, b.relPath));
    logical.sort((a, b) => posixCompare(a.relPath, b.relPath));

    // 关系类型：存在「仅目标端」的副本即为跨端重复，否则全部副本都在源端。
    const hasTargetOnly = copies.some((c) => c.side === 'target');
    const relation: DupGroup['relation'] = hasTargetOnly ? 'cross-side' : 'source-internal';

    // 规范副本以源端目录结构为准：源端副本中相对路径字典序最小者。
    const sourceCopies = logical.filter((entry) => entry.source);
    const canonical = sourceCopies.length ? sourceCopies[0].relPath : undefined;
    const redundantCopies: DupCopy[] = [];
    for (const entry of sourceCopies.slice(1)) {
      const member = byRel.get(entry.relPath)?.find((x) => x.side === 'source');
      redundantCopies.push({
        relPath: entry.relPath,
        side: 'source',
        size: entry.source?.size ?? 0,
        mtimeMs: entry.source?.mtimeMs ?? 0,
        basis: member ? resolved.get(keyOf(member))?.basis ?? 'computed' : 'computed',
        inode: entry.source?.ino !== undefined ? String(entry.source.ino) : undefined,
      });
    }

    // 硬链接：源端多个副本指向同一 inode，删其一不影响其他，互相排除会反而多出一份副本。
    const inodeCounts = new Map<string, number>();
    for (const entry of sourceCopies) {
      const inode = entry.source?.ino;
      if (inode === undefined) continue;
      inodeCounts.set(String(inode), (inodeCounts.get(String(inode)) ?? 0) + 1);
    }
    const hardLinked = [...inodeCounts.values()].some((n) => n > 1);

    const size = copies[0]?.size ?? 0;
    const zeroByte = size === 0;
    const reclaimableBytes = redundantCopies.reduce((sum, copy) => sum + copy.size, 0);
    const copiesTruncated = copies.length > MAX_COPIES_PER_GROUP;

    groups.push({
      hash,
      size,
      copies: copiesTruncated ? copies.slice(0, MAX_COPIES_PER_GROUP) : copies,
      relation,
      canonical,
      redundant: redundantCopies,
      reclaimableBytes,
      zeroByte,
      hardLinked,
      adoptable: redundantCopies.length > 0 && !zeroByte && !hardLinked,
      copiesTruncated,
    });
  }

  // 排序：可回收字节降序，同值按哈希字典序，保证跨次扫描结果稳定可比。
  groups.sort((a, b) => {
    if (b.reclaimableBytes !== a.reclaimableBytes) return b.reclaimableBytes - a.reclaimableBytes;
    return posixCompare(a.hash, b.hash);
  });

  report('分桶', physical.length, physical.length);
  return { groups, failures, hashedFiles, scannedFiles: physical.length, cancelled: false };
}
