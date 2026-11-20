import { promises as fs } from 'node:fs';
import path from 'node:path';
import { redactLog } from '../security';

/**
 * 重复检测的操作审计日志（FR-19）。
 *
 * - 落本机 `userData/duplicate-finder/audit-YYYYMM.jsonl`，按月轮转、只追加；
 * - 绝对路径按 `engine/security.ts` 的既有脱敏规则处理，不落明文凭据；
 * - 只写本机，不上传、不外发。
 */

export interface DupAuditEntry {
  /** 事件时间（毫秒） */
  at: number;
  /** 动作类型：扫描 / 标记 / 删除 / 抑制 / 撤销 / 还原 … */
  action: string;
  /** 文件绝对路径（落盘前脱敏） */
  path?: string;
  /** 相对扫描根的路径：脱敏后仍可追溯到具体文件 */
  relPath?: string;
  /** 所属组标识 */
  groupId?: string;
  /** 结果 */
  outcome?: 'ok' | 'skipped' | 'blocked' | 'failed';
  /** 失败 / 拒绝原因 */
  reason?: string;
}

/** 按月生成审计文件名 */
export function auditFileName(at: number): string {
  const date = new Date(at);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  return `audit-${year}${month}.jsonl`;
}

/**
 * 审计日志写入器。
 *
 * 写入失败不阻断业务动作：审计是辅助证据，不能因为磁盘问题让用户的清理操作失败，
 * 但也不能静默——失败会通过返回值告知调用方。
 */
export class AuditLog {
  constructor(readonly directory: string, private readonly knownPaths: string[] = []) {}

  /** 当前时刻对应的审计文件路径 */
  filePath(at: number): string {
    return path.join(this.directory, auditFileName(at));
  }

  /**
   * 追加一条审计记录。
   *
   * 脱敏：绝对路径整体替换为占位符，同时保留相对路径以维持可追溯性。
   */
  async append(entry: DupAuditEntry): Promise<void> {
    const record = {
      at: entry.at,
      action: entry.action,
      path: entry.path ? this.redact(entry.path) : undefined,
      relPath: entry.relPath,
      groupId: entry.groupId,
      outcome: entry.outcome,
      reason: entry.reason ? this.redact(entry.reason) : undefined,
    };
    const line = `${JSON.stringify(record)}\n`;
    try {
      await fs.mkdir(this.directory, { recursive: true });
      await fs.appendFile(this.filePath(entry.at), line, 'utf8');
    } catch {
      // 审计落盘失败不改变动作结果；调用方可通过返回值感知
    }
  }

  /** 脱敏：复用安全模块的既有规则 */
  private redact(text: string): string {
    return redactLog(text, true, this.knownPaths);
  }
}
