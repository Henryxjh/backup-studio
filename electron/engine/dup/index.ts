import path from 'node:path';
import { promises as fs } from 'node:fs';
import type {
  DupApi,
  DupEvent,
  DupExclusionEntry,
  DupGroup,
  DupReport,
  DupState,
  DupStatus,
} from '../../../shared/dup-types';
import { readManifest, writeJsonAtomic } from '../manifest';
import { scanTree } from '../scan';
import { checkRoot, inside } from '../aut/config';
import { detectDuplicates, MAX_PREVIEW_GROUPS } from './detect';
import { ExclusionStore } from './exclusions';

export type { DupApi, DupEvent, DupGroup, DupReport, DupState, DupStatus } from '../../../shared/dup-types';

export interface DuplicateFinderOptions {
  /** 排除名单变更时通知宿主：备份侧的旧计划必须立即失效 */
  onExclusionsChanged?: (sourceRoot: string, reason: string) => void;
}

/**
 * 重复文件查找器。
 *
 * 与自动备份（REQ-AUT-001）同构：状态与报告落**本机** `userData`，
 * 目标介质只是被读取的对象，绝不写入——备份端是用户的恢复点，
 * 往里塞工具状态会污染恢复语义。
 *
 * 扫描全程只读：只做 stat / read / 目录遍历，不创建目录、不产生临时件。
 */
export class DuplicateFinder implements DupApi {
  private readonly store: ExclusionStore;
  private readonly options: DuplicateFinderOptions;
  private state: DupState = 'idle';
  private reason: string | undefined;
  private recent: DupEvent[] = [];
  private report: DupReport | null = null;
  /** 全量报告：导出用，不受预览截断影响 */
  private full: DupReport | null = null;
  private sourceRoot = '';
  private cancelled = false;
  private running = false;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly loaded: Promise<void>;

  constructor(readonly localDirectory: string, options: DuplicateFinderOptions = {}) {
    this.store = new ExclusionStore(path.join(localDirectory, 'exclusions.json'));
    this.options = options;
    this.loaded = this.store.read().then(() => undefined, () => undefined);
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const running = this.tail.then(() => this.loaded).then(fn);
    this.tail = running.catch(() => {});
    return running;
  }

  private event(action: string, detail?: string): void {
    this.recent.unshift({ at: Date.now(), action, detail });
    this.recent.length = Math.min(100, this.recent.length);
  }

  /**
   * 排除路径集合，供计划器使用（绑定源目录）。
   *
   * 排除记录以 realpath 为键写入，而计划器拿到的是界面传入的原始路径；
   * 目录联接或符号链接下两者不同，漏匹配会让排除静默失效。
   * 这里把两种形式都算上——匹配不上只是「不排除」，属于安全侧失败。
   */
  async exclusionPaths(sourceRoot: string): Promise<Set<string>> {
    await this.loaded;
    const all = await this.store.read();
    if (!all) return new Set();
    const paths = new Set<string>();
    for (const key of await this.sourceKeys(sourceRoot)) {
      for (const rel of Object.keys(all.bySource[key] ?? {})) paths.add(rel);
    }
    return paths;
  }

  /** 排除名单条目，供报告标注使用 */
  async exclusionEntries(sourceRoot: string): Promise<Record<string, DupExclusionEntry>> {
    await this.loaded;
    const all = await this.store.read();
    if (!all) return {};
    const merged: Record<string, DupExclusionEntry> = {};
    for (const key of await this.sourceKeys(sourceRoot)) {
      Object.assign(merged, all.bySource[key] ?? {});
    }
    return merged;
  }

  /** 源目录的等价键集合：原始路径 + realpath */
  private async sourceKeys(sourceRoot: string): Promise<string[]> {
    const keys = new Set<string>([sourceRoot]);
    try {
      keys.add(await fs.realpath(sourceRoot));
    } catch {
      // 目录不可达时按原样匹配，匹配不上只是不生效
    }
    return [...keys];
  }

  private async view(): Promise<DupStatus> {
    await this.loaded;
    const all = await this.store.read();
    // 尚未扫描时不知道当前源目录，退回展示全部已知排除记录；
    // 扫描过则只展示该源目录下的排除（名单按源目录分组）。
    const entries = this.sourceRoot
      ? all?.bySource?.[this.sourceRoot] ?? {}
      : Object.assign({}, ...Object.values(all?.bySource ?? {}));
    const paths = Object.keys(entries);
    const excludedBytes = paths.reduce((sum, rel) => sum + (entries[rel]?.size ?? 0), 0);
    return {
      state: this.state,
      report: this.report,
      excludedPaths: paths.sort(),
      excludedCount: paths.length,
      excludedBytes,
      recent: this.recent,
      reason: this.reason,
    };
  }

  status = (): Promise<DupStatus> => this.view();

  scan = (sourceRoot: string, targetRoot: string): Promise<DupStatus> =>
    this.run(async () => {
      if (this.running) throw new Error('重复扫描正在执行');
      this.running = true;
      this.cancelled = false;
      this.state = 'scanning';
      this.reason = undefined;
      const started = Date.now();
      try {
        // 路径边界校验：源与目标相同或互相包含时，扫描结果没有意义。
        if (inside(sourceRoot, targetRoot) || inside(targetRoot, sourceRoot)) {
          throw new Error('源目录与备份目录不能相同或互相包含');
        }
        const realSource = await checkRoot(sourceRoot);
        const realTarget = await checkRoot(targetRoot);
        this.sourceRoot = realSource;

        const [source, target, manifest, exclusions] = await Promise.all([
          scanTree(realSource, { excludeMetaDir: false }),
          scanTree(realTarget, { excludeMetaDir: true }),
          readManifest(realTarget),
          this.store.entries(realSource),
        ]);

        this.state = 'hashing';
        const result = await detectDuplicates({
          sourceRoot: realSource,
          targetRoot: realTarget,
          source,
          target,
          manifest,
          exclusions,
          isCancelled: () => this.cancelled,
        });

        if (result.cancelled) {
          this.state = 'idle';
          this.reason = '扫描已取消';
          this.event('扫描已取消');
          return this.view();
        }

        // 覆盖完整性：扫描有不可读子树、或有文件判定失败，都意味着报告不是全量结论。
        // 判定失败的文件「未被判定」，不等于「不重复」——不能拿它冒充完整扫描。
        const complete =
          source.errors.length === 0 && target.errors.length === 0 && result.failures.length === 0;
        const totalCopies = result.groups.reduce((sum, group) => sum + group.copies.length, 0);
        const totalBytes = result.groups.reduce((sum, group) => sum + group.size * group.copies.length, 0);
        const reclaimableBytes = result.groups.reduce((sum, group) => sum + group.reclaimableBytes, 0);

        const build = (groups: DupGroup[]): DupReport => ({
          sourceRoot: realSource,
          targetRoot: realTarget,
          createdAt: Date.now(),
          durationMs: Date.now() - started,
          groups,
          truncated: result.groups.length > groups.length,
          totalGroups: result.groups.length,
          totalCopies,
          totalBytes,
          reclaimableBytes,
          failures: result.failures,
          complete,
          scannedFiles: result.scannedFiles,
          hashedFiles: result.hashedFiles,
          sourceErrors: source.errors.length,
          targetErrors: target.errors.length,
        });

        this.full = build(result.groups);
        this.report = build(result.groups.slice(0, MAX_PREVIEW_GROUPS));
        this.state = 'ready';
        this.event(
          '重复扫描完成',
          `发现 ${result.groups.length} 组重复，可回收 ${reclaimableBytes} 字节`,
        );
        if (!complete) {
          this.reason = '扫描不完整：部分子树不可读，结论仅供参考';
        }
        return this.view();
      } catch (err) {
        this.state = 'error';
        this.reason = err instanceof Error ? err.message : String(err);
        this.event('重复扫描失败', this.reason);
        throw err;
      } finally {
        this.running = false;
      }
    });

  /** 采纳排除：按重复组整组采纳，冗余副本不再写入目标端 */
  adopt = (hashes: string[]): Promise<DupStatus> =>
    this.run(async () => {
      if (!this.full) throw new Error('请先执行重复扫描');
      if (!Array.isArray(hashes) || hashes.length === 0) throw new Error('请选择要排除的重复组');
      const sourceRoot = this.full.sourceRoot;
      const added: Record<string, DupExclusionEntry> = {};
      let count = 0;
      for (const hash of hashes) {
        const group = this.full.groups.find((g) => g.hash === hash);
        if (!group) throw new Error('重复组不存在或已失效，请重新扫描');
        if (!group.adoptable) {
          throw new Error(
            group.zeroByte
              ? '零字节文件不提供排除入口'
              : group.hardLinked
                ? '硬链接副本共享同一份数据，不提供排除入口'
                : '该重复组没有可排除的冗余副本',
          );
        }
        for (const copy of group.redundant) {
          added[copy.relPath] = { hash: group.hash, size: copy.size, mtimeMs: copy.mtimeMs };
          count += 1;
        }
      }
      await this.store.put(sourceRoot, added);
      this.event('已采纳排除', `${count} 个冗余副本不再写入目标端`);
      this.options.onExclusionsChanged?.(sourceRoot, '排除名单已变更，旧备份计划失效，请重新扫描');
      return this.view();
    });

  /** 撤销排除：不给哈希则撤销该源目录下的全部 */
  revoke = (hashes?: string[]): Promise<DupStatus> =>
    this.run(async () => {
      const sourceRoot = this.sourceRoot || this.full?.sourceRoot;
      if (!sourceRoot) throw new Error('尚未扫描，没有可撤销的排除记录');
      const entries = await this.store.entries(sourceRoot);
      let relPaths: string[] | undefined;
      if (hashes && hashes.length) {
        const all = this.full?.groups ?? [];
        relPaths = [];
        for (const hash of hashes) {
          const group = all.find((g) => g.hash === hash);
          if (!group) throw new Error('重复组不存在或已失效，请重新扫描');
          relPaths.push(...group.redundant.map((copy) => copy.relPath));
        }
      }
      const target = relPaths ?? Object.keys(entries);
      await this.store.remove(sourceRoot, target);
      this.event('已撤销排除', `${target.length} 个副本恢复备份`);
      this.options.onExclusionsChanged?.(sourceRoot, '排除名单已变更，旧备份计划失效，请重新扫描');
      return this.view();
    });

  /** 导出全量报告到本机目录；不受界面预览截断影响 */
  exportReport = (format: 'json' | 'csv'): Promise<{ path: string; bytes: number }> =>
    this.run(async () => {
      if (!this.full) throw new Error('请先执行重复扫描');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(this.localDirectory, `duplicate-report-${stamp}.${format === 'csv' ? 'csv' : 'json'}`);
      if (format === 'csv') {
        const rows = ['hash,size,relation,relPath,side,mtimeMs,role'];
        for (const group of this.full.groups) {
          for (const copy of group.copies) {
            const role =
              copy.relPath === group.canonical
                ? 'canonical'
                : group.redundant.some((r) => r.relPath === copy.relPath)
                  ? 'redundant'
                  : 'other';
            rows.push(
              [
                group.hash,
                group.size,
                group.relation,
                JSON.stringify(copy.relPath),
                copy.side,
                copy.mtimeMs,
                role,
              ].join(','),
            );
          }
        }
        const text = `${rows.join('\n')}\n`;
        await fs.mkdir(this.localDirectory, { recursive: true });
        await fs.writeFile(file, text, 'utf8');
        return { path: file, bytes: Buffer.byteLength(text, 'utf8') };
      }
      await writeJsonAtomic(file, this.full);
      const text = JSON.stringify(this.full, null, 2);
      return { path: file, bytes: Buffer.byteLength(text, 'utf8') };
    });

  cancel = (): Promise<DupStatus> =>
    this.run(async () => {
      this.cancelled = true;
      this.event('已请求取消扫描');
      return this.view();
    });
}
