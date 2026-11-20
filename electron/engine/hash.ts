import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

/**
 * 统一使用 SHA-256。
 * node:crypto 的摘要计算是原生实现（C++），不在 JS 线程瓶颈上，
 * 大文件哈希与复制流可以零拷贝并行。
 */
export function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath, { highWaterMark: 1024 * 1024 }), hash);
  return hash.digest('hex');
}

export interface HashBatchResult {
  hashes: Map<string, string>;
  errors: Map<string, string>;
}

/** 计算一批文件的哈希并保留单文件失败信息，供规划器阻止未知孤儿误删。 */
export async function hashFilesDetailed(
  entries: { key: string; path: string }[],
  concurrency: number,
  onProgress?: (done: number, total: number) => void,
): Promise<HashBatchResult> {
  const hashes = new Map<string, string>();
  const errors = new Map<string, string>();
  if (entries.length === 0) return { hashes, errors };

  let cursor = 0;
  let done = 0;
  const workerCount = Math.max(1, Math.min(concurrency, entries.length));

  const runOne = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= entries.length) return;
      const entry = entries[index];
      try {
        hashes.set(entry.key, await hashFile(entry.path));
      } catch (err) {
        errors.set(entry.key, err instanceof Error ? err.message : String(err));
      }
      done++;
      onProgress?.(done, entries.length);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => runOne()));
  return { hashes, errors };
}

/** 计算一批文件的哈希，带并发上限，避免把磁盘打满成随机寻道。 */
export async function hashFiles(
  entries: { key: string; path: string }[],
  concurrency: number,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, string>> {
  const { hashes } = await hashFilesDetailed(entries, concurrency, onProgress);
  return hashes;
}
