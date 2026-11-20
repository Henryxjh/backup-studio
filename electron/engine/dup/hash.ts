import { promises as fs } from 'node:fs';
import { hashConcurrency, hashFilesDetailed, sha256Buffer } from '../hash';

/**
 * 重复检测专用的哈希封装（FR-03）。
 *
 * 两级判定：
 * - **局部哈希**：读头 64 KiB + 尾 64 KiB 拼接后算 SHA-256，代价固定（≤128 KiB/文件）；
 * - **全量哈希**：读整个文件，代价与文件大小成正比。
 *
 * 全量哈希直接复用 `engine/hash.ts` 的并发池（并发数随 CPU 自适应），
 * 局部哈希在此按同一并发口径实现一个轻量池，两者语义一致。
 */

/** 局部哈希窗口：头尾各 64 KiB（FR-03） */
export const PARTIAL_WINDOW_BYTES = 64 * 1024;

/** 超过该阈值的文件跳过全量校验，标记为「疑似重复」（FR-03） */
export const FULL_HASH_LIMIT_BYTES = 256 * 1024 * 1024;

/** 全量哈希按批处理：批内并发、批间累计已读字节，便于给出可解释的进度 */
const FULL_HASH_BATCH = 32;

export interface PartialHashEntry {
  key: string;
  path: string;
  size: number;
}

export interface PartialHashResult {
  hashes: Map<string, string>;
  errors: Map<string, string>;
  /** 实际读取字节数（用于吞吐与剩余时间估算） */
  bytesRead: number;
}

export interface FullHashResult {
  hashes: Map<string, string>;
  errors: Map<string, string>;
  /** 实际读取字节数（批结束时精确累计） */
  bytesRead: number;
}

/** 读取到缓冲区末尾或读满为止；短读会被补齐，避免算出错误的哈希 */
async function readExact(handle: fs.FileHandle, buffer: Buffer, position: number): Promise<number> {
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, position + filled);
    if (bytesRead <= 0) break;
    filled += bytesRead;
  }
  return filled;
}

/**
 * 计算单个文件的首尾局部哈希。
 *
 * 文件不大于 64 KiB 时直接整文件哈希：此时「头 + 尾」就是全文，
 * 拼接反而会重复内容、徒增 I/O。同一 size 桶内所有文件走同一条分支，
 * 因此同桶比较始终自洽。
 */
export async function hashPartialFile(absPath: string, size: number): Promise<{ hash: string; bytesRead: number }> {
  const handle = await fs.open(absPath, 'r');
  try {
    if (size <= PARTIAL_WINDOW_BYTES) {
      const buffer = Buffer.allocUnsafe(size);
      const filled = await readExact(handle, buffer, 0);
      return { hash: sha256Buffer(buffer.subarray(0, filled)), bytesRead: filled };
    }
    const head = Buffer.allocUnsafe(PARTIAL_WINDOW_BYTES);
    await readExact(handle, head, 0);
    const tail = Buffer.allocUnsafe(PARTIAL_WINDOW_BYTES);
    await readExact(handle, tail, size - PARTIAL_WINDOW_BYTES);
    return { hash: sha256Buffer(Buffer.concat([head, tail])), bytesRead: PARTIAL_WINDOW_BYTES * 2 };
  } finally {
    await handle.close();
  }
}

/**
 * 批量计算局部哈希。
 *
 * 与全量哈希一样，单文件失败只记入 errors，不影响其余文件——
 * 判定失败的文件不参与任何分组，也不等于「不重复」。
 */
export async function hashPartialsDetailed(
  entries: PartialHashEntry[],
  concurrency: number,
  onProgress?: (done: number, total: number, bytesRead: number) => void,
): Promise<PartialHashResult> {
  const hashes = new Map<string, string>();
  const errors = new Map<string, string>();
  if (entries.length === 0) return { hashes, errors, bytesRead: 0 };

  let cursor = 0;
  let done = 0;
  let bytesRead = 0;
  const workerCount = Math.max(1, Math.min(concurrency, entries.length));

  const runOne = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= entries.length) return;
      const entry = entries[index];
      try {
        const result = await hashPartialFile(entry.path, entry.size);
        hashes.set(entry.key, result.hash);
        bytesRead += result.bytesRead;
      } catch (err) {
        errors.set(entry.key, err instanceof Error ? err.message : String(err));
      }
      done++;
      onProgress?.(done, entries.length, bytesRead);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => runOne()));
  return { hashes, errors, bytesRead };
}

/**
 * 批量计算全量哈希。
 *
 * 复用 `engine/hash.ts` 的并发实现；按批结算已读字节，
 * 保证进度里的「已读字节」在批边界上是精确值。
 */
export async function hashFullFilesDetailed(
  entries: { key: string; path: string; size: number }[],
  concurrency: number,
  onProgress?: (done: number, total: number, bytesRead: number) => void,
): Promise<FullHashResult> {
  const hashes = new Map<string, string>();
  const errors = new Map<string, string>();
  if (entries.length === 0) return { hashes, errors, bytesRead: 0 };

  const sizes = new Map(entries.map((entry) => [entry.key, entry.size]));
  let done = 0;
  let bytesRead = 0;
  for (let index = 0; index < entries.length; index += FULL_HASH_BATCH) {
    const batch = entries.slice(index, index + FULL_HASH_BATCH);
    const result = await hashFilesDetailed(
      batch.map((entry) => ({ key: entry.key, path: entry.path })),
      concurrency,
    );
    for (const [key, hash] of result.hashes) hashes.set(key, hash);
    for (const [key, reason] of result.errors) errors.set(key, reason);
    done += batch.length;
    // 批次内的文件都已读完，按批结算字节数（批内进度为估算值）
    bytesRead += batch.reduce((sum, entry) => sum + (sizes.get(entry.key) ?? 0), 0);
    onProgress?.(done, entries.length, bytesRead);
  }
  return { hashes, errors, bytesRead };
}

/** 当前并发口径：与备份引擎共用（FR-03） */
export function dupHashConcurrency(): number {
  return hashConcurrency();
}
