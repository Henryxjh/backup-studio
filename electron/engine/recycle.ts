import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { RecycleBin, RecycleEntry } from '../../shared/types';
import { createDurableDirectory, historyDir, metaDir, syncDirectory, syncFile, writeJsonAtomic } from './manifest';

/**
 * 手动备份回收站。
 *
 * 实体内容仍由事务归档提供（`.backup-studio/history/<jobId>/<relPath>`），
 * 这里只维护一份可浏览、可还原的索引：条目登记、还原、彻底删除。
 *
 * 设计取舍：
 * - 索引与实体分离，避免同一份内容存两遍；
 * - 索引原子写入，崩溃后要么是旧索引要么是新索引，不会出现半个条目；
 * - 还原时若目标位置已被占用，默认拒绝而不是覆盖，避免用旧内容盖掉新备份。
 */

interface RecycleIndex {
  version: 1;
  entries: RecycleEntry[];
}

const INDEX_FILE = path.join('recycle', 'index.json');

/** 索引落盘位置（目标端 `.backup-studio/recycle/index.json`）。 */
export function recycleIndexPath(targetRoot: string): string {
  return path.join(metaDir(targetRoot), INDEX_FILE);
}

/**
 * 把 POSIX 风格的相对路径转成本机路径。
 *
 * 归档副本是事务用 `path.relative` 生成的原生分隔符路径，
 * 而计划里的 relPath 是 POSIX 风格，两者必须换算一致，否则还原会找不到文件。
 */
function nativePath(root: string, relPath: string): string {
  const parts = relPath.split('/').filter((part) => part.length > 0);
  if (parts.length === 0) throw new Error('回收项路径无效');
  // 目录穿越防护：条目路径来自扫描结果，但仍不得越出目标根。
  if (parts.some((part) => part === '..' || part === '.' || part.includes('\\'))) {
    throw new Error('回收项路径无效');
  }
  return path.join(root, ...parts);
}

/** 归档副本的物理位置。 */
export function archivePath(targetRoot: string, entry: RecycleEntry): string {
  return nativePath(path.join(historyDir(targetRoot), entry.jobId), entry.relPath);
}

async function readIndex(targetRoot: string): Promise<RecycleIndex> {
  try {
    const raw = await fs.readFile(recycleIndexPath(targetRoot), 'utf8');
    const parsed = JSON.parse(raw) as RecycleIndex;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      throw new Error('索引格式无效');
    }
    return { version: 1, entries: parsed.entries.filter(isEntry) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, entries: [] };
    // 索引损坏时不得假装回收站是空的：那会让用户以为内容被彻底丢弃了。
    throw new Error(`回收站索引损坏：${(err as Error).message}`);
  }
}

function isEntry(value: unknown): value is RecycleEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<RecycleEntry>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.relPath === 'string' &&
    typeof entry.size === 'number' &&
    typeof entry.deletedAt === 'number' &&
    typeof entry.jobId === 'string'
  );
}

async function writeIndex(targetRoot: string, index: RecycleIndex): Promise<void> {
  await writeJsonAtomic(recycleIndexPath(targetRoot), index);
}

function snapshot(targetRoot: string, entries: RecycleEntry[]): RecycleBin {
  const sorted = [...entries].sort((a, b) => b.deletedAt - a.deletedAt);
  return {
    targetRoot,
    entries: sorted,
    totalBytes: sorted.reduce((n, entry) => n + entry.size, 0),
  };
}

/** 读取回收站快照。 */
export async function listRecycle(targetRoot: string): Promise<RecycleBin> {
  const index = await readIndex(targetRoot);
  return snapshot(targetRoot, index.entries);
}

/**
 * 删除动作执行器：登记被删除的文件。
 *
 * 一次备份可能删除成百上千个文件，索引不能每个文件重写一遍，
 * 因此这里先在内存里攒够一批再落盘；备份结束时必须调用 `flush`。
 */
export class RecycleRecorder {
  private entries: RecycleEntry[] = [];
  private flushed = 0;

  constructor(private readonly targetRoot: string, private readonly jobId: string) {}

  async record(relPath: string, size: number): Promise<RecycleEntry> {
    const entry: RecycleEntry = {
      id: randomUUID(),
      relPath,
      size,
      deletedAt: Date.now(),
      jobId: this.jobId,
    };
    this.entries.push(entry);
    // 每登记 50 条落一次盘：崩溃最多丢掉这一批的索引，
    // 但归档副本仍在磁盘上，不会造成数据丢失。
    if (this.entries.length - this.flushed >= 50) await this.flush();
    return entry;
  }

  /** 把本次登记的条目合并进索引并落盘。 */
  async flush(): Promise<void> {
    if (this.entries.length === this.flushed) return;
    const index = await readIndex(this.targetRoot);
    index.entries = [...index.entries, ...this.entries.slice(this.flushed)];
    await writeIndex(this.targetRoot, index);
    this.flushed = this.entries.length;
  }
}

/**
 * 把回收项还原回备份端的原位置。
 *
 * 目标位置已被占用时默认拒绝——旧内容不应该悄悄盖掉新备份，
 * 只有用户明确确认覆盖时才继续。
 */
export async function restoreRecycle(targetRoot: string, id: string, overwrite: boolean): Promise<RecycleBin> {
  const index = await readIndex(targetRoot);
  const entry = index.entries.find((item) => item.id === id);
  if (!entry) throw new Error('回收项不存在或已被处理');

  const source = archivePath(targetRoot, entry);
  const stat = await fs.lstat(source).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new Error('回收项的归档副本已丢失，无法还原');
  }

  const destination = nativePath(targetRoot, entry.relPath);
  const occupied = await fs.lstat(destination).catch(() => null);
  if (occupied && !overwrite) {
    // 渲染层靠「占用」二字识别这是「需要用户决定是否覆盖」而不是普通失败，
    // 改写这句文案前先同步 RecycleBin.tsx 的判定。
    throw new Error('目标位置已被占用，请确认覆盖后再试');
  }

  await createDurableDirectory(path.dirname(destination), path.resolve(targetRoot));
  const tmp = `${destination}.restore-${randomUUID()}`;
  try {
    await fs.copyFile(source, tmp, constants.COPYFILE_EXCL);
    await syncFile(tmp);
    await fs.rename(tmp, destination);
    await syncDirectory(path.dirname(destination));
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }

  index.entries = index.entries.filter((item) => item.id !== id);
  await writeIndex(targetRoot, index);
  return snapshot(targetRoot, index.entries);
}

/** 彻底删除回收项：连同归档副本一起清掉。 */
export async function removeRecycle(targetRoot: string, id: string): Promise<RecycleBin> {
  const index = await readIndex(targetRoot);
  const entry = index.entries.find((item) => item.id === id);
  if (!entry) throw new Error('回收项不存在或已被处理');

  const source = archivePath(targetRoot, entry);
  await fs.unlink(source).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });

  index.entries = index.entries.filter((item) => item.id !== id);
  await writeIndex(targetRoot, index);
  return snapshot(targetRoot, index.entries);
}
