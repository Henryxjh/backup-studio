import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type {
  DupActRequest,
  DupActResult,
  DupApi,
  DupEvent,
  DupFileEntry,
  DupGroup,
  DupItemAction,
  DupProgress,
  DupQuarantineEntry,
  DupQuarantineErrorCode,
  DupScanResult,
  DupScanSummary,
  DupStats,
  DupStatus,
  DupSuppression,
} from '../../../shared/dup-types';
import { DEFAULT_MIN_SIZE_BYTES, scanDupTree } from './scan';
import { detectDuplicates } from './detect';
import {
  executeAct,
  QuarantineIndexError,
  QuarantineStore,
  registryKey,
  type ActRegistryEntry,
  type QuarantineEntry,
} from './act';
import { AuditLog } from './audit';
import {
  SuppressionStore,
  bumpHitCount,
  findSuppression,
  normalizeRoot,
  type SuppressionRecord,
} from './suppress';

export type {
  DupActRequest,
  DupActResult,
  DupApi,
  DupEvent,
  DupGroup,
  DupScanResult,
  DupStatus,
  DupSuppression,
} from '../../../shared/dup-types';
export { DEFAULT_MIN_SIZE_BYTES } from './scan';
export { detectDuplicates, pickGroupKeeper, groupNameConflicts } from './detect';
export { executeAct, QuarantineStore, QuarantineIndexError } from './act';

/** 渲染层预览的分组上限；截断只影响呈现，统计始终基于全量 */
export const MAX_PREVIEW_GROUPS = 2000;

export interface DuplicateFinderOptions {
  /**
   * 回收站落地。
   *
   * 生产环境传 Electron `shell.trashItem`；测试注入假实现。
   * **抛错视为回收站不可用** → 降级到本机隔离区（FR-08）。
   */
  trash?: (absPath: string) => Promise<void>;
  /** 写入闸门；返回 { allowed, reason? }（FR-10） */
  gate?: (root: string) => Promise<{ allowed: boolean; reason?: string }>;
  /** 备份 / 自动同步是否在运行；运行中禁止删除（FR-10） */
  isBusy?: () => boolean;
  /** 本机状态目录；默认取构造函数的 `localDirectory` */
  localDirectory?: string;
  /**
   * 抑制清单变更回调（FR-12、FR-13）。
   *
   * 抑制只影响**检测页的提示**：被抑制的组下次扫描不再出现。
   * 它**不改变备份引擎「写什么」**——规格 §4.2 明确「与备份引擎的自动联动」不做。
   */
  onSuppressionsChanged?: (root: string, reason: string) => void;
  /**
   * 在系统文件管理器中定位文件。
   *
   * 生产环境传 Electron `shell.showItemInFolder`；测试可注入假实现。
   * 引擎只负责**判定路径是否可被定位**（FR-20），真正的系统调用由宿主提供。
   */
  revealFile?: (absPath: string) => void;
}

/** 路径边界校验结果 */
export interface PathVerdict {
  allowed: boolean;
  reason?: string;
}

/** 复合键用于定位删除动作的分组条目；路径级查询必须走独立的绝对路径索引。 */
export function isRegisteredPath(entriesByPath: ReadonlyMap<string, ActRegistryEntry[]>, absPath: string): boolean {
  return entriesByPath.has(path.resolve(absPath));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * CSV 字段转义。
 *
 * 文件名里出现逗号、双引号或换行就会把列结构冲掉，导出的表直接不可用。
 * 按 RFC 4180：含特殊字符时用双引号包起来，内部引号翻倍。
 */
function csvField(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * 重复文件检测与清理的引擎侧实现（REQ-DUP-001）。
 *
 * 与自动备份（REQ-AUT-001）同构：状态、抑制清单、审计与隔离区全部落**本机** userData，
 * 被检测目录只是被读取的对象，绝不写入——检测阶段零写副作用。
 *
 * 删除是唯一的写动作，因此它必须过写入闸门、与备份互斥、逐条二次校验，
 * 并且**只进回收站**（FR-08）。
 */
export class DuplicateFinder extends EventEmitter implements DupApi {
  private readonly options: DuplicateFinderOptions;
  /** 本机状态目录 */
  readonly localDirectory: string;
  private readonly store: SuppressionStore;
  private readonly auditLog: AuditLog;
  private readonly quarantine: QuarantineStore;

  private phase: DupStatus['phase'] = 'idle';
  private progress: DupProgress = { phase: 'idle', label: '待命', done: 0, total: 0, bytesRead: 0, throughputBps: 0 };
  private result: DupScanResult | null = null;
  /** 全量结果：导出用，不受预览截断影响 */
  private fullResult: DupScanResult | null = null;
  private recent: DupEvent[] = [];
  private reason: string | undefined;
  private blockedReason: string | undefined;
  private suppressionItems: SuppressionRecord[] = [];
  /** 隔离区条目快照：渲染层据此展示还原入口（FR-08） */
  private quarantineSnapshot: DupQuarantineEntry[] = [];
  /**
   * 隔离区索引不可读的原因（**唯一一份**状态）。
   *
   * 索引坏掉时**不得**把清单当成空的：那会让用户以为文件已经没了。
   * 刷新本身永不抛错（删除已经真实发生，不能因此报成失败），
   * 原因记在这里：`status()` 与 `listQuarantine()` 共用它，
   * 只读状态的调用方也要能看到「索引不可读」。
   */
  private quarantineError: { code: DupQuarantineErrorCode; message: string } | undefined;
  /**
   * 已还原的隔离区条目 id。
   *
   * 条目仍留在索引里时（索引写失败等异常），界面据此禁用还原按钮——
   * 否则那个按钮永远点不出结果（FR-08）。
   */
  private restoredQuarantineIds = new Set<string>();
  /** 扫描结果登记表：绝对路径 + 组 id → 删除动作使用的条目（FR-11） */
  private registry = new Map<string, ActRegistryEntry>();
  /** 路径级查询索引（FR-20）；同一路径可属于多个组。 */
  private entriesByPath = new Map<string, ActRegistryEntry[]>();
  /** 组 → 组内全部条目 id（FR-11 至少留一份） */
  private groupMembers = new Map<string, string[]>();
  private currentRoot = '';
  /**
   * 操作序号：每次「扫描 / 执行删除」在**请求时**分配一个递增序号。
   *
   * 取消请求可能早于操作真正启动到达（用户点取消的瞬间，扫描还在排队），
   * 若取消只改一个布尔量，扫描开头会把它重置掉，取消就丢了。
   * 改用序号比对，取消就一定能落到「用户当时看到的那一次操作」上（FR-15）。
   */
  private operationToken = 0;
  /** 被请求取消的操作序号 */
  private cancelToken = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly loaded: Promise<void>;
  private progressStartedAt = Date.now();

  constructor(localDirectory: string, options: DuplicateFinderOptions = {}) {
    super();
    this.options = options;
    this.localDirectory = options.localDirectory ?? localDirectory;
    this.store = new SuppressionStore(path.join(this.localDirectory, 'suppressions.json'));
    this.auditLog = new AuditLog(this.localDirectory, [this.localDirectory]);
    this.quarantine = new QuarantineStore(path.join(this.localDirectory, 'quarantine'));
    this.loaded = this.store
      .read()
      .then((items) => {
        this.suppressionItems = items;
      })
      .catch(() => undefined);
  }

  /** 串行化操作：扫描、动作、持久化之间不允许并发交错 */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const running = this.tail.then(() => this.loaded).then(fn);
    this.tail = running.catch(() => undefined);
    return running;
  }

  /** 记录一条内存事件（界面最近事件流） */
  private event(action: string, detail?: string, outcome?: DupEvent['outcome']): void {
    this.recent.unshift({ at: Date.now(), action, detail, outcome });
    this.recent.length = Math.min(100, this.recent.length);
    this.emit('event', this.recent[0]);
  }

  /** 审计日志：只写本机，绝对路径按安全模块规则脱敏 */
  private audit(entry: Parameters<AuditLog['append']>[0]): Promise<boolean> {
    return this.auditLog.append(entry);
  }

  /** 更新阶段进度：已处理/总数、已读字节、吞吐与预计剩余 */
  private setProgress(phase: DupProgress['phase'], label: string, done: number, total: number, bytesRead: number): void {
    // 取消是终态：迟到��进度回调不得把相位改回「局部哈希」，
    // 否则用户点了取消，界面却又显示扫描在跑（FR-15）。
    // 只压制「被取消的那一次操作」的迟到回调：新操作会推进 operationToken，不受影响。
    if (this.phase === 'cancelled' && this.cancelToken === this.operationToken) return;
    const now = Date.now();
    const elapsedMs = Math.max(1, now - this.progressStartedAt);
    const throughputBps = bytesRead > 0 ? Math.round((bytesRead / elapsedMs) * 1000) : 0;
    const etaMs = done > 0 && total > done ? Math.round(((total - done) / done) * elapsedMs) : undefined;
    this.phase = phase;
    this.progress = { phase, label, done, total, bytesRead, throughputBps, etaMs };
    this.emit('progress', this.progress);
  }

  /** 刷新「删除是否被禁止」：备份或自动同步运行中一律禁用（FR-10） */
  private refreshBlocked(): void {
    if (this.options.isBusy?.()) {
      this.blockedReason = '备份任务或自动同步正在运行，删除动作已禁用';
    } else {
      this.blockedReason = undefined;
    }
  }

  private view(): DupStatus {
    this.refreshBlocked();
    return {
      phase: this.phase,
      progress: this.progress,
      result: this.result,
      suppressions: this.suppressionItems.map(toSuppression),
      recent: this.recent,
      reason: this.reason,
      blockedReason: this.blockedReason,
      // 「失败」阶段允许重试：被闸门挡下的条目在介质恢复后应当还能再执行一次，
      // 不能因为上一轮失败就把入口永久关掉。
      canAct: (this.phase === 'ready' || this.phase === 'done' || this.phase === 'failed') && !this.blockedReason,
      currentRoot: this.currentRoot || undefined,
      quarantine: this.quarantineSnapshot,
      // 索引不可读时只读状态也必须带上原因：调用方不该只有 listQuarantine 才看得见
      quarantineError: this.quarantineError,
    };
  }

  /**
   * 当前状态：**只读快照，不进操作队列**。
   *
   * 进队列的话，扫描进行中查询状态会被正在跑的扫描本身挡住——
   * 界面轮询拿到的永远是「扫描结束那一刻」的状态，
   * 五阶段进度就永远看不到（FR-15）。
   */
  status = async (): Promise<DupStatus> => {
    await this.loaded;
    return this.view();
  };

  /**
   * 扫描一个目录（FR-02）。
   *
   * 语义边界：只读扫描；跳过符号链接、0 字节文件与低于阈值的文件；
   * 扫描期间对被检测目录不产生任何写副作用。
   */
  scan = (root: string, options?: { minSizeBytes?: number }): Promise<DupStatus> => {
    // 操作序号在「请求时」分配：取消请求可能早于扫描真正启动到达，
    // 若等到执行体里再分配序号，那次取消就会被扫描开头的重置冲掉（FR-15）。
    const token = ++this.operationToken;
    return this.run(async () => {
      if (typeof root !== 'string' || !root.trim()) throw new Error('请选择要检测重复文件的目录');
      const resolved = path.resolve(root);
      let stat: import('node:fs').Stats;
      try {
        stat = await fs.stat(resolved);
      } catch (err) {
        throw new Error(`无法访问所选目录：${errorText(err)}`);
      }
      if (!stat.isDirectory()) throw new Error('所选路径不是目录');
      this.reason = undefined;
      this.result = null;
      this.fullResult = null;
      this.registry = new Map();
      this.entriesByPath = new Map();
      this.groupMembers = new Map();
      this.currentRoot = resolved;
      this.progressStartedAt = Date.now();
      this.setProgress('scanning', '扫描目录', 0, 0, 0);
      const started = Date.now();

      const scanned = await scanDupTree(resolved, {
        minSizeBytes: options?.minSizeBytes ?? DEFAULT_MIN_SIZE_BYTES,
        isCancelled: () => this.cancelToken === token,
        onProgress: (done, total) => this.setProgress('scanning', '扫描目录', done, total, 0),
      });

      if (scanned.cancelled || this.cancelToken === token) {
        this.reason = '扫描已取消';
        this.event('扫描已取消');
        await this.audit({ at: Date.now(), action: '扫描取消', outcome: 'skipped', reason: '用户取消' });
        // 终态在所有 await 之后再落：审计写入期间仍有哈希工作项在回调，
        // 提前落终态会被迟到回调改回「局部哈希」（FR-15）。
        this.phase = 'cancelled';
        return this.view();
      }

      this.progressStartedAt = Date.now();
      // 命中抑制的哈希：累计命中次数并落盘（FR-13）
      const suppressedHashes = new Set<string>();
      const detected = await detectDuplicates({
        root: resolved,
        candidates: scanned.candidates,
        isCancelled: () => this.cancelToken === token,
        onProgress: (update) => {
          if (update.phase !== this.progress.phase) this.progressStartedAt = Date.now();
          this.setProgress(update.phase, update.label, update.done, update.total, update.bytesRead);
        },
        isSuppressed: (hash) => Boolean(findSuppression(this.suppressionItems, hash, resolved)),
        onSuppressed: (hash) => {
          suppressedHashes.add(hash);
        },
      });

      if (suppressedHashes.size > 0) {
        for (const hash of suppressedHashes) bumpHitCount(this.suppressionItems, hash, resolved);
        await this.store.write(this.suppressionItems);
      }

      if (detected.cancelled || this.cancelToken === token) {
        this.reason = '扫描已取消（保留已完成的判定结果）';
        this.event('扫描已取消');
        await this.audit({ at: Date.now(), action: '扫描取消', outcome: 'skipped', reason: '用户取消' });
        // 终态在所有 await 之后再落：审计写入期间仍有哈希工作项在回调，
        // 提前落终态会被迟到回调改回「局部哈希」（FR-15）。
        this.phase = 'cancelled';
        return this.view();
      }

      // 汇总阶段：分阶段可见是硬要求（FR-15）
      this.setProgress('summarizing', '汇总', 0, 0, detected.bytesRead);

      const summary: DupScanSummary = {
        root: resolved,
        totalFiles: scanned.totalFiles,
        scannedBytes: scanned.scannedBytes,
        skippedEmpty: scanned.skippedEmpty,
        skippedTooSmall: scanned.skippedTooSmall,
        skippedSymlink: scanned.skippedSymlink,
        skippedSuppressed: detected.skippedSuppressed,
        identicalGroups: detected.identicalGroups.length,
        nameConflictGroups: detected.nameConflictGroups.length,
        suspectedGroups: detected.suspectedGroups.length,
        durationMs: Date.now() - started,
      };

      const allGroups = [...detected.identicalGroups, ...detected.suspectedGroups, ...detected.nameConflictGroups];
      const stats = computeStats(allGroups);
      const complete = scanned.errors.length === 0 && detected.failures.length === 0;
      const truncated = allGroups.length > MAX_PREVIEW_GROUPS;

      const full: DupScanResult = {
        root: resolved,
        summary,
        groups: allGroups,
        identicalGroups: detected.identicalGroups,
        suspectedGroups: detected.suspectedGroups,
        nameConflictGroups: detected.nameConflictGroups,
        failures: detected.failures,
        stats,
        complete,
        truncated,
      };
      this.fullResult = full;
      this.result = truncated
        ? {
            ...full,
            groups: allGroups.slice(0, MAX_PREVIEW_GROUPS),
            identicalGroups: detected.identicalGroups.slice(0, MAX_PREVIEW_GROUPS),
            suspectedGroups: detected.suspectedGroups.slice(0, MAX_PREVIEW_GROUPS),
            nameConflictGroups: detected.nameConflictGroups.slice(0, MAX_PREVIEW_GROUPS),
          }
        : full;

      this.buildRegistry(allGroups);
      // 取消优先于完成：用户在扫描途中点了取消，就不能报「完成」（FR-15）。
      if (this.cancelToken === token) {
        this.phase = 'cancelled';
        this.reason = '扫描已取消（保留已完成的判定结果）';
        this.setProgress('cancelled', '已取消', allGroups.length, allGroups.length, detected.bytesRead);
        this.event('扫描已取消', undefined, 'skipped');
        await this.audit({ at: Date.now(), action: '扫描取消', outcome: 'skipped', reason: '用户取消' });
        return this.view();
      }
      this.phase = 'ready';
      this.setProgress('ready', '完成', allGroups.length, allGroups.length, detected.bytesRead);
      this.event(
        '扫描完成',
        `发现 ${detected.identicalGroups.length} 组内容重复、${detected.nameConflictGroups.length} 组同名不同内容、${detected.suspectedGroups.length} 组疑似重复`,
        'ok',
      );
      await this.audit({
        at: Date.now(),
        action: '扫描',
        outcome: 'ok',
        reason: `文件 ${summary.totalFiles} 个，重复组 ${summary.identicalGroups} 个，因抑制跳过 ${summary.skippedSuppressed} 组`,
      });
      if (!complete) {
        this.reason = '扫描不完整：部分文件不可读或判定失败，结论仅供参考';
      }
      return this.view();
    });
  }

  /** 建立扫描结果登记表与分组成员表（FR-11、FR-20） */
  private buildRegistry(groups: DupGroup[]): void {
    this.registry = new Map();
    this.entriesByPath = new Map();
    this.groupMembers = new Map();
    for (const group of groups) {
      const ids: string[] = [];
      for (const entry of group.entries) {
        // 键里带组 id：同一个文件可能同时出现在内容重复组与同名告警组，
        // 只用绝对路径做键会让后写入的组覆盖前一个，硬约束就会用错组。
        const registered: ActRegistryEntry = {
          id: entry.id,
          absPath: entry.absPath,
          relPath: entry.relPath,
          sha256: entry.sha256,
          size: entry.size,
          dev: entry.dev,
          ino: entry.ino,
          suspected: entry.suspected,
          groupId: group.id,
          category: group.category,
        };
        this.registry.set(registryKey(entry.absPath, group.id), registered);
        const resolved = path.resolve(entry.absPath);
        const entries = this.entriesByPath.get(resolved);
        if (entries) entries.push(registered);
        else this.entriesByPath.set(resolved, [registered]);
        ids.push(entry.id);
      }
      this.groupMembers.set(group.id, ids);
    }
  }

  /** 断言请求针对的扫描根与当前扫描一致 */
  private assertRoot(root: string): void {
    if (typeof root !== 'string' || !root.trim()) throw new Error('缺少扫描根');
    if (normalizeRoot(root) !== normalizeRoot(this.currentRoot)) {
      throw new Error('当前扫描根与请求不一致，请重新扫描');
    }
  }

  /** 当前扫描结果中登记的绝对路径集合（主进程校验用） */
  knownEntries(root: string): ReadonlySet<string> {
    if (normalizeRoot(root) !== normalizeRoot(this.currentRoot)) return new Set<string>();
    return new Set(this.entriesByPath.keys());
  }

  /**
   * 校验一个路径是否可被主进程操作（reveal 等）。
   *
   * 语义边界：必须落在本次扫描根之内，**且**确实是本次扫描结果中的条目。
   */
  verifyEntry = async (root: string, absPath: string): Promise<PathVerdict> => {
    if (typeof absPath !== 'string' || !absPath.trim()) return { allowed: false, reason: '路径无效' };
    if (normalizeRoot(root) !== normalizeRoot(this.currentRoot)) return { allowed: false, reason: '当前没有匹配的扫描结果，请重新扫描' };
    const resolved = path.resolve(absPath);
    const relative = path.relative(this.currentRoot, resolved);
    // 越界判定只看「上一级」本身：`..foo.txt` 这类合法条目名不能被误判为越界。
    const outsideRoot = relative === '..' || relative.startsWith(`..${path.sep}`);
    if (!relative || outsideRoot || path.isAbsolute(relative)) {
      return { allowed: false, reason: '路径不在本次扫描根目录之内' };
    }
    if (!isRegisteredPath(this.entriesByPath, resolved)) {
      return { allowed: false, reason: '路径不在本次扫描结果内，已拒绝' };
    }
    try {
      await fs.stat(resolved);
    } catch {
      return { allowed: false, reason: '文件已不存在或不可访问' };
    }
    return { allowed: true };
  };

  /**
   * 以「当前扫描根」为基准校验一个路径。
   *
   * 供主进程的 `app:reveal` 使用：渲染层只给路径，判定依据始终在主进程，
   * 且只能命中本次扫描结果中的真实条目（FR-14、FR-20）。
   */
  verifyScannedPath = async (absPath: string): Promise<PathVerdict> => {
    if (!this.currentRoot) return { allowed: false, reason: '当前没有扫描结果，请先执行重复文件检测' };
    return this.verifyEntry(this.currentRoot, absPath);
  };

  /**
   * 受校验的「定位文件」（FR-14、FR-20）。
   *
   * 路径必须落在本次扫描根之内**且**是本次扫描结果中的真实条目；
   * 文件已不存在或不可访问时抛出明确错误，**不静默失败**。
   * 真正「打开系统文件管理器」的动作由注入的 `revealFile` 完成——
   * 引擎不直接依赖 Electron，测试里可注入假实现。
   */
  reveal = async (root: string, absPath: string): Promise<{ revealed: boolean }> => {
    const verdict = await this.verifyEntry(root, absPath);
    if (!verdict.allowed) throw new Error(verdict.reason ?? '路径校验未通过，已拒绝定位');
    if (!this.options.revealFile) throw new Error('当前环境不支持在文件管理器中定位');
    this.options.revealFile(path.resolve(absPath));
    return { revealed: true };
  };

  /**
   * 逐条标记动作（FR-06）。
   *
   * 三个动作互斥：保留 / 删除 / 下次不提醒。
   * 动作只在本次会话内作用于列表状态，持久化只保存抑制项与审计日志。
   */
  markAction = (root: string, itemIds: string[], action: DupItemAction): Promise<DupStatus> =>
    this.run(async () => {
      this.assertRoot(root);
      const result = this.result;
      if (!result) throw new Error('尚未扫描，没有可标记的结果');
      if (!Array.isArray(itemIds) || itemIds.length === 0) throw new Error('请选择要标记的条目');
      if (action !== 'keep' && action !== 'delete' && action !== 'suppress') throw new Error('无效的动作');

      const suppressed: DupGroup[] = [];
      for (const itemId of itemIds) {
        for (const group of result.groups) {
          const entry = group.entries.find((item) => item.id === itemId);
          if (!entry) continue;
          if (action === 'keep') {
            entry.state = 'kept';
            entry.note = '已保留';
          } else if (action === 'delete') {
            entry.state = 'queued';
            entry.note = '已进入待删队列';
          } else {
            await this.addSuppression(root, group, entry);
            suppressed.push(group);
          }
        }
      }

      if (suppressed.length > 0) {
        this.dropGroups(suppressed);
      }
      this.refreshStats();
      this.event('标记动作', `${action} × ${itemIds.length} 条`);
      await this.audit({ at: Date.now(), action: `标记:${action}`, outcome: 'ok', reason: `${itemIds.length} 条` });
      return this.view();
    });

  /**
   * 组级动作：保留此份，其余可删（FR-07）。
   *
   * 组主只是建议：这里执行的是用户显式指定的保留项。
   */
  keepGroup = (root: string, groupId: string, keeperId: string): Promise<DupStatus> =>
    this.run(async () => {
      this.assertRoot(root);
      const result = this.result;
      if (!result) throw new Error('尚未扫描，没有可操作的结果');
      const group = result.groups.find((item) => item.id === groupId);
      if (!group) throw new Error('该组不存在或已失效，请重新扫描');
      const keeper = group.entries.find((item) => item.id === keeperId);
      if (!keeper) throw new Error('保留项不在该组内');
      for (const entry of group.entries) {
        if (entry.id === keeper.id) {
          entry.state = 'kept';
          entry.note = '已保留';
        } else {
          entry.state = 'queued';
          entry.note = '已进入待删队列';
        }
      }
      this.refreshStats();
      this.event('保留此份', `其余 ${group.entries.length - 1} 份进入待删队列`);
      await this.audit({ at: Date.now(), action: '保留此份', groupId, outcome: 'ok', reason: keeper.relPath });
      return this.view();
    });

  /**
   * 执行删除（FR-08 ~ FR-11、FR-20、FR-21）。
   *
   * 逐条独立：任何一条的校验失败或落地失败都不影响其余条目。
   */
  act = (root: string, request: DupActRequest): Promise<DupActResult> => {
    // 与扫描同一套序号语义：取消只影响「用户看到的那一次执行」（FR-15）
    const token = ++this.operationToken;
    return this.run(async () => {
      this.assertRoot(root);
      if (!request || !Array.isArray(request.items)) throw new Error('删除请求格式无效');
      if (request.items.length === 0) throw new Error('请先选择要删除的文件');
      // 阶段校验放在主进程侧：取消后的结果不完整，此时执行删除等于按残缺名单删文件。
      // 渲染层虽然也会关掉入口，但主进程必须自己兜住这条底线。
      if (this.phase !== 'ready' && this.phase !== 'done' && this.phase !== 'failed') {
        throw new Error('当前状态不允许执行删除，请重新检测后再试');
      }
      this.refreshBlocked();
      if (this.blockedReason) throw new Error(this.blockedReason);
      this.phase = 'acting';
      this.setProgress('acting', '执行删除', 0, request.items.length, 0);

      let outcome: DupActResult;
      try {
        outcome = await executeAct({
          root: this.currentRoot,
          items: request.items,
          category: request.category,
          confirmSameNameConflict: request.confirmSameNameConflict === true,
          registry: this.registry,
          groupMembers: this.groupMembers,
          gate: this.options.gate,
          isBusy: this.options.isBusy,
          trash: this.options.trash,
          quarantineDirectory: path.join(this.localDirectory, 'quarantine'),
          isSuppressed: (hash) => Boolean(findSuppression(this.suppressionItems, hash, this.currentRoot)),
          audit: (entry) => this.audit(entry),
          isCancelled: () => this.cancelToken === token,
        });
      } catch (err) {
        // 执行层整体抛错（如闸门探测本身失败）时，阶段必须退回可操作态，
        // 否则页面会永远卡在「执行中」，用户再也无法重试。
        this.phase = 'failed';
        this.reason = `删除未能开始：${err instanceof Error ? err.message : String(err)}`;
        this.setProgress('failed', '执行失败', 0, request.items.length, 0);
        this.event('删除未能开始', this.reason, 'failed');
        throw err;
      }

      await this.refreshQuarantine();

      // 逐条回写条目状态：结果必须与界面所见一致
      for (const item of outcome.items) {
        const entry = this.findEntry(item.id);
        if (!entry) continue;
        if (item.outcome === 'deleted') entry.state = 'deleted';
        else if (item.outcome === 'skipped-changed') entry.state = 'skipped';
        else if (item.outcome === 'blocked') entry.state = 'blocked';
        else entry.state = 'failed';
        entry.note = item.reason;
      }

      this.refreshStats();
      const failed = outcome.failed + outcome.blocked;
      if (this.cancelToken === token) {
        // 取消后不得报完成（FR-15）
        this.phase = 'cancelled';
        this.reason = '已取消，部分条目未处理';
      } else if (failed > 0) {
        this.phase = 'failed';
        this.reason = `有 ${failed} 个文件未被删除（被拒绝或失败），详见逐条结果`;
      } else {
        this.phase = 'done';
        this.reason = undefined;
      }
      this.setProgress(this.phase, '执行完成', outcome.items.length, outcome.items.length, 0);
      this.event(
        '删除执行完成',
        `成功 ${outcome.deleted}，跳过 ${outcome.skipped}，被拒 ${outcome.blocked}，失败 ${outcome.failed}`,
        failed > 0 ? 'failed' : 'ok',
      );
      if (outcome.auditFailed) {
        // 审计写失败不影响删除结果，但必须让用户知道「这次动作没有落到审计里」
        this.event('审计日志写入失败', '部分动作未记入审计日志', 'failed');
      }
      return outcome;
    });
  }

  /**
   * 抑制：把内容哈希写入黑名单（FR-12）。
   *
   * 命中抑制的组在下次扫描时整组跳过；撤销后重新提示。
   */
  suppress = (root: string, sha256: string, scopeMode: 'root' | 'global', samplePaths: string[]): Promise<DupStatus> =>
    this.run(async () => {
      this.assertRoot(root);
      if (typeof sha256 !== 'string' || !/^[0-9a-f]{16,}$/i.test(sha256)) throw new Error('内容哈希无效');
      if (scopeMode !== 'root' && scopeMode !== 'global') throw new Error('抑制作用域无效');
      const result = this.result;
      const group = result?.groups.find((item) => item.sha256 === sha256);
      await this.writeSuppression(root, sha256, scopeMode, group, samplePaths ?? []);
      if (group) this.dropGroups([group]);
      this.refreshStats();
      this.event('下次不提醒', `已抑制 ${sha256.slice(0, 8)}`);
      await this.audit({ at: Date.now(), action: '抑制', outcome: 'ok', reason: `${sha256.slice(0, 8)}（${scopeMode}）` });
      return this.view();
    });

  /** 抑制清单（FR-13）：只读快照，不进操作队列 */
  listSuppressions = async (root: string): Promise<DupSuppression[]> => {
    await this.loaded;
    void root;
    return this.suppressionItems.map(toSuppression);
  };

  /**
   * 撤销抑制项（FR-13）。
   *
   * 不传哈希表示撤销全部；撤销后该组下次扫描重新提示。
   */
  revokeSuppression = (sha256?: string): Promise<DupStatus> =>
    this.run(async () => {
      const result = await this.store.remove(sha256);
      this.suppressionItems = result.items;
      this.event('撤销抑制', `撤销 ${result.removed} 条`);
      this.options.onSuppressionsChanged?.(this.currentRoot, '抑制清单已变更，旧备份计划失效，请重新扫描');
      await this.audit({ at: Date.now(), action: '撤销抑制', outcome: 'ok', reason: `${result.removed} 条` });
      return this.view();
    });

  /** 导出全量报告到本机文件（不受预览截断影响） */
  exportReport = (format: 'json' | 'csv'): Promise<{ path: string; bytes: number }> =>
    this.run(async () => {
      const full = this.fullResult;
      if (!full) throw new Error('尚未扫描，没有可导出的报告');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await fs.mkdir(this.localDirectory, { recursive: true });
      if (format === 'csv') {
        const rows = ['groupId,category,fingerprint,groupSize,reclaimableBytes,absPath,relPath,fileName,size,mtimeMs,state'];
        for (const group of full.groups) {
          for (const entry of group.entries) {
            rows.push(
              [
                group.id,
                group.category,
                group.fingerprint,
                group.size,
                group.reclaimableBytes,
                csvField(entry.absPath),
                csvField(entry.relPath),
                csvField(entry.fileName),
                entry.size,
                entry.mtimeMs,
                csvField(entry.state),
              ].join(','),
            );
          }
        }
        const text = `${rows.join('\n')}\n`;
        const file = path.join(this.localDirectory, `duplicate-report-${stamp}.csv`);
        await fs.writeFile(file, text, 'utf8');
        return { path: file, bytes: Buffer.byteLength(text, 'utf8') };
      }
      const file = path.join(this.localDirectory, `duplicate-report-${stamp}.json`);
      const text = JSON.stringify(full, null, 2);
      await fs.writeFile(file, text, 'utf8');
      return { path: file, bytes: Buffer.byteLength(text, 'utf8') };
    });

  /**
   * 还原隔离区中的文件。
   *
   * 还原是一次真实写入，因此与备份走同一套写入闸门：
   * 介质不可写或处于隔离观察时必须拒绝，而不是硬写。
   * 闸门判定的是**还原目标所在目录**（文件原来所在的位置），不是扫描根——
   * 还原写回原路径，可写性只看那个目录。
   * 目标位置已被占用时默认拒绝，需要用户显式确认覆盖（FR-08）。
   */
  restoreQuarantine = (id: string, overwrite = false): Promise<{ restored: boolean; path?: string; reason?: string }> =>
    this.run(async () => {
      if (typeof id !== 'string' || !id.trim()) throw new Error('隔离区记录标识无效');
      // 闸门由隔离区层调用：那里先做路径边界校验（assertInsideQuarantine），
      // 校验通过后才取 path.dirname(entry.originalPath) 交给闸门，
      // 避免拿一条非法路径去探测介质。
      const configuredGate = this.options.gate;
      let gateVerdict: { allowed: boolean; reason?: string } | undefined;
      const gate = configuredGate
        ? async (root: string): Promise<{ allowed: boolean; reason?: string }> => {
            const verdict = await configuredGate(root);
            gateVerdict = verdict;
            return verdict;
          }
        : undefined;
      let result: { restored: boolean; path?: string; reason?: string };
      try {
        result = await this.quarantine.restore(id, overwrite, gate);
      } catch (err) {
        // 索引不可信（读失败 / 解析失败 / 版本不符 / 条目非法）必须如实抛出：
        // 清单此刻不可读，界面不能继续假装隔离区是空的。
        // **原始错误码必须保留**：跨 IPC 之后调用方要靠 code 区分失败类别，
        // 不能只拿到一段中文再靠正则剥前缀。
        if (err instanceof QuarantineIndexError) {
          this.quarantineError = { code: err.code, message: err.message };
        }
        throw err;
      }
      if (result.restored) this.restoredQuarantineIds.add(id);
      await this.refreshQuarantine();
      this.event(result.restored ? '已还原隔离文件' : '还原失败', result.reason ?? result.path);
      if (!result.restored && gateVerdict && !gateVerdict.allowed) {
        await this.audit({
          at: Date.now(),
          action: '还原被闸门阻断',
          outcome: 'blocked',
          reason: result.reason,
        });
      } else {
        await this.audit({
          at: Date.now(),
          action: '还原隔离文件',
          outcome: result.restored ? 'ok' : 'failed',
          reason: result.reason ?? result.path,
        });
      }
      return result;
    });

  /**
   * 列出本机隔离区条目（FR-08）。
   *
   * 隔离区里的文件是**已经从原处移走**的：没有这条列表，
   * 用户重启之后就再也找不到它们，也无从还原。
   *
   * 索引读不出来时**抛错**，不返回空清单：空清单等于告诉用户「文件都没了」。
   *
   * 抛出的错误**保留原始错误码**（read-failed / parse-failed / version-mismatch /
   * schema-invalid / entry-invalid）：跨 IPC 之后调用方要靠 `error.code`
   * 区分失败类别，而不是解析中文。
   */
  listQuarantine = async (): Promise<DupQuarantineEntry[]> => {
    await this.loaded;
    await this.refreshQuarantine();
    const failure = this.quarantineError;
    if (failure) {
      throw new QuarantineIndexError(failure.code, `隔离区不可读取：${failure.message}`);
    }
    return this.quarantineSnapshot;
  };

  /**
   * 从隔离区索引刷新快照。
   *
   * **永不抛错**：删除已经真实发生，索引读不出来不能把这次删除报成失败。
   * 读失败时保留上一次快照，原因记进 quarantineError（由 status() 与 listQuarantine() 共用）。
   */
  private async refreshQuarantine(): Promise<void> {
    let entries: QuarantineEntry[];
    try {
      entries = await this.quarantine.list();
    } catch (err) {
      this.quarantineError =
        err instanceof QuarantineIndexError
          ? { code: err.code, message: err.message }
          : { code: 'read-failed', message: errorText(err) };
      return;
    }
    const snapshot: DupQuarantineEntry[] = [];
    for (const entry of entries) {
      const item: DupQuarantineEntry = {
        id: entry.id,
        originalPath: entry.originalPath,
        size: entry.size,
        deletedAt: entry.createdAt,
        // 已还原 / 实体缺失都要如实写出来：界面据此禁用还原按钮，
        // 否则那个按钮会永远点不出结果（FR-08）。
        restored: this.restoredQuarantineIds.has(entry.id),
      };
      const checked = await this.quarantine.checkStored(entry);
      if (checked.missing) item.missing = true;
      if (checked.reason) item.unavailableReason = checked.reason;
      snapshot.push(item);
    }
    this.quarantineSnapshot = snapshot;
    this.quarantineError = undefined;
  }

  /**
   * 取消扫描或取消剩余删除项（FR-15）。
   *
   * **不进操作队列**：取消必须立即生效，不能排在正在执行的扫描/删除之后。
   * 取消后状态为 `cancelled`，**不得报完成**。
   */
  cancel = async (): Promise<DupStatus> => {
    // 取消落到「当前这次操作」上：即便它还在排队，也会被这次取消命中。
    this.cancelToken = this.operationToken;
    // 取消优先于完成：扫描途中点了取消就不能报完成（FR-15）。
    // 但**已经跑完**的结果是完整的——此时再点取消不该把一份完整结果改成「不完整」，
    // 否则用户白白丢掉可用结果，只能重新检测。
    // 「刚好跑完」的竞态由扫描自身的 cancelToken 检查兜住（见 scan 末尾）。
    const inFlight: DupStatus['phase'][] = [
      'scanning',
      'bucketing',
      'partial-hashing',
      'hashing',
      'summarizing',
      'acting',
    ];
    if (inFlight.includes(this.phase)) {
      this.phase = 'cancelled';
      this.reason = '已取消，本次检测结果不完整，可重新检测';
    }
    this.event('已请求取消');
    await this.audit({ at: Date.now(), action: '请求取消', outcome: 'skipped', reason: '用户取消' });
    return this.view();
  };

  // ---- 内部辅助 ----

  /** 写入一条抑制项；只落本机清单，不通知也不影响备份引擎（§4.2 非目标） */
  private async addSuppression(root: string, group: DupGroup, entry: DupFileEntry): Promise<void> {
    const sha256 = group.sha256 ?? entry.sha256;
    await this.writeSuppression(root, sha256, 'root', group, group.entries.map((item) => item.absPath));
  }

  /** 抑制项落盘：内容哈希为键，作用域默认为当前扫描根 */
  private async writeSuppression(
    root: string,
    sha256: string,
    scopeMode: 'root' | 'global',
    group: DupGroup | undefined,
    samplePaths: string[],
  ): Promise<void> {
    const scopeRoot = scopeMode === 'global' ? root : this.currentRoot;
    let scopeRootReal = scopeRoot;
    try {
      scopeRootReal = await fs.realpath(scopeRoot);
    } catch {
      scopeRootReal = scopeRoot;
    }
    const paths = group ? group.entries.map((entry) => entry.absPath) : samplePaths;
    const record: SuppressionRecord = {
      sha256,
      fingerprint: sha256.slice(0, 8),
      scopeRoot,
      scopeMode,
      createdAt: Date.now(),
      hitCount: 0,
      samplePaths: (samplePaths.length ? samplePaths : paths).slice(0, 5),
      sampleFileNames: (group ? group.entries.map((entry) => entry.fileName) : []).slice(0, 5),
      paths,
      scopeRootReal,
    };
    this.suppressionItems = await this.store.put(record);
    this.options.onSuppressionsChanged?.(root, '抑制清单已变更，旧备份计划失效，请重新扫描');
  }

  /** 把被抑制的组从结果中移除（撤销后可重新提示） */
  private dropGroups(groups: DupGroup[]): void {
    if (!this.result) return;
    const ids = new Set(groups.map((group) => group.id));
    for (const group of groups) group.suppressed = true;
    this.result.groups = this.result.groups.filter((group) => !ids.has(group.id));
    this.result.identicalGroups = this.result.identicalGroups.filter((group) => !ids.has(group.id));
    this.result.suspectedGroups = this.result.suspectedGroups.filter((group) => !ids.has(group.id));
    this.result.nameConflictGroups = this.result.nameConflictGroups.filter((group) => !ids.has(group.id));
    if (this.fullResult) {
      this.fullResult.groups = this.fullResult.groups.filter((group) => !ids.has(group.id));
      this.fullResult.identicalGroups = this.fullResult.identicalGroups.filter((group) => !ids.has(group.id));
      this.fullResult.suspectedGroups = this.fullResult.suspectedGroups.filter((group) => !ids.has(group.id));
      this.fullResult.nameConflictGroups = this.fullResult.nameConflictGroups.filter((group) => !ids.has(group.id));
    }
  }

  /** 按条目 id 在当前结果中查找 */
  private findEntry(id: string): DupFileEntry | undefined {
    for (const group of this.result?.groups ?? []) {
      const entry = group.entries.find((item) => item.id === id);
      if (entry) return entry;
    }
    return undefined;
  }

  /** 重算统计：可回收空间与待删字节必须分开呈现（FR-17） */
  private refreshStats(): void {
    if (!this.result) return;
    const all = [...this.result.groups];
    const stats = computeStats(all);
    this.result.stats = {
      ...stats,
      pendingDeleteBytes: all.reduce(
        (sum, group) => sum + group.entries.filter((entry) => entry.state === 'queued').reduce((s, entry) => s + entry.size, 0),
        0,
      ),
      pendingDeleteCount: all.reduce((sum, group) => sum + group.entries.filter((entry) => entry.state === 'queued').length, 0),
      pendingDeleteGroups: all.filter((group) => group.entries.some((entry) => entry.state === 'queued')).length,
    };
  }
}

/** 抑制项 → 跨进程契约结构 */
function toSuppression(record: SuppressionRecord): DupSuppression {
  return {
    sha256: record.sha256,
    fingerprint: record.fingerprint ?? record.sha256.slice(0, 8),
    scopeRoot: record.scopeRoot,
    scopeMode: record.scopeMode,
    createdAt: record.createdAt,
    hitCount: record.hitCount,
    samplePaths: record.samplePaths ?? [],
    sampleFileNames: record.sampleFileNames ?? [],
  };
}

/**
 * 统计：可回收空间只由内容重复组贡献，同名不同内容区不计入（FR-17）。
 *
 * 疑似组按同样口径计入，但界面必须标注「未全量校验，不保证一致」。
 */
function computeStats(groups: DupGroup[]): DupStats {
  const reclaimableBytes = groups
    .filter((group) => group.category !== 'same-name-diff-content')
    .reduce((sum, group) => sum + group.reclaimableBytes, 0);
  const queued = groups.flatMap((group) => group.entries.filter((entry) => entry.state === 'queued'));
  return {
    reclaimableBytes,
    pendingDeleteBytes: queued.reduce((sum, entry) => sum + entry.size, 0),
    pendingDeleteCount: queued.length,
    pendingDeleteGroups: groups.filter((group) => group.entries.some((entry) => entry.state === 'queued')).length,
  };
}
