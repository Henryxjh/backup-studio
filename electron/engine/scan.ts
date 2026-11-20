import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';

/** 目标端元数据目录，用于存放 manifest / 断点续传临时件 / 历史归档 */
export const META_DIR = '.backup-studio';

export interface ScannedFile {
  /** 相对根目录的 POSIX 路径 */
  relPath: string;
  size: number;
  mtimeMs: number;
}

export interface ScannedTree {
  root: string;
  files: Map<string, ScannedFile>;
  /** 相对目录路径（不含根） */
  dirs: string[];
  totalBytes: number;
  skippedSymlinks: number;
  errors: string[];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 深度优先扫描目录树。
 * - 符号链接默认跳过：备份跟随链接可能造成环或越界到目标盘，风险不可控。
 * - META_DIR 自身被排除：它是备份工具的元数据，不参与内容同步。
 */
export async function scanTree(
  root: string,
  options: { exclude?: (relPath: string) => boolean; excludeMetaDir?: boolean } = {},
): Promise<ScannedTree> {
  const excludeMetaDir = options.excludeMetaDir ?? true;
  const files = new Map<string, ScannedFile>();
  const dirs: string[] = [];
  const errors: string[] = [];
  let totalBytes = 0;
  let skippedSymlinks = 0;

  const stack: string[] = [''];
  while (stack.length > 0) {
    const rel = stack.pop() as string;
    const abs = path.join(root, rel);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch (err) {
      errors.push(`${rel || '.'}: ${errorText(err)}`);
      continue;
    }

    for (const entry of entries) {
      if (excludeMetaDir && entry.name === META_DIR) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (options.exclude?.(childRel)) continue;

      if (entry.isSymbolicLink()) {
        skippedSymlinks++;
        continue;
      }
      if (entry.isDirectory()) {
        dirs.push(childRel);
        stack.push(childRel);
        continue;
      }
      if (!entry.isFile()) continue;

      try {
        const stat = await fs.stat(path.join(root, childRel));
        files.set(childRel, { relPath: childRel, size: stat.size, mtimeMs: stat.mtimeMs });
        totalBytes += stat.size;
      } catch (err) {
        errors.push(`${childRel}: ${errorText(err)}`);
      }
    }
  }

  return {
    root,
    files,
    dirs: dirs.sort(),
    totalBytes,
    skippedSymlinks,
    errors,
  };
}
