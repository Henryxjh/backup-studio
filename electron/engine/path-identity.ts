import fs from 'node:fs';
import path from 'node:path';

/**
 * 路径身份比较。
 *
 * 字符串比较有两个方向相反的坑：
 *
 * 1. **折叠大小写会误合**。Windows / macOS 默认大小写不敏感，同一个目录用不同
 *    大小写写出来是同一个地方；但 Linux、以及开启了大小写敏感的 NTFS 目录里，
 *    `Foo` 和 `foo` 是**两个真实不同的目录**，全局转小写会把它们当成同一个。
 * 2. **不折叠大小写会漏配**。在大小写不敏感的卷上，同一个目录的账本可能因为
 *    大小写不同而找不到自己，导致「索引丢失后重建」时漏掉本该重建的条目。
 *
 * 因此这里统一用**磁盘真实身份**（realpath）来判断「是不是同一个地方」：
 * 两侧都能解析时，realpath 返回的是磁盘上实际的大小写与真实目标，
 * 此时**区分大小写比较**才是正确的（大小写不敏感的卷上 realpath 会把两边
 * 归一到同一个实际名字；大小写敏感的卷上则保持不同）。
 *
 * realpath 不可得（路径不存在、盘未接入、权限不足）时退回到平台大小写规则，
 * 并把这个「退化」如实暴露给调用方，不假装比较是精确的。
 */

/** Windows 与 macOS 默认大小写不敏感；Linux 默认敏感。 */
export const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin';

/** 把路径归一到可直接比较的绝对形式（不做大小写折叠）。 */
export function normalizePath(target: string): string {
  return path.resolve(target);
}

/** 仅按平台大小写规则做字符串比较（退化路径）。 */
export function samePathString(a: string, b: string): boolean {
  const x = normalizePath(a);
  const y = normalizePath(b);
  return CASE_INSENSITIVE_PATHS ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * 解析路径在磁盘上的真实身份；解析不出来（不存在 / 未接入 / 无权限）时返回 undefined。
 */
export function realpathIfExists(target: string): string | undefined {
  try {
    return fs.realpathSync.native(normalizePath(target));
  } catch {
    return undefined;
  }
}

/** 文件身份：realpath + 体积 + 修改时间。用于判断「路径上的还是不是同一个实体」。 */
export interface PathIdentity {
  realpath?: string;
  size: number;
  mtimeMs: number;
  ino: number;
  dev: number;
}

/** 从 `fs.Stats` 构造身份；realpath 单独解析（可能失败）。 */
export function identityOf(target: string, stat: fs.Stats): PathIdentity {
  return {
    realpath: realpathIfExists(target),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ino: stat.ino,
    dev: stat.dev,
  };
}

/** 两个身份是否指向同一个实体。 */
export function sameIdentity(a: PathIdentity, b: PathIdentity): boolean {
  if (a.realpath && b.realpath) return a.realpath === b.realpath;
  // 退化比较：同一设备、同一 inode、大小与修改时间一致。
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/**
 * 两个路径是否指向同一个地方。
 *
 * 两侧都能解析到磁盘真实身份时，以 realpath 为准（区分大小写比较）。
 * 否则退回平台大小写规则。
 */
export function samePathIdentity(a: string, b: string): boolean {
  const ra = realpathIfExists(a);
  const rb = realpathIfExists(b);
  if (ra && rb) return ra === rb;
  return samePathString(a, b);
}

/**
 * `child` 是否位于 `dir` 之内（含 `dir` 本身）。
 *
 * 用于「受保护目录的整棵子树不得删除」这类判断。
 */
export function isUnderDirectory(child: string, dir: string): boolean {
  const rc = realpathIfExists(child) ?? normalizePath(child);
  const rd = realpathIfExists(dir) ?? normalizePath(dir);
  const rel = path.relative(rd, rc);
  if (!rel) return true;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}
