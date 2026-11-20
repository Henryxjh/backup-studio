import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { AutoPair, AutoRecycleEntry } from '../../../shared/aut-types';
import { safePath, statMaybe } from './config';
import { fault, stamp, type Gate } from './copy';
import type { WritePermit } from './permit';

export const recycleBytes = (entries: AutoRecycleEntry[]) => entries.reduce((n, entry) => n + entry.size, 0);

/**
 * 旧版回收文件的物理路径。
 *
 * 新流程的内容保存在介质对象库（`objects/<sha256>`）里；
 * 这个路径只服务两类情况：迁移过来的旧版回收项，以及历史遗留文件。
 */
export function recyclePath(pair: AutoPair, id: string) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('无效回收项');
  return safePath(pair.targetRoot, `.backup-studio/aut-recycle/${pair.id}/${id}`);
}

/**
 * 回收站容量闸门。
 *
 * 超限时按到期优先清理，且**必须**取得逐项清理授权
 * （`permit.canPurge` 会先确认现存备份集完好，避免删掉唯一可恢复内容）。
 * `release` 用于同步淘汰对应的历史版本。
 */
export async function ensureRoom(
  pair: AutoPair,
  entries: AutoRecycleEntry[],
  size: number,
  permit: WritePermit,
  gate: Gate,
  save: Gate,
  now = Date.now(),
  release?: (entry: AutoRecycleEntry) => Promise<void>,
) {
  if (size > pair.recycleMaxBytes) throw fault('RECYCLE_FULL', '单文件超过回收站上限，原文件保留');
  for (const item of [...entries].sort((a, b) => a.expiresAt - b.expiresAt)) {
    if (recycleBytes(entries) + size <= pair.recycleMaxBytes) break;
    if (item.pending || now < Math.max(item.expiresAt, item.at + pair.retentionDays * 86_400_000) || await permit.canPurge?.(pair, item) !== true) continue;
    const file = await recyclePath(pair, item.id);
    const s = await statMaybe(file);
    if (s && (!s.isFile() || s.size !== item.size)) throw fault('CONFLICT', '回收项遭外部修改');
    if (s) { await gate(); await fs.unlink(file); }
    entries.splice(entries.indexOf(item), 1);
    await release?.(item);
    await save();
  }
  if (recycleBytes(entries) + size > pair.recycleMaxBytes) throw fault('RECYCLE_FULL', '回收站容量不足；未授权清理的副本已保留');
}

/**
 * 把备份端文件移入回收站（旧版物理存储路径）。
 *
 * 新流程的内容保存在介质对象库，由 `sync.ts` 负责登记版本；
 * 这里保留给迁移过来的旧版回收项使用。
 */
export async function moveToRecycle(pair: AutoPair, entries: AutoRecycleEntry[], relPath: string, kind: AutoRecycleEntry['kind'], expected: string, permit: WritePermit, gate: Gate, save: Gate) {
  const origin = await safePath(pair.targetRoot, relPath);
  const original = await fs.lstat(origin);
  if (!original.isFile() || stamp(original) !== expected) throw fault('CONFLICT', '备份文件已变更');
  await ensureRoom(pair, entries, original.size, permit, gate, save);
  const id = randomUUID();
  const dest = await recyclePath(pair, id);
  const dir = await safePath(pair.targetRoot, `.backup-studio/aut-recycle/${pair.id}`);
  await gate(); await fs.mkdir(dir, { recursive: true });
  const at = Date.now();
  const item = { id, relPath, size: original.size, at, expiresAt: at + pair.retentionDays * 86_400_000, kind, pending: true };
  entries.push(item);
  await save();
  if (stamp(await fs.lstat(origin)) !== expected) throw fault('CONFLICT', '备份文件已变更');
  await gate(); await fs.rename(origin, dest);
  item.pending = false;
}
