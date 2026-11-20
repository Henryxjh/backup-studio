import path from 'node:path';
import { promises as fs, constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { scanTree, type ScannedTree } from '../scan';
import { hashFile } from '../hash';
import type { AutoChange, AutoCommit, AutoEvent, AutoPair, AutoRecycleEntry, AutoVersion } from '../../../shared/aut-types';
import { checkRoot, exclusion, safePath, statMaybe } from './config';
import { copyAtomic, fault, stamp, type Gate } from './copy';
import { ensureRoom, recyclePath } from './recycle';
import { PairLedger, recycleView, writeVersion } from './history';
import type { WritePermit } from './permit';

export interface IndexEntry { rel: string; source?: string; target: string; hash: string; size?: number; restored?: boolean }

export interface PublishState { key: string; rel: string; source: string; hash: string }

export interface SyncContext {
  pair: AutoPair;
  permit: WritePermit;
  gate: Gate;
  save: Gate;
  event: (action: AutoEvent['action'], detail?: string) => void;
  ledger: PairLedger;
  index: Record<string, IndexEntry>;
  history: { commits: AutoCommit[]; versions: AutoVersion[] };
  /** 迁移过来的旧版回收项（内容在旧版回收路径里）。 */
  legacyRecycle: AutoRecycleEntry[];
  /** 上次同步未完成发布的文件（崩溃恢复用）——由调用方持久化。 */
  getPublish: () => PublishState | undefined;
  setPublish: (value: PublishState | undefined) => Promise<void>;
  /** 会话基线：本次软件运行期间观察到的源端文件集合。 */
  baseline: Set<string>;
  session: { deletes: number; unmanaged: number; counted: Set<string> };
}

export const keyFor = (rel: string) => Buffer.from(process.platform === 'win32' ? rel.toLowerCase() : rel).toString('base64url');
const token = (s: string) => createHash('sha256').update(s).digest('hex');
const pause = (message: string) => fault('CONFLICT', message);

async function snapshot(root: string, tree: ScannedTree) {
  const files = new Map<string, { rel: string; abs: string; stamp: string; size: number }>();
  const dirs = new Map(tree.dirs.map(rel => [keyFor(rel), rel]));
  if (dirs.size !== tree.dirs.length) throw pause('目录名称冲突');
  for (const [rel] of tree.files) {
    const abs = await safePath(root, rel);
    const s = await fs.lstat(abs);
    const key = keyFor(rel);
    if (!s.isFile() || s.isSymbolicLink() || files.has(key) || dirs.has(key)) throw pause('路径类型或名称冲突');
    files.set(key, { rel, abs, stamp: stamp(s), size: s.size });
  }
  return { files, dirs };
}

/**
 * 把即将被删除/替换的旧内容存进介质对象库并登记版本。
 *
 * 顺序固定：先落对象库，再登记版本，最后才允许改动备份端文件——
 * 中途崩溃只会留下「多余的一份旧内容」，不会丢数据。
 */
export async function captureVersion(options: {
  pair: AutoPair;
  ledger: PairLedger;
  history: { versions: AutoVersion[] };
  gate: Gate;
  rel: string;
  abs: string;
  kind: 'delete' | 'replace';
  commitId?: string;
}): Promise<AutoVersion> {
  const { pair, ledger, history, gate, rel, abs, kind } = options;
  const commitId = options.commitId ?? randomUUID();
  const hash = await hashFile(abs);
  const stat = await fs.lstat(abs);
  await ledger.storeObject(hash, abs, gate);
  const previous = history.versions.filter(v => v.relPath === rel).sort((a, b) => b.at - a.at)[0];
  const version: AutoVersion = {
    id: randomUUID(),
    pairId: pair.id,
    relPath: rel,
    hash,
    size: stat.size,
    at: Date.now(),
    commitId,
    kind,
    ...(previous ? { previousId: previous.id } : {}),
  };
  await writeVersion(ledger, history, version, gate);
  return version;
}

async function capture(ctx: SyncContext, rel: string, abs: string, kind: 'delete' | 'replace', commitId: string): Promise<AutoVersion> {
  return captureVersion({ pair: ctx.pair, ledger: ctx.ledger, history: ctx.history, gate: ctx.gate, rel, abs, kind, commitId });
}

/** 旧版回收事务的收尾（迁移过来的状态才会出现 pending 项）。 */
async function settleLegacy(ctx: SyncContext): Promise<void> {
  for (const row of ctx.legacyRecycle.filter(x => x.pending)) {
    const file = await statMaybe(await recyclePath(ctx.pair, row.id));
    const old = await statMaybe(await safePath(ctx.pair.targetRoot, row.relPath));
    if (file?.isFile() && file.size === row.size && (row.kind === 'replace' || !old)) {
      row.pending = false;
      if (row.kind === 'delete') delete ctx.index[keyFor(row.relPath)];
    } else if (!file && old?.isFile()) {
      if (row.kind === 'replace') {
        const partial = await safePath(ctx.pair.targetRoot, `.backup-studio/aut-recycle/${ctx.pair.id}/.aut-part-${row.id}`);
        const s = await statMaybe(partial);
        // 现场原件仍在：只丢弃未完成的暂存副本。
        if (s) {
          if (!s.isFile() || s.nlink !== 1) throw pause('回收临时文件类型异常');
          await ctx.gate(); await fs.unlink(partial);
        }
      }
      ctx.legacyRecycle.splice(ctx.legacyRecycle.indexOf(row), 1);
    } else throw pause('回收事务需要人工核对');
    await ctx.save();
  }
}

export async function reconcile(ctx: SyncContext, syncing: () => void): Promise<void> {
  const { pair } = ctx;
  await checkRoot(pair.sourceRoot);
  await checkRoot(pair.targetRoot, constants.R_OK | constants.W_OK);
  const exclude = exclusion(pair);
  const [st, tt] = await Promise.all([scanTree(pair.sourceRoot, { exclude }), scanTree(pair.targetRoot, { exclude })]);
  if (st.errors.length || tt.errors.length) throw fault('SCAN_INCOMPLETE', '扫描不完整，已阻止同步');
  const [s, t] = await Promise.all([snapshot(pair.sourceRoot, st), snapshot(pair.targetRoot, tt)]);
  await ctx.gate();

  await settleLegacy(ctx);

  // 会话基线：本次观察到的源端文件进入基线。
  // 只有「基线中存在、之后消失」的条目才是软件运行期间发生的受管删除。
  for (const key of s.files.keys()) ctx.baseline.add(key);

  if (ctx.getPublish()) {
    const p = ctx.getPublish()!;
    const dest = t.files.get(p.key);
    if (dest && await hashFile(dest.abs) === p.hash) ctx.index[p.key] = { rel: dest.rel, source: p.source, target: dest.stamp, hash: p.hash, size: dest.size };
    await ctx.setPublish(undefined);
  }

  const commitId = randomUUID();
  const changes: AutoChange[] = [];
  const copies: { key: string; replace: boolean }[] = [];
  const deletes: { key: string; rel: string }[] = [];

  for (const key of new Set([...s.files.keys(), ...t.files.keys(), ...Object.keys(ctx.index)])) {
    const src = s.files.get(key), dest = t.files.get(key), old = ctx.index[key];
    if (exclude(src?.rel ?? dest?.rel ?? old.rel)) continue;
    if ((src && t.dirs.has(key)) || (dest && s.dirs.has(key))) throw pause('源目录与备份目录的条目类型冲突');
    let external = Boolean(old ? !dest || dest.stamp !== old.target : dest);
    if (dest && external && old && await hashFile(dest.abs) === old.hash) {
      old.target = dest.stamp;
      external = false;
    }
    if (src && dest && (!old || external) && src.size === dest.size) {
      const [a, b] = await Promise.all([hashFile(src.abs), hashFile(dest.abs)]);
      if (a === b && stamp(await fs.lstat(src.abs)) === src.stamp && stamp(await fs.lstat(dest.abs)) === dest.stamp) {
        ctx.index[key] = { rel: dest.rel, source: src.stamp, target: dest.stamp, hash: a, size: dest.size };
        continue;
      }
    }
    if (external && (pair.externalChanges === 'pause' || (!src && !!dest))) throw pause('检测到备份目录外部修改，请核对后重新对账');
    if (external) ctx.event('外部修改已告警', '按已选覆盖策略处理');
    if (src && (!dest || src.stamp !== old?.source)) copies.push({ key, replace: !!dest });
    else if (src && external) copies.push({ key, replace: !!dest });
    else if (!src && dest && old && !old.restored) {
      if (ctx.baseline.has(key)) {
        // 软件运行期间发生的删除：受管同步，进回收站，可撤回。
        if (pair.syncDeletes) deletes.push({ key, rel: dest.rel });
      } else if (!ctx.session.counted.has(key)) {
        // 软件未运行期间发生的删除：不归软件管——备份端保留，不进回收站，不产生删除事件。
        ctx.session.counted.add(key);
        ctx.session.unmanaged++;
      }
    }
  }
  if (deletes.length && (!s.files.size || deletes.length > Math.max(100, s.files.size) || deletes.length / Math.max(1, t.files.size) > 0.3 || st.skippedSymlinks > 0)) {
    throw fault('DELETE_RISK', '批量删除风险闸门已阻止操作；请保留备份并人工核对');
  }
  ctx.event('对账完成', `待复制 ${copies.length}，待回收 ${deletes.length}`);
  await ctx.save();
  syncing();

  for (const [key, rel] of s.dirs) {
    if (t.dirs.has(key)) continue;
    const dir = await safePath(pair.targetRoot, rel);
    await ctx.gate(); await fs.mkdir(dir, { recursive: true });
  }

  for (const { key, replace } of copies) {
    const src = s.files.get(key)!;
    const seen = t.files.get(key);
    const rel = seen?.rel ?? src.rel;
    const dest = await safePath(pair.targetRoot, rel);
    const parent = path.posix.dirname(rel);
    const partRel = `${parent === '.' ? '' : `${parent}/`}.aut-part-${token(pair.id + ':' + key)}`;
    const part = await safePath(pair.targetRoot, partRel);
    const verifyDest = async () => {
      const fresh = await statMaybe(await safePath(pair.targetRoot, rel));
      if ((fresh && stamp(fresh)) !== seen?.stamp) throw pause('备份文件在对账后被修改');
    };
    if (replace && seen) {
      await verifyDest();
      // 覆盖前先把旧内容存进介质对象库并登记 replace 版本。
      const version = await capture(ctx, rel, dest, 'replace', commitId);
      changes.push({ relPath: rel, kind: 'replace', hash: version.hash, size: version.size, versionId: version.id });
    }
    const hash = await copyAtomic(src.abs, dest, part, pair.stableMs, ctx.gate, async hash => {
      await verifyDest();
      if (stamp(await fs.lstat(src.abs)) !== src.stamp) throw fault('UNSTABLE', '源文件在对账后被修改');
      await ctx.setPublish({ key, rel, source: src.stamp, hash });
    });
    ctx.index[key] = { rel, source: src.stamp, target: stamp(await fs.lstat(dest)), hash, size: src.size };
    await ctx.setPublish(undefined);
    const previous = ctx.history.versions.filter(v => v.relPath === rel).sort((a, b) => b.at - a.at)[0];
    const version: AutoVersion = {
      id: randomUUID(),
      pairId: pair.id,
      relPath: rel,
      hash,
      size: src.size,
      at: Date.now(),
      commitId,
      kind: replace ? 'modify' : 'add',
      ...(previous ? { previousId: previous.id } : {}),
    };
    await writeVersion(ctx.ledger, ctx.history, version, ctx.gate);
    changes.push({ relPath: rel, kind: replace ? 'modify' : 'add', hash, size: src.size, versionId: version.id });
    ctx.event('已原子复制'); await ctx.save();
  }

  for (const { key, rel } of deletes) {
    const item = t.files.get(key)!;
    const abs = item.abs;
    if (await statMaybe(await safePath(pair.sourceRoot, ctx.index[key].rel))) throw fault('UNSTABLE', '删除前源条目重新出现');
    const before = await fs.lstat(abs);
    // 先落对象库并登记版本，再删除备份端文件。
    const version = await capture(ctx, rel, abs, 'delete', commitId);
    const view = recycleView(pair, ctx.history.versions, ctx.legacyRecycle);
    await ensureRoom(pair, view, before.size, ctx.permit, ctx.gate, ctx.save, Date.now(), async entry => {
      // 回收项到期：从历史中淘汰对应版本（介质墓碑记录，对象内容留到容量清理阶段再删）。
      const target = ctx.history.versions.find(v => v.id === entry.versionId);
      if (!target) return;
      ctx.history.versions = ctx.history.versions.filter(v => v.id !== target.id);
      await ctx.ledger.appendTombstone('v', target.id, ctx.gate);
    });
    if (stamp(await fs.lstat(abs)) !== stamp(before)) throw fault('CONFLICT', '备份文件已变更');
    await ctx.gate(); await fs.unlink(abs);
    delete ctx.index[key];
    ctx.session.deletes++;
    changes.push({ relPath: rel, kind: 'delete', hash: version.hash, size: version.size, versionId: version.id });
    ctx.event('已移动到回收站'); await ctx.save();
  }

  if (changes.length) {
    const commit: AutoCommit = { id: commitId, pairId: pair.id, at: Date.now(), changes };
    await ctx.ledger.appendCommit(commit, ctx.gate);
    ctx.history.commits.push(commit);
  }
}
