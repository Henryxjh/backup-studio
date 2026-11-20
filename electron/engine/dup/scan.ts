import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 重复文件检测的目录遍历（FR-02）。
 *
 * 与备份侧的 `engine/scan.ts` 有意分开：
 * - 备份扫描服务于「写什么」，需要稳定清单；
 * - 重复检测服务于「找出重复」，需要**跳过规则**与**文件身份**（dev/ino），
 *   以便删除前做二次校验（FR-09）。
 *
 * 本模块只读：不创建目录、不写临时件，扫描阶段对被检测目录零写副作用。
 */

/** 默认最小文件尺寸：1 KiB。低于该阈值的文件不参与分组（FR-02） */
export const DEFAULT_MIN_SIZE_BYTES = 1024;

/** 默认排除的目录名：本软件自身的元数据目录（FR-02） */
export const DUP_META_DIR = '.backup-studio';

/** 一个参与判定的文件 */
export interface DupCandidate {
  /** 绝对路径 */
  absPath: string;
  /** 相对扫描根的 POSIX 路径 */
  relPath: string;
  /** 父目录绝对路径：同名判定以「同一父目录」为界（FR-05） */
  dirPath: string;
  /** 文件名（含扩展名） */
  fileName: string;
  /** 字节数 */
  size: number;
  /** 修改时间（毫秒） */
  mtimeMs: number;
  /** 文件身份：设备号。删除前二次校验用（FR-09） */
  dev: string;
  /** 文件身份：inode。删除前二次校验用（FR-09） */
  ino: string;
}

export interface DupScanOptions {
  /** 最小文件尺寸（字节）；默认 1 KiB */
  minSizeBytes?: number;
  /** 额外排除的目录（按相对 POSIX 路径判断） */
  excludeDir?: (relPath: string) => boolean;
  /** 取消判定：返回 true 时立即停止遍历 */
  isCancelled?: () => boolean;
  /** 遍历进度回调（已处理目录项数 / 已处理文件数） */
  onProgress?: (done: number, total: number) => void;
}

export interface DupScanOutput {
  /** 扫描根 */
  root: string;
  /** 参与判定的文件 */
  candidates: DupCandidate[];
  /** 参与判定的文件总数 */
  totalFiles: number;
  /** 参与判定文件的总字节 */
  scannedBytes: number;
  /** 跳过的 0 字节文件数 */
  skippedEmpty: number;
  /** 跳过的低于最小尺寸的文件数 */
  skippedTooSmall: number;
  /** 跳过的符号链接数 */
  skippedSymlink: number;
  /** 不可读目录 / 无法 stat 的文件 */
  errors: string[];
  /** 是否被用户取消 */
  cancelled: boolean;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 相对路径统一用 POSIX 分隔符，与备份侧 relPath 语义一致 */
function toPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}

/**
 * 递归遍历扫描根，采集参与判定的文件元数据。
 *
 * 跳过规则（FR-02）：
 * - 符号链接一律跳过（不跟随）：避免成环与跨盘；
 * - 0 字节文件跳过并计数：内容必然相同，成组无清理价值；
 * - 低于最小尺寸的文件跳过并计数；
 * - `.backup-studio` 元数据目录跳过。
 */
export async function scanDupTree(root: string, options: DupScanOptions = {}): Promise<DupScanOutput> {
  const minSizeBytes = Math.max(1, Math.trunc(options.minSizeBytes ?? DEFAULT_MIN_SIZE_BYTES));
  const candidates: DupCandidate[] = [];
  const errors: string[] = [];
  let skippedEmpty = 0;
  let skippedTooSmall = 0;
  let skippedSymlink = 0;
  let cancelled = false;
  let seen = 0;

  const stack: string[] = [''];
  while (stack.length > 0) {
    if (options.isCancelled?.()) {
      cancelled = true;
      break;
    }
    const rel = stack.pop() as string;
    const abs = path.join(root, rel);
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch (err) {
      errors.push(`${rel || '.'}: ${errorText(err)}`);
      continue;
    }

    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      // 符号链接：跳过，不跟随（FR-02、FR-20）
      if (entry.isSymbolicLink()) {
        skippedSymlink++;
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === DUP_META_DIR) continue;
        if (options.excludeDir?.(toPosix(childRel))) continue;
        stack.push(childRel);
        continue;
      }
      if (!entry.isFile()) continue;

      seen++;
      options.onProgress?.(seen, seen);

      let stat: import('node:fs').Stats;
      try {
        stat = await fs.lstat(path.join(root, childRel));
      } catch (err) {
        errors.push(`${childRel}: ${errorText(err)}`);
        continue;
      }
      // 二次确认不是符号链接：扫描期间被替换成链接的文件不参与判定
      if (stat.isSymbolicLink()) {
        skippedSymlink++;
        continue;
      }
      if (stat.size === 0) {
        skippedEmpty++;
        continue;
      }
      if (stat.size < minSizeBytes) {
        skippedTooSmall++;
        continue;
      }
      candidates.push({
        absPath: path.join(root, childRel),
        relPath: toPosix(childRel),
        dirPath: path.join(root, rel),
        fileName: entry.name,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        dev: String(stat.dev),
        ino: String(stat.ino),
      });
    }
  }

  const scannedBytes = candidates.reduce((sum, file) => sum + file.size, 0);
  return {
    root,
    candidates,
    totalFiles: candidates.length,
    scannedBytes,
    skippedEmpty,
    skippedTooSmall,
    skippedSymlink,
    errors,
    cancelled,
  };
}
