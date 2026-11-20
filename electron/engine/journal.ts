import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './manifest';
import type { MediaIdentity, QuarantineMark, SyncMode } from '../../shared/types';

/**
 * 本机事务日志（权威）与盘上日志（辅助）。
 *
 * 关键决策：
 *  - **本机为权威**。目标盘被拔出时，断点必须仍然可读，否则「拔盘恢复」无从谈起。
 *    因此本机日志写在 userData，不写在目标盘。
 *  - 盘上日志只作候选证据，用于介质恢复后交叉核对；冲突时以本机最后已提交事务为准。
 *  - 每条日志带事务序列号与 CRC，截断的盘上日志能被识别出来，而不是被当成有效数据。
 */

export interface JournalTask {
  relPath: string;
  totalBytes: number;
  copiedBytes: number;
  partPath: string;
  sha256?: string;
  status: 'copying' | 'done' | 'failed';
}

export interface JournalInterruption {
  /** 中断时间 */
  at: number;
  /** 中断原因（人类可读） */
  reason: string;
  /** 中断时正在写入的分片 */
  activeFiles: string[];
  /** 中断前已提交的分片数 */
  committedTasks: number;
}

export interface Journal {
  version: 1;
  jobId: string;
  sourceRoot: string;
  targetRoot: string;
  syncMode: SyncMode;
  createdAt: number;
  updatedAt: number;
  /** 事务序列号：单调递增，用于判定「最后已提交事务」 */
  txSeq: number;
  /** 已提交的事务序列号 */
  committedTx: number;
  /** 计划阶段锁定的介质身份 */
  mediaIdentity?: MediaIdentity;
  /** 中断标记 */
  interruption?: JournalInterruption;
  /** 隔离观察标记 */
  quarantine?: QuarantineMark;
  tasks: Record<string, JournalTask>;
}

/** 盘上辅助日志：只写一次，作为交叉核对证据 */
export interface MirrorJournal {
  version: 1;
  jobId: string;
  txSeq: number;
  updatedAt: number;
  /** 与本机日志比对用的校验值 */
  crc: string;
  tasks: Record<string, { relPath: string; totalBytes: number; copiedBytes: number; sha256?: string }>;
}

/** 简单 CRC32，用于识别盘上日志是否被截断或损坏 */
export function crc32(text: string): string {
  let crc = 0xffffffff;
  for (let i = 0; i < text.length; i += 1) {
    crc ^= text.charCodeAt(i);
    for (let k = 0; k < 8; k += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff).toString(16).padStart(8, '0');
}

export class JournalStore {
  constructor(readonly baseDir: string) {}

  private get jobsDir(): string {
    return path.join(this.baseDir, 'jobs');
  }

  private activePath(): string {
    return path.join(this.jobsDir, 'active.json');
  }

  jobPath(jobId: string): string {
    return path.join(this.jobsDir, `${jobId}.json`);
  }

  async read(jobId: string): Promise<Journal | null> {
    try {
      const raw = await fs.readFile(this.jobPath(jobId), 'utf8');
      const parsed = JSON.parse(raw) as Journal;
      if (!parsed || parsed.version !== 1) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async write(journal: Journal): Promise<void> {
    journal.updatedAt = Date.now();
    await writeJsonAtomic(this.jobPath(journal.jobId), journal);
  }

  async setActive(jobId: string): Promise<void> {
    await writeJsonAtomic(this.activePath(), { jobId, updatedAt: Date.now() });
  }

  async getActive(): Promise<Journal | null> {
    try {
      const raw = await fs.readFile(this.activePath(), 'utf8');
      const { jobId } = JSON.parse(raw) as { jobId: string };
      return await this.read(jobId);
    } catch {
      return null;
    }
  }

  async clearActive(): Promise<void> {
    try {
      await fs.unlink(this.activePath());
    } catch {
      // 活动任务指针不存在时无需处理
    }
  }

  /**
   * 写入盘上辅助日志。
   *
   * 尽力而为：介质掉线时这个调用注定失败，失败不能影响主流程——
   * 本机日志才是权威。返回是否写成功，供上层记录证据。
   */
  async writeMirror(targetRoot: string, journal: Journal): Promise<boolean> {
    const payload: Omit<MirrorJournal, 'crc'> = {
      version: 1,
      jobId: journal.jobId,
      txSeq: journal.txSeq,
      updatedAt: Date.now(),
      tasks: Object.fromEntries(
        Object.entries(journal.tasks).map(([key, task]) => [
          key,
          {
            relPath: task.relPath,
            totalBytes: task.totalBytes,
            copiedBytes: task.copiedBytes,
            sha256: task.sha256,
          },
        ]),
      ),
    };
    const body = JSON.stringify(payload, null, 2);
    const mirror: MirrorJournal = { ...payload, crc: crc32(body) };
    try {
      const dir = path.join(targetRoot, '.backup-studio');
      // **不得创建**目标端目录。介质掉线后 mkdir 会把目标目录重新造出来，
      // 让随后的只读探测把这个自己造出来的目录当成「介质可达」，
      // 把 lost 状态悄悄翻回 online——掉线事实被彻底掩盖。
      // 父目录不存在即视为「介质已不在」，直接放弃本次镜像写入。
      await writeJsonAtomic(path.join(dir, 'journal-mirror.json'), mirror, { createDirs: false });
      return true;
    } catch {
      return false;
    }
  }

  /** 读取盘上辅助日志；损坏或被截断时返回 null */
  async readMirror(targetRoot: string): Promise<MirrorJournal | null> {
    try {
      const raw = await fs.readFile(path.join(targetRoot, '.backup-studio', 'journal-mirror.json'), 'utf8');
      const parsed = JSON.parse(raw) as MirrorJournal;
      if (!parsed || parsed.version !== 1) return null;
      const { crc, ...body } = parsed;
      if (crc32(JSON.stringify(body, null, 2)) !== crc) return null;
      return parsed;
    } catch {
      return null;
    }
  }
}

/** 把相对路径映射成安全的临时文件名，避免路径分隔符、超长名与哈希碰撞问题 */
export function partFileName(relPath: string): string {
  const base = path.basename(relPath).replace(/[^\w.\-一-龥]/g, '_').slice(-48);
  const digest = createHash('sha256').update(relPath, 'utf8').digest('hex').slice(0, 24);
  return `${base}.${digest}.part`;
}
