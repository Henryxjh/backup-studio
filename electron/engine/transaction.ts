import { randomBytes } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import { hashFile } from './hash';
import path from 'node:path';
import {
  createDurableDirectory, historyDir, manifestPath, metaDir, syncDirectory, syncFile,
} from './manifest';
import { CASE_INSENSITIVE_PATHS, normalizePath, realpathIfExists, samePathIdentity } from './path-identity';

/** One undo generation addressed by the durable job id. Entries are write-once across retries. */
export class BackupTransaction {
  private readonly history: string;
  private readonly previousManifest: string;

  constructor(readonly root: string, jobId: string, private readonly check: () => Promise<void>) {
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error('备份事务标识无效');
    this.history = path.join(historyDir(root), jobId);
    this.previousManifest = path.join(metaDir(root), 'history-index', `${jobId}.json`);
  }

  async preserveManifest(): Promise<void> {
    await this.preserve(manifestPath(this.root), this.previousManifest);
  }

  async preserveTarget(file: string, expectedSize?: number): Promise<{ archivePath: string; size: number; sha256?: string } | undefined> {
    const archivePath = path.join(this.history, path.relative(this.root, file));
    await this.preserve(file, archivePath);
    const stat = await fs.lstat(archivePath).catch(ignoreMissing);
    if (!stat && expectedSize === undefined) return undefined;
    if (!stat?.isFile() || (expectedSize !== undefined && stat.size !== expectedSize)) {
      throw new Error(`归档副本无效：${archivePath}`);
    }
    return { archivePath, size: stat.size, sha256: expectedSize === undefined ? undefined : await hashFile(archivePath) };
  }

  private async preserve(src: string, dest: string): Promise<void> {
    await this.check();
    const previous = await fs.lstat(dest).catch(ignoreMissing);
    if (previous) {
      if (!previous.isFile()) throw new Error('事务历史文件无效');
      await syncDirectory(path.dirname(dest));
      return;
    }
    const current = await fs.lstat(src).catch(ignoreMissing);
    if (!current) return;
    if (!current.isFile()) throw new Error(`目标路径不是普通文件：${src}`);
    await createDurableDirectory(path.dirname(dest), this.root);
    let tmp: string | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = path.join(path.dirname(dest), `.backup-studio-archive-${randomBytes(16).toString('hex')}`);
      if (await fs.lstat(candidate).catch(ignoreMissing)) continue;
      try {
        await fs.copyFile(src, candidate, constants.COPYFILE_EXCL);
        tmp = candidate;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        await fs.unlink(candidate).catch(() => undefined);
        throw err;
      }
    }
    if (!tmp) throw new Error(`无法分配归档临时文件：${dest}`);
    try {
      await syncFile(tmp);
      const after = await fs.lstat(src);
      if (current.dev !== after.dev || current.ino !== after.ino || current.size !== after.size ||
          current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) {
        throw new Error(`保存旧版本期间目标文件发生变化：${src}`);
      }
      await this.check();
      await fs.rename(tmp, dest);
      await syncDirectory(path.dirname(dest));
    } catch (err) {
      await fs.unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  /**
   * 清理事务历史目录。
   *
   * `protectedPaths` 里的归档实体仍在回收站索引中被引用，绝不能删除：
   * 那会让「可还原的内容」变成不可解释的悬空证据。
   */
  async cleanup(protectedPaths: ReadonlySet<string> = new Set()): Promise<void> {
    await this.check();
    if (protectedPaths.size === 0) {
      await fs.rm(this.history, { recursive: true, force: true });
    } else {
      await this.removeHistory(protectedPaths);
    }
    await this.check();
    await fs.unlink(this.previousManifest).catch(ignoreMissing);
    await syncDirectory(historyDir(this.root)).catch(ignoreMissing);
  }

  private async removeHistory(protectedPaths: ReadonlySet<string>): Promise<void> {
    // 受保护路径里若包含目录，它的整棵子树都不得删除。
    // 契约只保证「文件级保护」时，目录级保护必须按子树处理，
    // 否则被保护的目录仍会被逐个文件删空。
    //
    // 关键：调用方传入的是「它自己记下的写法」，磁盘上可能是另一种大小写
    // （Windows 上同一个目录能被写成任意大小写）。受保护路径必须按
    // 「磁盘真实身份」匹配，绝不能按字符串精确匹配——否则受保护子树会被删空。
    const protectedDirs: ProtectedDir[] = [];
    const protectedFiles = new Set<string>();
    for (const item of protectedPaths) {
      const resolved = normalizePath(item);
      protectedFiles.add(fileProtectionKey(resolved));
      const stat = await fs.lstat(resolved).catch(ignoreMissing);
      protectedDirs.push({
        path: resolved,
        // 仅大小写不同也算同一个受保护目录：拿不准就不删。
        looseKey: resolved.toLowerCase(),
        realpath: stat?.isDirectory() ? realpathIfExists(resolved) : undefined,
        dev: stat?.dev ?? 0,
        ino: stat?.ino ?? 0,
      });
    }
    const walk = async (dir: string): Promise<boolean> => {
      const stat = await fs.lstat(dir).catch(ignoreMissing);
      if (!stat) return true;
      if (stat.isDirectory() && isProtectedDirectory(dir, stat, protectedDirs)) return false;
      if (!stat.isDirectory()) {
        if (protectedFiles.has(fileProtectionKey(dir))) return false;
        await fs.unlink(dir).catch(ignoreMissing);
        return true;
      }
      let empty = true;
      for (const name of await fs.readdir(dir)) {
        if (await walk(path.join(dir, name))) continue;
        empty = false;
      }
      if (empty) await fs.rmdir(dir).catch(() => undefined);
      return empty;
    };
    await walk(this.history);
  }
}

/** 受保护目录的判定依据：磁盘真实身份 + 保守的大小写兜底。 */
interface ProtectedDir {
  /** 调用方传入的绝对路径（退化比较时使用）。 */
  path: string;
  /** 磁盘真实身份（realpath），进入遍历前解析一次，遍历中不再重复解析。 */
  realpath?: string;
  /** 目录实体身份：dev + inode，与路径写法（含大小写）无关。 */
  dev: number;
  ino: number;
  /** 仅大小写不同的路径也当作同一个受保护目录（宁可多保护）。 */
  looseKey: string;
}

/**
 * 文件级保护的比较键：按平台大小写规则归一。
 * Windows / macOS 折叠大小写（宁可多保护，少删文件），Linux 保持精确路径。
 */
function fileProtectionKey(target: string): string {
  const resolved = normalizePath(target);
  return CASE_INSENSITIVE_PATHS ? resolved.toLowerCase() : resolved;
}

/**
 * 「正在访问的目录」是不是某个受保护目录？
 *
 * 三条判定任意一条命中即视为受保护（从精确到保守）：
 * 1. dev + inode：磁盘上同一个目录实体，与路径写法（含大小写）无关；
 * 2. 仅大小写不同：调用方记下的写法与磁盘写法只差大小写时，拿不准就不删；
 * 3. realpath：解析到磁盘真实目标后一致（覆盖符号链接 / 联接 / 8.3 短名等别名）。
 */
function isProtectedDirectory(dir: string, stat: Stats, protectedDirs: readonly ProtectedDir[]): boolean {
  const looseKey = normalizePath(dir).toLowerCase();
  for (const protectedDir of protectedDirs) {
    if (protectedDir.ino !== 0 && protectedDir.dev === stat.dev && protectedDir.ino === stat.ino) return true;
    if (protectedDir.looseKey === looseKey) return true;
    if (protectedDir.realpath) {
      const realpath = realpathIfExists(dir);
      if (realpath && realpath === protectedDir.realpath) return true;
    } else if (samePathIdentity(protectedDir.path, dir)) return true;
  }
  return false;
}

function ignoreMissing(err: NodeJS.ErrnoException): undefined {
  if (err.code !== 'ENOENT') throw err;
}
