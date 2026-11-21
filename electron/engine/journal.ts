import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { syncDirectory, writeJsonAtomic } from './manifest';
import { samePathIdentity } from './path-identity';
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

export type DeleteTxState =
  | 'planned' | 'archived' | 'intent-persisted' | 'original-deleted'
  | 'indexed' | 'committed' | 'uncertain';

/**
 * 目标端路径是否指向同一个地方。
 *
 * 判定依据是**磁盘真实身份**而不是字符串：字符串折叠大小写会把大小写敏感卷上
 * 两个真实不同的目录（`Foo` 与 `foo`）当成同一个，从而把一个目标的账本
 * 串到另一个目标上；完全不折叠又会在大小写不敏感的卷上漏配自己的账本。
 * 详见 `path-identity.ts`。
 */
export function sameTargetPath(a: string, b: string): boolean {
  return samePathIdentity(a, b);
}

export interface DeleteTx {
  txId: string;
  jobId: string;
  relPath: string;
  size: number;
  archiveRelPath: string;
  archiveSize?: number;
  archiveSha256?: string;
  state: DeleteTxState;
  lastError?: string;
  /**
   * 删除已作废：恢复时发现原文件仍在，删除被取消。
   * 归档实体保留待人工处理，但**不**登记进回收索引（不是一条可还原的回收项）。
   */
  voided?: boolean;
  /**
   * 该回收项已经结案：`restored` = 已还原到原位置，`removed` = 已彻底删除。
   * 结案的条目不得在索引重建时复活——用户已经处理过它了。
   */
  settled?: 'restored' | 'removed';
  /**
   * 待删文件的临时名（与原文件同目录）。
   *
   * 崩溃可能发生在「原子移走」与「真正删除」之间，这时原文件已经不在原位，
   * 只有这个临时名指向它。名字必须**先落盘到账本**再执行移走，否则崩溃后
   * 恢复流程无从知道该去哪里找回这份待删内容。
   */
  trashPath?: string;
  updatedAt: number;
}

export interface Journal {
  deletes?: Record<string, DeleteTx>;
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
  /** 本机意图在首次目标写入前持久化，复制状态不能代表清单已提交。 */
  transaction?: 'pending';
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
    let raw: string;
    try {
      raw = await fs.readFile(this.jobPath(jobId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as Journal;
      if (!parsed || parsed.version !== 1) throw new Error('版本不受支持');
      return parsed;
    } catch (err) {
      throw Object.assign(new Error(`任务账本损坏或版本不受支持：${jobId}`, { cause: err }), { code: 'JOURNAL_INVALID' });
    }
  }

  listDeleteTx(journal: Journal): DeleteTx[] {
    return Object.values(journal.deletes ?? {});
  }

  /**
   * 账本目录下所有任务 id（不含 active 指针）。
   *
   * `clearActive` 只删掉活动指针，`jobs/<jobId>.json` 本身会保留，
   * 所以任务结束后删除事务依然有据可查。
   *
   * **读不出来必须报错**：把 `readdir` 的失败吞成空数组，会让调用方以为
   * 「这个目标端没有任何删除事务」，进而把「索引缺失 + 账本读不出来」
   * 当成空回收站重建索引——已删除文件的唯一副本就此从界面上消失。
   * 只有目录确实不存在（ENOENT）才返回空。
   */
  async listJobIds(): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.jobsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return names
      .filter((name) => name.endsWith('.json') && name !== 'active.json')
      .map((name) => name.slice(0, -'.json'.length))
      .filter((id) => /^[\w-]+$/.test(id));
  }

  /**
   * 某个目标端上所有任务留下的删除事务（含已提交的）。
   *
   * 回收索引是可浏览的入口，但**不是唯一证据**：归档实体会长期留在目标端，
   * 索引一旦丢失，已删除文件的唯一副本就再也看不见、也还原不了。
   * 账本是本机权威，必须能跨任务把删除事务重新找回来。
   *
   * **损坏的账本不得被静默跳过**：跳过会让那份账本里的删除事务连同它们的归档
   * 一起从「可找回的证据」变成「看不见的孤儿」。这里把读失败的任务报出来，
   * 由调用方决定阻断还是降级，绝不假装它们不存在。
   */
  async listDeleteTxByTarget(targetRoot: string): Promise<DeleteTx[]> {
    const { txs, failures } = await this.listDeleteTxByTargetDetailed(targetRoot);
    if (failures.length) {
      const detail = failures.map((f) => `${f.jobId}（${f.message}）`).join('；');
      throw Object.assign(
        new Error(`部分任务账本读取失败，删除事务清单不完整：${detail}`),
        { code: 'JOURNAL_INVALID' },
      );
    }
    return txs;
  }

  /** 与 `listDeleteTxByTarget` 相同，但把读失败的任务单独报出来，不抛错。 */
  async listDeleteTxByTargetDetailed(targetRoot: string): Promise<{
    txs: DeleteTx[];
    failures: { jobId: string; message: string }[];
  }> {
    const out: DeleteTx[] = [];
    const failures: { jobId: string; message: string }[] = [];
    const seen = new Set<string>();
    for (const jobId of await this.listJobIds()) {
      let job: Journal | null;
      try {
        job = await this.read(jobId);
      } catch (err) {
        failures.push({ jobId, message: err instanceof Error ? err.message : String(err) });
        continue;
      }
      if (!job || !sameTargetPath(job.targetRoot, targetRoot)) continue;
      for (const tx of this.listDeleteTx(job)) {
        if (seen.has(tx.txId)) continue;
        seen.add(tx.txId);
        out.push(tx);
      }
    }
    return { txs: out, failures };
  }

  async recordDeleteTx(journal: Journal, tx: DeleteTx): Promise<void> {
    const deletes = { ...journal.deletes, [tx.txId]: tx };
    const next = { ...journal, deletes };
    await this.write(next);
    journal.deletes = deletes;
    journal.updatedAt = next.updatedAt;
  }

  async updateDeleteTx(journal: Journal, txId: string, patch: Partial<DeleteTx>): Promise<DeleteTx> {
    const previous = journal.deletes?.[txId];
    if (!previous) throw new Error(`删除事务不存在：${txId}`);
    const tx = { ...previous, ...patch, txId, updatedAt: Date.now() };
    await this.recordDeleteTx(journal, tx);
    return tx;
  }

  async write(journal: Journal): Promise<void> {
    journal.updatedAt = Date.now();
    await writeJsonAtomic(this.jobPath(journal.jobId), journal);
  }

  async setActive(jobId: string): Promise<void> {
    await writeJsonAtomic(this.activePath(), { jobId, updatedAt: Date.now() });
  }

  async getActive(): Promise<Journal | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.activePath(), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const { jobId } = JSON.parse(raw) as { jobId: string };
    if (typeof jobId !== 'string' || !/^[\w-]+$/.test(jobId)) throw new Error('活动任务指针无效');
    const job = await this.read(jobId);
    if (!job || job.jobId !== jobId || !job.tasks) throw new Error('活动任务账本不可读，已禁止覆盖');
    return job;
  }

  async clearActive(expectedJobId?: string): Promise<void> {
    try {
      if (expectedJobId) {
        const active = JSON.parse(await fs.readFile(this.activePath(), 'utf8')) as { jobId: string };
        if (active.jobId !== expectedJobId) throw new Error('活动任务已变化，拒绝清理');
      }
      await fs.unlink(this.activePath());
      await syncDirectory(this.jobsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
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
