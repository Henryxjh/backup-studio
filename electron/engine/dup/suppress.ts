import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../manifest';
import type { DupSuppression } from '../../../shared/dup-types';

/**
 * 抑制黑名单（FR-12、FR-13）。
 *
 * 语义与旧版「按路径记录排除名单」**完全不同**：
 * - 键是**内容哈希**，不是路径：同一组文件内容相同，一个哈希即可覆盖整组；
 * - 作用域默认为**当前扫描根**（`scopeMode: 'root'`），可显式选全局；
 * - 清单持久化在本机 `userData`，原子写（临时文件 + fsync + rename）。
 *
 * 命中抑制的组在扫描时**整组跳过**且不计入统计，但在摘要里要报出跳过组数；
 * 执行删除时抑制项同样生效，被抑制的哈希不得进入待删队列。
 */

/** 引擎内部扩展字段：不属于跨进程契约，仅用于备份侧映射与作用域匹配 */
export interface SuppressionRecord extends DupSuppression {
  /** 组内全部成员的绝对路径：备份侧据此换算相对路径 */
  paths?: string[];
  /** 作用域根的真实路径：目录联接/符号链接下与 `scopeRoot` 可能不同 */
  scopeRootReal?: string;
}

/** 落盘格式 */
interface SuppressionFile {
  version: 1;
  updatedAt: number;
  items: SuppressionRecord[];
}

/** 大小写不敏感文件系统（Windows / macOS） */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

/** 归一化根目录：用于作用域比较 */
export function normalizeRoot(root: string): string {
  const resolved = path.resolve(root);
  return CASE_INSENSITIVE_FS ? resolved.toLowerCase() : resolved;
}

/**
 * 判断一条抑制项是否对给定扫描根生效。
 *
 * - `global`：对所有目录生效；
 * - `root`：只在抑制时所在的扫描根下生效（比较原始路径与真实路径两种形式）。
 */
export function suppressionMatches(record: SuppressionRecord, root: string): boolean {
  if (record.scopeMode === 'global') return true;
  if (normalizeRoot(record.scopeRoot) === normalizeRoot(root)) return true;
  if (record.scopeRootReal && normalizeRoot(record.scopeRootReal) === normalizeRoot(root)) return true;
  return false;
}

/**
 * 抑制清单的持久化。
 *
 * 本机为权威：清单只写本机 userData，不写被检测目录，也不上传。
 */
export class SuppressionStore {
  constructor(readonly file: string) {}

  /** 读取全部抑制项；文件损坏时按空清单处理，不阻断扫描 */
  async read(): Promise<SuppressionRecord[]> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as SuppressionFile;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.items)) return [];
      return parsed.items.filter((item) => item && typeof item.sha256 === 'string');
    } catch {
      return [];
    }
  }

  /** 原子写：临时文件 + fsync + rename（复用 manifest 的写法） */
  async write(items: SuppressionRecord[]): Promise<void> {
    const payload: SuppressionFile = { version: 1, updatedAt: Date.now(), items };
    await writeJsonAtomic(this.file, payload);
  }

  /**
   * 写入或覆盖一条抑制项。
   *
   * 同一作用域下的同一哈希视为同一条：重复抑制只更新样例与时间，不产生重复条目。
   */
  async put(record: SuppressionRecord): Promise<SuppressionRecord[]> {
    const items = await this.read();
    const index = items.findIndex(
      (item) => item.sha256 === record.sha256 && item.scopeMode === record.scopeMode && item.scopeRoot === record.scopeRoot,
    );
    if (index >= 0) {
      const merged: SuppressionRecord = {
        ...items[index],
        ...record,
        createdAt: items[index].createdAt,
        hitCount: items[index].hitCount,
      };
      items[index] = merged;
    } else {
      items.push(record);
    }
    await this.write(items);
    return items;
  }

  /**
   * 撤销抑制项。
   *
   * 不传哈希表示撤销全部；撤销后该组下次扫描重新提示。
   */
  async remove(sha256?: string): Promise<{ items: SuppressionRecord[]; removed: number }> {
    const items = await this.read();
    const kept = sha256 ? items.filter((item) => item.sha256 !== sha256) : [];
    const removed = items.length - kept.length;
    await this.write(kept);
    return { items: kept, removed };
  }
}

/**
 * 在清单中查找某哈希对某根生效的抑制项。
 *
 * 找不到返回 undefined；同名哈希但作用域不匹配时**不算命中**——
 * 抑制的作用域不能被悄悄放大。
 */
export function findSuppression(items: SuppressionRecord[], sha256: string, root: string): SuppressionRecord | undefined {
  return items.find((item) => item.sha256 === sha256 && suppressionMatches(item, root));
}

/**
 * 累计命中次数。
 *
 * 命中次数只增不减：它回答「这份内容被隐藏过多少次」，是抑制过度的主要可见指标。
 */
export function bumpHitCount(items: SuppressionRecord[], sha256: string, root: string): SuppressionRecord[] {
  const found = findSuppression(items, sha256, root);
  if (!found) return items;
  found.hitCount += 1;
  return items;
}
