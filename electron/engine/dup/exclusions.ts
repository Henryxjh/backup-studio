import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../manifest';
import type { DupExclusion, DupExclusionEntry } from '../../../shared/dup-types';

/**
 * 重复排除名单的持久化。
 *
 * 关键约束：
 * - **本机为权威**。排除名单写本机 userData，不写目标介质——
 *   备份端是用户的恢复点，往里塞工具状态会污染恢复语义。
 * - **绑定源目录**。按源目录分组，换目标介质不失效，换源目录则不误用。
 * - 每条记录带上排除时的哈希与 mtime：下一次扫描只有在 size 与 mtime **同时**吻合时
 *   才允许复用历史哈希，绝不能让过期哈希冒充文件当前内容。
 */
export class ExclusionStore {
  constructor(readonly file: string) {}

  static blank(): DupExclusion {
    return { version: 1, bySource: {}, updatedAt: Date.now() };
  }

  async read(): Promise<DupExclusion | null> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as DupExclusion;
      if (parsed?.version !== 1 || typeof parsed.bySource !== 'object' || parsed.bySource === null) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async write(value: DupExclusion): Promise<void> {
    value.updatedAt = Date.now();
    await writeJsonAtomic(this.file, value);
  }

  /** 某个源目录下的排除记录 */
  async entries(sourceRoot: string): Promise<Record<string, DupExclusionEntry>> {
    const all = await this.read();
    return all?.bySource?.[sourceRoot] ?? {};
  }

  /** 写入一批排除记录；同一路径以新记录覆盖 */
  async put(sourceRoot: string, entries: Record<string, DupExclusionEntry>): Promise<void> {
    const all = (await this.read()) ?? ExclusionStore.blank();
    const current = { ...(all.bySource[sourceRoot] ?? {}) };
    for (const [rel, entry] of Object.entries(entries)) current[rel] = entry;
    await this.write({ ...all, bySource: { ...all.bySource, [sourceRoot]: current } });
  }

  /** 撤销排除；不传 relPaths 表示撤销该源目录下的全部 */
  async remove(sourceRoot: string, relPaths?: string[]): Promise<void> {
    const all = (await this.read()) ?? ExclusionStore.blank();
    const current = { ...(all.bySource[sourceRoot] ?? {}) };
    if (!relPaths) {
      delete all.bySource[sourceRoot];
    } else {
      for (const rel of relPaths) delete current[rel];
      if (Object.keys(current).length === 0) delete all.bySource[sourceRoot];
      else all.bySource[sourceRoot] = current;
    }
    await this.write(all);
  }

  /** 导出文件路径（与本机状态目录同级，避免与备份集混在一起） */
  static reportPath(localDirectory: string): string {
    return path.join(localDirectory, 'duplicate-report');
  }
}
