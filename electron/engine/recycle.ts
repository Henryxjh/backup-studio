import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import type { RecycleBin, RecycleEntry } from '../../shared/types';
import { hashFile } from './hash';
import type { DeleteTx } from './journal';
import { createDurableDirectory, historyDir, metaDir, syncDirectory, syncFile, writeJsonAtomic } from './manifest';
import { CASE_INSENSITIVE_PATHS, normalizePath, realpathIfExists } from './path-identity';

/**
 * 手动备份回收站。
 *
 * 实体内容由事务归档提供（`.backup-studio/history/<jobId>/<relPath>`），
 * 这里维护一份可浏览、可还原的索引：条目登记、还原、彻底删除。
 *
 * 崩溃一致性约定：
 * - 索引条目按 `txId` 幂等去重，同一删除事务重复提交不会产生第二条；
 * - 索引缺失不等于回收站为空：存在活跃删除账本时必须报「不一致」；
 * - 还原与彻底删除都是两阶段：先写操作意图，再动文件，最后提交索引；
 *   中途失败保留证据，绝不把唯一的悬空证据静默抹掉。
 */

type Entry = RecycleEntry & { operation?: 'restore' | 'remove'; operationHash?: string };

interface RecycleIndex {
  version: 1;
  entries: Entry[];
  /** 曾经贡献过回收实体的任务 id：用于对账扫描孤儿实体 */
  jobs?: string[];
}

/** 手动回收站默认容量上限：与自动备份 `aut/config.ts` 的 `recycleMaxBytes` 同口径（10 GiB）。 */
export const DEFAULT_RECYCLE_MAX_BYTES = 10 * 1024 ** 3;

/** 索引落盘位置（目标端 `.backup-studio/recycle/index.json`）。 */
export function recycleIndexPath(targetRoot: string): string {
  return path.join(metaDir(targetRoot), 'recycle', 'index.json');
}

function nativePath(root: string, relPath: string): string {
  const parts = relPath.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || /[\\:\0]/.test(p))) throw new Error('回收项路径无效');
  return path.join(root, ...parts);
}

/** 归档副本的物理位置。 */
export function archivePath(root: string, entry: RecycleEntry): string {
  if (!/^[\w-]+$/.test(entry.jobId)) throw new Error('回收项任务标识无效');
  return nativePath(historyDir(root), `${entry.jobId}/${entry.relPath}`);
}

function ignoreMissing(err: NodeJS.ErrnoException): undefined {
  if (err.code !== 'ENOENT') throw err;
}

async function readIndex(root: string): Promise<RecycleIndex | undefined> {
  const raw = await fs.readFile(recycleIndexPath(root), 'utf8').catch(ignoreMissing);
  if (raw === undefined) return undefined;
  try {
    const index = JSON.parse(raw) as RecycleIndex;
    if (index?.version !== 1 || !Array.isArray(index.entries)) throw new Error('格式无效');
    const ids = new Set<string>();
    const files = new Set<string>();
    for (const entry of index.entries) {
      if (typeof entry?.id !== 'string' || typeof entry.relPath !== 'string' ||
          typeof entry.size !== 'number' || typeof entry.deletedAt !== 'number' ||
          typeof entry.jobId !== 'string' ||
          (entry.txId !== undefined && typeof entry.txId !== 'string')) throw new Error('条目无效');
      const file = archivePath(root, entry);
      const id = entry.txId ?? entry.id;
      if (ids.has(id) || files.has(file)) throw new Error('重复条目');
      ids.add(id);
      files.add(file);
    }
    return { version: 1, entries: index.entries, jobs: index.jobs ?? [] };
  } catch (err) {
    throw Object.assign(new Error('回收站索引损坏', { cause: err }), { code: 'RECYCLE_INDEX_CORRUPT' });
  }
}

async function writeIndex(root: string, index: RecycleIndex): Promise<void> {
  await writeJsonAtomic(recycleIndexPath(root), index);
}

async function historyFiles(dir: string, files = new Map<string, Stats>()): Promise<Map<string, Stats>> {
  const stat = await fs.lstat(dir).catch(ignoreMissing);
  if (!stat) return files;
  if (stat.isDirectory()) {
    for (const name of await fs.readdir(dir)) await historyFiles(path.join(dir, name), files);
  } else if (stat.isFile()) files.set(dir, stat);
  else throw new Error(`历史目录包含非普通文件：${dir}`);
  return files;
}

/**
 * 归档实体的唯一键。
 *
 * 同一个物理文件无论路径大小写怎么写、无论是被索引引用还是被未决事务占用，
 * 都必须落到同一个键上。否则容量闸门会把同一份内容算两遍（既算已索引、
 * 又算孤儿），把合法备份误判成超限。
 *
 * 判定依据是**磁盘真实身份**而不是路径字符串：
 * - 优先用 inode + 设备号：改名不改 inode，判定最精确，也不会把
 *   大小写敏感卷上两个真实不同的文件（`Foo` 与 `foo`）混成一份；
 * - inode 不可用时退回 realpath；
 * - 再退回按平台大小写规则归一的路径（此时同一份文件的两种写法仍能对上）。
 */
function entityKey(file: string, stat: Stats): string {
  if (stat.ino !== 0 && stat.dev !== 0) return `id:${stat.dev}:${stat.ino}`;
  const real = realpathIfExists(file);
  if (real) return `real:${CASE_INSENSITIVE_PATHS ? real.toLowerCase() : real}`;
  return `path:${CASE_INSENSITIVE_PATHS ? normalizePath(file).toLowerCase() : normalizePath(file)}`;
}

function txEntry(tx: DeleteTx): RecycleEntry {
  return {
    id: tx.txId,
    txId: tx.txId,
    jobId: tx.jobId,
    relPath: tx.relPath,
    size: tx.size,
    archiveRelPath: tx.archiveRelPath,
    archiveSize: tx.archiveSize,
    archiveSha256: tx.archiveSha256,
    // 「有没有哈希基线」与「校验有没有通过」必须分开表达：
    // 有基线但校验失败，绝不能被说成「没有基线」。
    hashBaseline: Boolean(tx.archiveSha256),
    contentVerified: tx.state !== 'planned' && Boolean(tx.archiveSha256),
    contentState: tx.state !== 'planned' && tx.archiveSha256 ? 'verified' : tx.archiveSha256 ? 'unverified' : 'unknown',
    deletedAt: tx.updatedAt,
    state: 'indexed',
    entityState: 'present',
  };
}

/**
 * 这条删除事务是否应当出现在回收站索引里。
 *
 * 只有「删除确实发生了」的账本条目才是可还原的回收项：
 * - `original-deleted` / `indexed`：删除已完成或已完成登记；
 * - `committed`：删除已提交，索引条目本就应该存在——索引丢失后必须据此重建，
 *   否则用户删除的文件会变成「看不见也还原不了」的孤儿归档。
 * - `voided`（恢复时发现原文件仍在，删除被取消）：归档是多余的待清理实体，
 *   刻意不登记为可还原条目。
 * - `settled`（用户已还原或已彻底删除）：条目已经处理过，不得复活。
 * - `uncertain`（需人工核对）：不得登记为可还原条目，但归档若仍损坏，
 *   重建时必须继续作为损坏证据报出来（见 `initializeRecycle`）。
 */
function isRecyclableTx(tx: DeleteTx): boolean {
  if (tx.voided || tx.settled) return false;
  return tx.state === 'original-deleted' || tx.state === 'indexed' || tx.state === 'committed';
}

/**
 * 准备回收索引。
 *
 * 索引不存在时：没有账本也没有实体 → 建空索引；存在删除账本 → 按账本重建，
 * 绝不把「索引缺失」当成空回收站。
 *
 * 重建时按 txId 幂等：同一删除事务不会产生第二条。哈希基线存在时必须校验内容，
 * 校验不过的归档不进索引（否则用户会看到一个还原必定失败的条目），
 * 但要作为 `damaged` 返回——证据必须留给人工核对，不能静默降级成「无此条目」。
 *
 * **账本证据必须先于索引发布**。
 * 索引一旦发布，重建就不会再跑：崩溃落在「索引已发布、账本还没标 uncertain」
 * 这个窗口里时，损坏的事务会从回收站列表里彻底消失，用户只看到「孤儿占用」。
 * 因此提供 `persistUncertain` 回调时，损坏条目逐条**先**落账本（标 `uncertain`），
 * **再**发布重建后的索引；回调抛错则整个重建失败，**索引不发布**。
 *
 * 不提供回调时保留原有行为（只返回 `damaged[]`），此时**由调用方负责落账本**，
 * 且必须在索引发布之前完成落账本，否则同样会永久漏标损坏证据。
 */
export async function initializeRecycle(
  root: string,
  txs: DeleteTx[],
  persistUncertain?: (tx: DeleteTx, reason: string) => Promise<void>,
): Promise<DeleteTx[]> {
  const existing = await readIndex(root);
  if (existing) return [];
  const entries: Entry[] = [];
  const jobs = new Set<string>();
  const damaged: DeleteTx[] = [];
  for (const tx of txs) {
    if (tx.voided || tx.settled) continue;
    const recyclable = isRecyclableTx(tx);
    // 已经标成待核对的删除事务：归档若仍然损坏，要继续作为损坏证据报出来，
    // 否则重建一次之后损坏就从 damaged 列表里消失了。
    if (!recyclable && tx.state !== 'uncertain') continue;
    const file = archivePath(root, txEntry(tx));
    const stat = await fs.lstat(file).catch(ignoreMissing);
    const missing = !stat?.isFile() || stat.size !== (tx.archiveSize ?? tx.size);
    const mismatched = !missing && Boolean(tx.archiveSha256) && (await hashFile(file)) !== tx.archiveSha256;
    if (missing || mismatched) {
      damaged.push(tx);
      // 账本证据先落定：回调抛错时索引不发布，损坏证据不会被永久漏标。
      await persistUncertain?.(tx, missing ? '归档副本缺失或大小不符，需人工核对' : '归档内容校验失败，需人工核对');
      continue;
    }
    if (!recyclable) continue;
    entries.push(txEntry(tx));
    jobs.add(tx.jobId);
  }
  await writeIndex(root, { version: 1, entries, jobs: [...jobs] });
  return damaged;
}

/** 按 txId 幂等提交一条回收索引；重复提交不会产生第二条。 */
export async function commitRecycle(root: string, tx: DeleteTx): Promise<void> {
  // 已结案的删除事务（用户已还原或已彻底删除）不得再被登记回索引：
  // 那会让用户看到一个自己已经处理过的文件。
  if (tx.voided || tx.settled) throw new Error('该删除事务已结案，不得再登记进回收索引');
  const index = await readIndex(root);
  if (!index) throw new Error('回收站索引缺失，需人工核对；没有清理任何归档');
  const previous = index.entries.find((e) => e.txId === tx.txId);
  if (previous) {
    if (previous.jobId !== tx.jobId || previous.relPath !== tx.relPath ||
        previous.archiveSha256 !== tx.archiveSha256 || previous.archiveSize !== tx.archiveSize) {
      throw new Error('回收项与本机账本不一致，需人工核对');
    }
    return;
  }
  const file = archivePath(root, txEntry(tx));
  if (index.entries.some((e) => archivePath(root, e) === file)) throw new Error('归档路径已被其他回收项引用');
  index.entries.push(txEntry(tx));
  index.jobs = [...new Set([...(index.jobs ?? []), tx.jobId])];
  await writeIndex(root, index);
}

/**
 * 回收站快照。
 *
 * 占用口径：**三类互斥**，一份物理实体只落进其中一类。
 * - `usedBytes`：已索引实体实际占用（索引行引用的归档文件）；
 * - `pendingBytes`：活跃删除账本里尚未提交的归档占用 —— 已有归档实体的按实际字节算；
 *   **还没有归档实体的（`planned` 等）按应有字节数（`archiveSize ?? size`）预留**，
 *   否则这些条目完全不进任何口径，实际写入会直接突破上限；
 * - `orphanBytes`：对账扫描到的无索引实体（不得从占用里隐瞒）。
 *
 * 分类依据是**磁盘真实身份**（inode / realpath）而不是路径字符串：
 * 在大小写不敏感的卷上，同一个文件用不同大小写写出来仍是同一份内容，
 * 用字符串比较会让它同时算成「已索引」和「孤儿」，把合法备份误判成超限。
 *
 * `settledTxIds` 是**已结案**（用户已还原或已彻底删除）的删除事务 id 集合：
 * 账本里已结案的条目不得再出现；索引残留行仅在带操作意图、等待收尾时显示。
 */
export async function listRecycle(
  root: string,
  limitBytes = DEFAULT_RECYCLE_MAX_BYTES,
  txs: DeleteTx[] = [],
  settledTxIds?: ReadonlySet<string>,
): Promise<RecycleBin> {
  let index: RecycleIndex | undefined;
  let indexState: NonNullable<RecycleBin['indexState']> = 'ok';
  try {
    index = await readIndex(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'RECYCLE_INDEX_CORRUPT') throw err;
    indexState = 'corrupt';
  }

  /** 已结案的删除事务：账本行隐藏，索引行若有操作意图则保留待收尾证据。 */
  const settledIds = new Set<string>(settledTxIds ?? []);
  for (const tx of txs) if (tx.settled) settledIds.add(tx.txId);

  /** 活跃删除账本：删除尚未完成、可能仍有归档实体的删除事务。 */
  const active = txs.filter((tx) => tx.state !== 'committed' && !tx.voided && !tx.settled);

  const entries: RecycleEntry[] = [];
  /**
   * 物理实体清单：同一份文件只登记一次，也只归入一个类别。
   * - `used`：被索引行引用的归档实体；
   * - `pending`：被未决事务占用、但还没进索引的归档实体。
   */
  const entities = new Map<string, { file: string; size: number; claim: 'used' | 'pending' }>();
  /** 尚未建立归档实体的未决事务：按应有字节数预留容量。 */
  let reservedBytes = 0;

  for (const e of index?.entries ?? []) {
    const txId = e.txId ?? e.id;
    // 结案后的无操作残留行隐藏；有操作意图的索引行仍须等待提交收尾。
    const cleanupPending = settledIds.has(txId) && Boolean(e.operation);
    if (settledIds.has(txId) && !cleanupPending) continue;
    const file = archivePath(root, e);
    const stat = await fs.lstat(file).catch(ignoreMissing);
    const size = stat?.isFile() ? stat.size : undefined;
    if (stat?.isFile()) {
      const key = entityKey(file, stat);
      if (!entities.has(key)) entities.set(key, { file, size: stat.size, claim: 'used' });
    }
    const valid = size !== undefined && size === (e.archiveSize ?? e.size);
    const uncertain = !valid || e.state === 'uncertain';
    const { operation, operationHash, ...rest } = e;
    entries.push({
      ...rest,
      txId,
      archiveRelPath: e.archiveRelPath ?? `${e.jobId}/${e.relPath}`,
      hashBaseline: Boolean(e.archiveSha256),
      // 列表只核对体积，不读完整哈希；有基线也不能声称内容已校验。
      contentVerified: false,
      contentState: uncertain ? 'failed' : e.archiveSha256 ? 'unverified' : 'unknown',
      cleanupPending: cleanupPending || undefined,
      state: cleanupPending ? 'pending' : uncertain ? 'uncertain' : operation ? 'pending' : 'indexed',
      entityState: size === undefined ? 'missing' : uncertain ? 'uncertain' : operation ? 'pending' : 'present',
      error: cleanupPending
        ? operation === 'restore' ? '已还原，但索引提交失败，需重试收尾' : '已彻底删除，但索引提交失败，需重试收尾'
        : e.error ?? (valid ? undefined : '归档实体缺失或大小不符'),
    });
  }

  for (const tx of active) {
    const file = archivePath(root, txEntry(tx));
    const stat = await fs.lstat(file).catch(ignoreMissing);
    const size = stat?.isFile() ? stat.size : undefined;
    const existing = entries.find((e) => e.txId === tx.txId);
    if (existing) {
      // 账本里的异常状态优先：索引行不得把「需人工核对」覆盖成正常条目。
      // 归档在登记之后被换成同大小但内容不同的东西时，对账会把账本标成 uncertain，
      // 列表必须如实呈现，而不是继续显示 indexed / present。
      if (tx.state === 'uncertain') {
        existing.state = 'uncertain';
        existing.entityState = existing.entityState === 'missing' ? 'missing' : 'uncertain';
        existing.contentVerified = false;
        existing.contentState = 'failed';
        existing.error = tx.lastError ?? '删除事务需人工核对';
      }
      continue;
    }
    if (stat?.isFile()) {
      const key = entityKey(file, stat);
      if (!entities.has(key)) entities.set(key, { file, size: stat.size, claim: 'pending' });
    } else {
      // 还没有归档实体（`planned` / 归档尚未落盘）：按应有字节数预留容量。
      // 不预留的话实际写入会直接突破容量上限。
      reservedBytes += Math.max(0, tx.archiveSize ?? tx.size);
    }
    entries.push({
      ...txEntry(tx),
      deletedAt: tx.updatedAt,
      hashBaseline: Boolean(tx.archiveSha256),
      // 有哈希基线 ≠ 已通过校验：被标成需人工核对的条目一律不得声称已校验。
      contentVerified: tx.state !== 'uncertain' && tx.state !== 'planned' && Boolean(tx.archiveSha256),
      contentState: tx.state === 'uncertain' ? 'failed'
        : !tx.archiveSha256 ? 'unknown' : tx.state === 'planned' ? 'unverified' : 'verified',
      state: tx.state === 'uncertain' ? 'uncertain' : 'pending',
      entityState: tx.state === 'uncertain' ? 'uncertain' : size === undefined ? 'missing' : 'pending',
      error: tx.lastError ?? '删除事务未完成，需恢复并核对',
    });
  }

  // 孤儿实体：扫描**全部**历史目录。
  //
  // 早先整目录排除「当前任务」，会把该任务下尚未索引的归档和 `.tmp-` 临时文件
  // 一起藏起来——占用既不计入展示也不计入容量闸门。改为按**文件**排除：
  // 已被索引引用或已被未决事务占用的不算孤儿，其余（含临时文件）一律计入。
  const orphanFiles = new Map<string, Stats>();
  const historyRoot = historyDir(root);
  const jobDirs = (await fs.readdir(historyRoot).catch(ignoreMissing)) ?? [];
  for (const name of jobDirs) {
    if (!/^[\w-]+$/.test(name)) continue;
    const dir = path.join(historyRoot, name);
    const stat = await fs.lstat(dir).catch(ignoreMissing);
    if (!stat?.isDirectory()) continue;
    const files = await historyFiles(dir);
    for (const [file, fileStat] of files) orphanFiles.set(file, fileStat);
  }

  let orphanBytes = 0;
  const countedOrphans = new Set<string>();
  for (const [file, stat] of orphanFiles) {
    // 已被索引行或未决事务认领的实体不是孤儿：
    // 同一份文件不得既算「已索引」又算「孤儿」（否则合法备份会被误判成超限）。
    const key = entityKey(file, stat);
    if (entities.has(key) || countedOrphans.has(key)) continue;
    countedOrphans.add(key);
    orphanBytes += stat.size;
  }

  let usedBytes = 0;
  let pendingBytes = reservedBytes;
  for (const entity of entities.values()) {
    if (entity.claim === 'used') usedBytes += entity.size;
    else pendingBytes += entity.size;
  }

  if (!index && indexState === 'ok' && (active.length > 0 || orphanBytes > 0)) {
    // 索引文件不在，但账本或实体还在：绝不能显示成空回收站。
    indexState = 'missing';
  }

  const uncertainCount = entries.filter((e) => e.state === 'uncertain').length;
  if (indexState === 'ok' && (uncertainCount || entries.some((e) => e.state === 'pending'))) {
    indexState = 'inconsistent';
  }
  // 恰好等于上限必须放行：只有**超过**上限才算超限。
  const overLimit = usedBytes + pendingBytes + orphanBytes > limitBytes;
  const blockedReason = indexState === 'missing' || indexState === 'corrupt'
    ? '回收站索引缺失或损坏，需人工核对'
    : uncertainCount
      ? '回收站有待人工核对的条目'
      : orphanBytes > 0
        ? '存在未被索引的归档实体'
        : overLimit
          ? '回收站实际占用超过容量上限'
          : undefined;

  return {
    targetRoot: root,
    entries: entries.sort((a, b) => b.deletedAt - a.deletedAt),
    totalBytes: usedBytes,
    limitBytes,
    usedBytes,
    pendingBytes,
    orphanBytes,
    overLimit,
    blockedReason,
    indexState,
    uncertainCount,
  };
}

async function verifyArchive(root: string, entry: Entry): Promise<string> {
  const source = archivePath(root, entry);
  const stat = await fs.lstat(source).catch(ignoreMissing);
  if (!stat?.isFile() || stat.size !== (entry.archiveSize ?? entry.size)) {
    throw new Error('归档副本缺失或大小不符，已保留索引证据');
  }
  const sha = await hashFile(source);
  if (entry.archiveSha256 && sha !== entry.archiveSha256) throw new Error('归档校验失败，已保留索引证据');
  return sha;
}

/**
 * 还原回收项：两阶段。
 *
 * 复制 → fsync → 落盘 → 落定账本 → 提交索引移除 → 清理归档。
 *
 * 账本落定（`onPublished`）必须排在**移除索引条目之前**：否则崩溃落在两者之间时，
 * 索引丢失后按账本重建，会把用户已经还原过的条目复活成「可还原」。
 * 索引提交失败时保留归档与条目，并给出可重试的错误；重试是幂等的，
 * 不会因为「目标位置已存在」而误报占用冲突。
 */
export async function restoreRecycle(
  root: string,
  id: string,
  overwrite: boolean,
  onPublished?: (txId: string) => Promise<void>,
): Promise<RecycleBin> {
  const index = await readIndex(root);
  if (!index) throw new Error('回收站索引缺失，需人工核对；没有清理任何归档');
  const entry = index.entries.find((item) => item.id === id);
  if (!entry) throw new Error('回收项不存在或已被处理');
  if (entry.operation === 'remove') throw new Error('回收项有未完成的彻底删除，需人工核对');
  const source = archivePath(root, entry);
  const sha = await verifyArchive(root, entry);
  const dest = nativePath(root, entry.relPath);
  const occupied = await fs.lstat(dest).catch(ignoreMissing);
  const published = entry.operation === 'restore' && entry.operationHash === sha &&
    Boolean(occupied?.isFile()) && (await hashFile(dest)) === sha;
  if (!published) {
    if (occupied && !overwrite) throw new Error('目标位置已被占用，请确认覆盖后再试');
    entry.operation = 'restore';
    entry.operationHash = sha;
    await writeIndex(root, index);
    await createDurableDirectory(path.dirname(dest), path.resolve(root));
    const tmp = `${dest}.restore-${randomUUID()}`;
    try {
      await fs.copyFile(source, tmp, constants.COPYFILE_EXCL);
      await syncFile(tmp);
      if ((await hashFile(tmp)) !== sha) throw new Error('还原副本校验失败');
      if (overwrite) await fs.rename(tmp, dest);
      else {
        await fs.link(tmp, dest);
        await fs.unlink(tmp);
      }
    } catch (err) {
      await fs.unlink(tmp).catch(ignoreMissing);
      throw err;
    }
  }
  await syncDirectory(path.dirname(dest));
  // 账本先落定，再移除索引条目：顺序反了会在崩溃窗口里复活已还原的条目。
  if (onPublished) await onPublished(entry.txId ?? entry.id);
  index.entries = index.entries.filter((item) => item.id !== id);
  try {
    await writeIndex(root, index);
  } catch (err) {
    throw new Error('还原文件和归档均已保留；索引提交失败，请重试还原以完成登记', { cause: err });
  }
  // 索引已提交：归档副本不再被引用，回收空间。
  try {
    await fs.unlink(source);
    await syncDirectory(path.dirname(source)).catch(() => undefined);
  } catch (err) {
    // 索引已提交移除 = 文件**已经**还原到原位置。归档清理失败必须如实报告，
    // 同时把「已还原」这个事实带出去：账本据此落定，索引重建才不会把这个条目复活
    // （归档还在、索引没了的情况下，重建会把它当成一条可还原项）。
    throw Object.assign(
      new Error(`文件已还原，但归档清理失败（需重试清理）：${err instanceof Error ? err.message : String(err)}`, { cause: err }),
      { restoredTxId: entry.txId ?? entry.id },
    );
  }
  return listRecycle(root);
}

/**
 * 彻底删除回收项：两阶段。
 *
 * 写删除意图 → 删除实体 → 核验 → 落定账本 → 提交索引移除。
 * 实体删除失败或索引提交失败都会保留可见证据，不静默抹掉唯一线索。
 *
 * 账本落定（`onRemoved`）排在索引移除之前：否则崩溃落在两者之间时，
 * 索引一丢，这条「用户已经彻底删除」的条目会被按账本重建回来。
 */
export async function removeRecycle(
  root: string,
  id: string,
  onRemoved?: (txId: string) => Promise<void>,
): Promise<RecycleBin> {
  const index = await readIndex(root);
  if (!index) throw new Error('回收站索引缺失，需人工核对；没有清理任何归档');
  const entry = index.entries.find((item) => item.id === id);
  if (!entry) throw new Error('回收项不存在或已被处理');
  if (entry.operation === 'restore') throw new Error('回收项有未完成的还原，请先完成还原');
  const source = archivePath(root, entry);
  await verifyArchive(root, entry);
  entry.operation = 'remove';
  await writeIndex(root, index);
  await fs.unlink(source);
  await syncDirectory(path.dirname(source));
  if (await fs.lstat(source).catch(ignoreMissing)) throw new Error('归档仍存在，彻底删除未完成');
  if (onRemoved) await onRemoved(entry.txId ?? entry.id);
  index.entries = index.entries.filter((item) => item.id !== id);
  try {
    await writeIndex(root, index);
  } catch (err) {
    throw new Error('归档已删除但索引未提交，已保留删除意图，需人工核对', { cause: err });
  }
  return listRecycle(root);
}
