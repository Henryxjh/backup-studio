import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { scanTree, META_DIR } from './scan';
import { buildPlan, type PlanResult } from './planner';
import { CopyPool, type CopyResult } from './pool';
import { JournalStore, partFileName, type Journal, type JournalTask } from './journal';
import {
  assessMedia,
  probeMedia,
  sameMedia,
  MEDIA_ERROR_CODES,
  type MediaProbe,
} from './media';
import {
  historyDir,
  metaDir,
  partsDir,
  readManifest,
  writeManifest,
  type Manifest,
  type ManifestEntry,
} from './manifest';
import type {
  AppState,
  LogEntry,
  LogLevel,
  MediaAssessment,
  MediaIdentity,
  MediaState,
  PlanAction,
  QuarantineMark,
  RecoverableJob,
  ScanResult,
  SyncMode,
} from '../../shared/types';

/** 判定为「介质不可用」的错误码：拔盘、拔出 USB、总线错误 */
const MEDIA_PROBE_INTERVAL = 700;
const JOURNAL_FLUSH_INTERVAL = 400;
/** 连续探测失败多少次判定介质掉线 */
const MEDIA_LOSS_THRESHOLD = 2;

function now(): number {
  return Date.now();
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: string } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin';

function assertDistinctRoots(sourceRoot: string, targetRoot: string): void {
  const norm = (p: string) => {
    const resolved = path.resolve(p);
    return CASE_INSENSITIVE_PATHS ? resolved.toLowerCase() : resolved;
  };
  const src = norm(sourceRoot);
  const dst = norm(targetRoot);
  if (src === dst) {
    throw new Error('源目录与目标目录不能是同一路径');
  }
  const relFromSrc = path.relative(src, dst);
  if (relFromSrc && !relFromSrc.startsWith('..') && !path.isAbsolute(relFromSrc)) {
    throw new Error('目标目录不能位于源目录内部，否则会触发递归备份或误删');
  }
  const relFromDst = path.relative(dst, src);
  if (relFromDst && !relFromDst.startsWith('..') && !path.isAbsolute(relFromDst)) {
    throw new Error('源目录不能位于目标目录内部，否则扫描与镜像删除互相冲突');
  }
}

export interface StartOptions {
  sourceRoot: string;
  targetRoot: string;
  syncMode: SyncMode;
  /** 用户已确认高风险删除 */
  allowMassDelete: boolean;
  /** 断点续传：校验并复用未完成任务的 .part 分片 */
  resume: boolean;
  /** 内部恢复流程已通过确认与重扫 */
  fromRecovery?: boolean;
}

/** 恢复选项：用户确认后才允许继续写入 */
export interface RecoverOptions {
  /** 用户已确认在当前介质上继续（隔离解除或 L1 放行） */
  confirmed: boolean;
}

/**
 * 备份服务：扫描 → 计划 → 执行 → 收尾。
 *
 * 状态机完全由真实事件驱动：
 *  - 阶段与进度来自磁盘实际完成量，不做前端定时器伪造
 *  - 介质状态来自真实的可访问性探测
 *
 * 掉盘容灾约束（对应 REQ-ENG-001）：
 *  - 探测全程只读，绝不在探测阶段写目标盘
 *  - 介质掉线时立即停止写入，把断点落到**本机**账本
 *  - 重新插入后不自动续传：必须重新扫描、重新生成计划、由用户确认
 *  - 旧计划在介质变更后立即失效，避免用过期计划执行删除
 */
export class BackupService extends EventEmitter {
  private state: AppState;
  private journal: JournalStore;
  private pool: CopyPool | null = null;
  private mediaTimer: NodeJS.Timeout | null = null;
  private journalTimer: NodeJS.Timeout | null = null;
  private logSeq = 0;
  private pendingTasks = new Map<string, JournalTask>();
  private running = false;
  private cancelled = false;
  private mediaLost = false;
  private journalDirty = false;
  private currentJob: Journal | null = null;
  private currentPlan: PlanResult | null = null;
  private plannedMedia: MediaIdentity | null = null;
  /**
   * 计划阶段锁定的介质身份。**介质掉线后不清空**——
   * 需要用它识别「同一路径插入了另一块设备」，避免把身份漂移当成介质恢复。
   */
  private expectedMedia: MediaIdentity | null = null;
  /** 连续探测失败次数 */
  private probeFailures = 0;
  /** 累计 IO 错误 */
  private ioErrors = 0;
  /** 累计校验失败 */
  private verifyFailures = 0;
  /** 上次探测结果 */
  private lastProbe: MediaProbe | null = null;
  private actionIndex = new Map<string, PlanAction>();
  private copiedBytes = 0;
  private totalBytes = 0;
  private startedAt = 0;

  constructor(userDataDir: string) {
    super();
    this.journal = new JournalStore(userDataDir);
    this.state = {
      phase: 'idle',
      media: 'unknown',
      syncMode: 'mirror',
      sourceRoot: '',
      targetRoot: '',
      jobId: null,
      summary: this.emptySummary(),
      actions: [],
      logs: [],
      requiresConfirmation: false,
      confirmReason: '',
      recoverableJob: null,
      assessment: null,
      quarantine: null,
    };
  }

  private emptySummary() {
    return {
      totalFiles: 0,
      copy: 0,
      update: 0,
      rename: 0,
      delete: 0,
      skip: 0,
      bytes: 0,
      copiedBytes: 0,
      elapsedMs: 0,
      throughput: 0,
      etaMs: 0,
      media: 'unknown' as MediaState,
      phase: 'idle' as AppState['phase'],
    };
  }

  getState(): AppState {
    return { ...this.state, logs: [...this.state.logs] };
  }

  setSyncMode(mode: SyncMode): void {
    this.state.syncMode = mode;
    this.emitState();
  }

  private log(level: LogLevel['level'], text: string): void {
    const entry: LogEntry = { id: (this.logSeq += 1), ts: now(), level, text };
    this.state.logs = [...this.state.logs.slice(-400), entry];
    this.emit('log', entry);
  }

  private emitState(): void {
    this.emit('state', this.getState());
  }

  private setPhase(phase: AppState['phase']): void {
    this.state.phase = phase;
    this.state.summary.phase = phase;
    this.emitState();
  }

  private setMedia(media: MediaState): void {
    if (this.state.media === media) return;
    this.state.media = media;
    this.state.summary.media = media;
    this.emit('media', media);
    this.emitState();
  }

  /** 扫描源目录与目标目录 */
  async scan(sourceRoot: string, targetRoot: string): Promise<ScanResult> {
    if (this.running) throw new Error('备份执行中，不能重新扫描');
    assertDistinctRoots(sourceRoot, targetRoot);
    this.setPhase('scanning');
    const started = now();

    const [source, target] = await Promise.all([
      scanTree(sourceRoot, { excludeMetaDir: false }),
      scanTree(targetRoot, { excludeMetaDir: true }),
    ]);

    const result: ScanResult = {
      sourceRoot,
      targetRoot,
      sourceFiles: source.files.size,
      sourceBytes: source.totalBytes,
      sourceDirs: source.dirs.length,
      targetFiles: target.files.size,
      targetBytes: target.totalBytes,
      durationMs: now() - started,
      errors: [...source.errors, ...target.errors],
    };

    this.log(
      'info',
      `扫描完成：源 ${source.files.size} 个文件，目标 ${target.files.size} 个文件，耗时 ${result.durationMs} ms`,
    );
    for (const err of result.errors.slice(0, 5)) {
      this.log('warn', `扫描告警：${err}`);
    }
    this.setPhase('idle');
    return result;
  }

  /** 生成计划 */
  async plan(
    sourceRoot: string,
    targetRoot: string,
    syncMode: SyncMode,
  ): Promise<PlanResult> {
    if (this.running || this.state.phase === 'planning' || this.state.phase === 'scanning') {
      throw new Error('已有备份操作正在执行');
    }
    assertDistinctRoots(sourceRoot, targetRoot);
    this.currentPlan = null;
    this.plannedMedia = null;
    this.setPhase('planning');
    try {
      // 只读探测：不写目标盘。介质不可用时直接失败，不生成任何计划。
      const probe = await probeMedia(targetRoot);
      this.lastProbe = probe;
      if (!probe.reachable) {
        throw new Error(`目标介质不可用：${probe.errorText ?? '未知错误'}`);
      }
      const identity = probe.identity;
      this.state.sourceRoot = sourceRoot;
      this.state.targetRoot = targetRoot;
      this.state.syncMode = syncMode;

      const [source, target, manifest] = await Promise.all([
        scanTree(sourceRoot, { excludeMetaDir: false }),
        scanTree(targetRoot, { excludeMetaDir: true }),
        readManifest(targetRoot),
      ]);

      if (source.files.size === 0) {
        this.log('warn', '源目录中没有可备份的文件');
      }

      const result = await buildPlan({
        sourceRoot,
        targetRoot,
        source,
        target,
        manifest,
        syncMode,
        onProgress: (stage, done, total) => {
          this.emit('progress', {
            copiedBytes: this.copiedBytes,
            bytes: this.totalBytes,
            throughput: this.state.summary.throughput,
            etaMs: this.state.summary.etaMs,
          });
          void stage;
          void done;
          void total;
        },
      });

      if (source.errors.length || target.errors.length) {
        throw new Error('目录扫描不完整，禁止执行备份计划');
      }
      // 扫描期间介质可能被换掉，再确认一次身份
      const after = await probeMedia(targetRoot);
      if (identity && after.identity && !sameMedia(identity, after.identity)) {
        throw new Error('扫描期间目标介质发生变化，请重新扫描');
      }
      this.plannedMedia = identity;
      this.expectedMedia = identity;
      this.currentPlan = result;
      this.setMedia(after.writable ? 'online' : 'restoring');
      // 渲染层状态只暴露 previewActions（避免超大型目录打爆 IPC）；executePlan 仍执行全量 currentPlan.actions
      this.state.actions = result.previewActions;
      this.state.requiresConfirmation = result.requiresConfirmation;
      this.state.confirmReason = result.confirmReason;
      this.state.summary = {
        ...this.emptySummary(),
        ...result.summary,
        media: this.state.media,
        phase: 'ready',
      };
      this.actionIndex = new Map(result.actions.map((a) => [a.id, a]));

      this.log(
        'info',
        `计划生成：新增 ${result.summary.copy}，更新 ${result.summary.update}，改名 ${result.summary.rename}，删除 ${result.summary.delete}，跳过 ${result.summary.skip}`,
      );
      if (result.truncated) {
        this.log('info', `计划清单共 ${result.actions.length} 条，界面仅展示前 ${result.previewActions.length} 条（后台仍完整执行全部动作）`);
      }
      for (const err of result.hashErrors.slice(0, 5)) {
        this.log('warn', `哈希读取异常（相关孤儿文件已跳过删除）：${err}`);
      }
      if (result.requiresConfirmation) {
        this.log('warn', result.confirmReason);
      }
      this.setPhase('ready');
      this.emit('plan', {
        actions: result.previewActions,
        summary: this.state.summary,
        requiresConfirmation: result.requiresConfirmation,
        confirmReason: result.confirmReason,
      });
      return result;
    } catch (err) {
      this.setPhase('failed');
      this.log('error', `无法生成计划：${errorText(err)}`);
      throw err;
    }
  }

  /** 查找可续传的历史任务 */
  async findRecoverableJob(): Promise<RecoverableJob | null> {
    const job = await this.journal.getActive();
    if (!job) return null;
    const unfinished = Object.values(job.tasks).filter((t) => t.status !== 'done');
    if (unfinished.length === 0) {
      await this.journal.clearActive();
      return null;
    }
    return {
      jobId: job.jobId,
      sourceRoot: job.sourceRoot,
      targetRoot: job.targetRoot,
      syncMode: job.syncMode,
      remainingFiles: unfinished.length,
      remainingBytes: unfinished.reduce((sum, t) => sum + (t.totalBytes - t.copiedBytes), 0),
      updatedAt: job.updatedAt,
      activeFiles: Object.values(job.tasks)
        .filter((t) => t.status === 'copying')
        .map((t) => t.relPath),
      reason: job.interruption?.reason,
    };
  }

  async start(options: StartOptions): Promise<void> {
    if (this.running) throw new Error('已有备份任务正在执行');

    const { sourceRoot, targetRoot, syncMode } = options;
    const plan = this.currentPlan;
    const identity = this.plannedMedia;
    if (!plan || !identity || this.state.phase !== 'ready' ||
        sourceRoot !== this.state.sourceRoot || targetRoot !== this.state.targetRoot || syncMode !== this.state.syncMode) {
      throw new Error('请先重新扫描并生成当前目录的备份计划');
    }
    if (!options.allowMassDelete && plan.requiresConfirmation) {
      throw new Error('该计划包含高风险删除操作，需要先确认');
    }
    // 隔离观察状态下禁止写入，除非用户已显式撤销隔离
    if (this.state.quarantine && !this.state.quarantine.released) {
      throw new Error('该介质处于隔离观察状态，已禁止写入。请先撤销隔离再继续。');
    }

    const previous = await this.journal.getActive();
    if (previous?.interruption && previous.targetRoot === targetRoot && !options.fromRecovery) {
      // 中断后必须先由用户确认恢复或经过显式恢复入口：旧计划里的删除动作一律作废
      throw new Error('检测到上次中断记录，请通过「恢复并重扫」确认后继续，避免沿用过期计划。');
    }

    this.running = true;
    this.cancelled = false;
    this.mediaLost = false;
    this.ioErrors = 0;
    this.verifyFailures = 0;
    this.copiedBytes = 0;
    this.startedAt = now();

    try {
    // 写入前最后一次只读确认：身份一致且可写才允许开写
    const probe = await probeMedia(targetRoot);
    this.lastProbe = probe;
    if (!probe.reachable) {
      throw new Error(`目标介质不可用：${probe.errorText ?? '未知错误'}`);
    }
    if (probe.identity && !sameMedia(identity, probe.identity)) {
      throw new Error('目标介质身份已变化，请重新扫描');
    }
    if (!probe.writable) {
      throw new Error('目标介质为只读，无法写入');
    }

    const jobId = randomUUID();
    const journal: Journal = {
      version: 1,
      jobId,
      sourceRoot,
      targetRoot,
      syncMode,
      createdAt: now(),
      updatedAt: now(),
      txSeq: 0,
      committedTx: 0,
      mediaIdentity: identity,
      tasks: {},
    };
    await this.journal.write(journal);
    await this.journal.setActive(jobId);
    this.currentJob = journal;
    this.pendingTasks.clear();
    this.state.jobId = jobId;
    this.state.sourceRoot = sourceRoot;
    this.state.targetRoot = targetRoot;
    this.state.syncMode = syncMode;

    // 元数据目录创建属于「写入阶段」，必须放在可写性确认之后
    await fs.mkdir(metaDir(targetRoot), { recursive: true });
    await fs.mkdir(partsDir(targetRoot), { recursive: true });

    this.setMedia('online');
    this.setPhase('running');
    this.log('success', '开始备份');

    this.startMediaMonitor();
    this.startJournalFlush();

    const poolSize = Math.max(2, Math.min(8, os.cpus().length - 1));
    this.pool = new CopyPool(
      path.join(__dirname, 'copyWorker.js'),
      poolSize,
      {
        onProgress: (id, bytes) => this.onCopyProgress(id, bytes),
        onDone: (result) => void this.onCopyDone(result),
        onError: (id, err) => void this.onCopyError(id, err.message, err.code),
      },
    );

    await this.executePlan(options);
    } catch (err) {
      this.running = false;
      this.stopMediaMonitor();
      this.stopJournalFlush();
      this.setPhase('failed');
      this.log('error', `备份未启动：${errorText(err)}`);
      throw err;
    }
  }

  /**
   * 介质恢复后的显式续传入口。
   *
   * 与旧实现的关键区别：**不会自动续传**。重新插入介质后必须由用户确认，
   * 并且必须先重新扫描生成新计划——旧计划可能包含掉线前算出的删除动作，
   * 直接沿用会误删。
   */
  async recover(options: RecoverOptions): Promise<void> {
    const job = await this.journal.getActive();
    if (!job?.interruption) {
      throw new Error('没有可恢复的中断任务');
    }
    if (!options.confirmed) {
      throw new Error('恢复备份需要用户确认');
    }

    const probe = await probeMedia(job.targetRoot);
    this.lastProbe = probe;
    if (!probe.reachable) {
      throw new Error(`目标介质仍不可用：${probe.errorText ?? '未知错误'}`);
    }
    if (job.mediaIdentity && probe.identity && !sameMedia(job.mediaIdentity, probe.identity)) {
      throw new Error('目标路径指向了另一块介质，已禁止续传以免写错设备');
    }

    const assessment = await this.assessTarget(job.targetRoot);
    if (assessment.level === 'L2') {
      await this.quarantine(job.targetRoot, '恢复前判定为 L2，已禁止写入');
      throw new Error('介质判定为 L2，已隔离并禁止写入。');
    }

    this.log('info', '开始恢复备份：正在重新扫描并生成新计划');

    // 不提前清除 active.json：只有新计划生成并进入 start() 写入新 jobId 后才替换，
    // 确保 plan/start 任一步失败时仍保留原有断点指针不丢失。
    this.currentJob = null;
    this.currentPlan = null;
    this.plannedMedia = null;
    this.state.phase = 'idle';
    await this.plan(job.sourceRoot, job.targetRoot, job.syncMode);

    await this.start({
      sourceRoot: job.sourceRoot,
      targetRoot: job.targetRoot,
      syncMode: job.syncMode,
      allowMassDelete: false,
      resume: true,
      fromRecovery: true,
    });
  }

  /** 对目标介质做只读检测并输出判定 */
  async assessTarget(targetRoot: string): Promise<MediaAssessment> {
    const probe = await probeMedia(targetRoot);
    this.lastProbe = probe;
    const manifestReadable = await readManifest(targetRoot).then(() => true).catch(() => false);
    const job = await this.journal.getActive();
    const assessment = assessMedia({
      probe,
      expected: job?.mediaIdentity ?? this.plannedMedia,
      manifestReadable,
      ioErrors: this.ioErrors,
      verifyFailures: this.verifyFailures,
      quarantined: Boolean(this.state.quarantine && !this.state.quarantine.released),
    });
    this.state.assessment = assessment;
    this.emitState();
    return assessment;
  }

  /** 最近一次只读探测的结果 */
  getLastProbe(): MediaProbe | null {
    return this.lastProbe;
  }

  /** 标记隔离观察；标记可撤销，不等同于「物理坏盘」 */
  async quarantine(targetRoot: string, reason: string): Promise<QuarantineMark> {
    const assessment = this.state.assessment;
    const mark: QuarantineMark = {
      targetRoot,
      reason,
      level: assessment?.level ?? 'L2',
      at: now(),
      released: false,
    };
    this.state.quarantine = mark;
    this.setMedia('quarantined');
    this.log('warn', `目标介质已标记为隔离观察：${reason}（非物理坏盘结论，可人工撤销）`);
    if (this.currentJob) {
      this.currentJob.quarantine = mark;
      await this.journal.write(this.currentJob);
    }
    this.emitState();
    return mark;
  }

  /** 撤销隔离观察标记 */
  async releaseQuarantine(): Promise<void> {
    const mark = this.state.quarantine;
    if (!mark) return;
    mark.released = true;
    mark.releasedAt = now();
    this.state.quarantine = mark;
    this.setMedia('online');
    this.log('info', '已撤销隔离观察标记，允许重新扫描与备份');
    if (this.currentJob) {
      this.currentJob.quarantine = mark;
      await this.journal.write(this.currentJob);
    }
    this.emitState();
  }

  private async executePlan(options: StartOptions): Promise<void> {
    const plan = this.currentPlan;
    if (!plan) throw new Error('尚未生成计划');

    this.running = true;
    const actions = plan.actions.filter((a) => a.type !== 'skip');
    this.totalBytes = plan.summary.bytes;
    this.state.summary = {
      ...this.state.summary,
      ...plan.summary,
      copiedBytes: 0,
      elapsedMs: 0,
      throughput: 0,
      etaMs: 0,
      media: this.state.media,
      phase: 'running',
    };

    try {
      // 第一步：改名动作（纯元数据操作，瞬间完成）
      for (const action of actions.filter((a) => a.type === 'rename')) {
        if (this.mediaLost || this.cancelled) break;
        await this.performRename(action);
      }

      // 同步源端新增目录结构（含空目录）
      for (const relDir of plan.missingDirs) {
        if (this.mediaLost || this.cancelled) break;
        await this.ensureTargetDir(relDir);
      }

      // 第二步：复制与更新，并等待所有工作线程落盘完毕
      for (const action of actions.filter((a) => a.type === 'copy' || a.type === 'update')) {
        if (this.mediaLost || this.cancelled) break;
        await this.enqueueCopy(action, options.resume);
      }
      await this.waitForCompletion();

      // 第三步：删除与归档（必须在所有复制彻底落盘之后执行，避免 Windows 大小写竞态误删新写入文件）
      // 删除前及循环中必须实时确认介质健康与未取消
      if (!this.mediaLost && !this.cancelled) {
        for (const action of actions.filter((a) => a.type === 'delete')) {
          if (this.mediaLost || this.cancelled) break;
          await this.performDelete(action);
        }
      }

      const failedActions = actions.filter((a) => a.status === 'failed');
      if (this.mediaLost) {
        // 中断路径：不写清单、不清账本，保留断点供恢复
        this.setPhase('interrupted');
        this.log('warn', '备份因介质中断而停止，断点已保存在本机');
      } else if (this.cancelled) {
        this.setPhase('cancelled');
        this.log('warn', '备份已取消');
      } else {
        const manifestOk = await this.finalize(options, failedActions.length > 0);
        if (failedActions.length > 0 || !manifestOk || plan.hashErrors.length > 0) {
          const reasons: string[] = [];
          if (failedActions.length > 0) reasons.push(`${failedActions.length} 个文件操作失败`);
          if (plan.hashErrors.length > 0) reasons.push(`${plan.hashErrors.length} 个文件规划期读取失败`);
          if (!manifestOk) reasons.push('写入清单失败');
          if (this.currentJob) {
            this.currentJob.interruption = {
              at: now(),
              reason: `备份未完全成功：${reasons.join('，')}`,
              activeFiles: failedActions.map((a) => a.relPath),
              committedTasks: Object.values(this.currentJob.tasks).filter((t) => t.status === 'done').length,
            };
            await this.flushJournal(true);
            this.state.recoverableJob = await this.findRecoverableJob();
          }
          this.setPhase('failed');
          this.log('error', `备份未完全成功（${reasons.join('，')}），已保留恢复记录`);
        } else {
          this.setPhase('completed');
          this.log('success', '备份完成');
        }
      }
    } catch (err) {
      this.setPhase('failed');
      this.log('error', `备份失败：${errorText(err)}`);
    } finally {
      this.running = false;
      this.stopMediaMonitor();
      this.stopJournalFlush();
      if (this.pool) {
        await this.pool.destroy();
        this.pool = null;
      }
      await this.flushJournal();
      // 只有完全成功结束或主动取消才清除活动任务指针；中断/部分失败时保留，供下次恢复
      if (this.state.phase === 'completed' || this.state.phase === 'cancelled') {
        await this.journal.clearActive();
      }
      this.emitState();
    }
  }

  private async enqueueCopy(action: PlanAction, resume: boolean): Promise<void> {
    if (!this.pool || !this.currentJob) return;
    const targetRoot = this.state.targetRoot;
    const partPath = path.join(partsDir(targetRoot), partFileName(action.relPath));

    const task: JournalTask = {
      relPath: action.relPath,
      totalBytes: action.size,
      copiedBytes: 0,
      partPath,
      status: 'copying',
    };

    this.currentJob.tasks[action.relPath] = task;
    this.pendingTasks.set(action.relPath, task);
    this.markJournalDirty();

    this.updateAction(action.id, { status: 'running', copiedBytes: 0 });
    this.submitTask(action, task, resume);
  }
  /** 把任务投递给复制池；续传与首次复制走同一条路径 */
  private submitTask(action: PlanAction, task: JournalTask, resume: boolean): void {
    if (!this.pool) return;
    const sourceRoot = this.state.sourceRoot;
    this.pool.submit(
      {
        id: action.relPath,
        srcPath: path.join(sourceRoot, action.relPath),
        partPath: task.partPath,
        totalBytes: task.totalBytes,
        verify: true,
        resume,
      },
      {
        onProgress: (id, copiedBytes) => this.onCopyProgress(id, copiedBytes),
        onDone: (result) => void this.onCopyDone(result),
        onError: (id, error) => void this.onCopyError(id, error.message, error.code),
      },
    );
  }

  private onCopyProgress(id: string, copiedBytes: number): void {
    const task = this.pendingTasks.get(id);
    if (task) {
      task.copiedBytes = copiedBytes;
      this.markJournalDirty();
    }
    const action = this.findActionByRel(id);
    if (action) {
      action.copiedBytes = copiedBytes;
      this.state.summary.activeFile = id;
    }

    this.copiedBytes = this.computeCopiedBytes();
    this.state.summary.copiedBytes = this.copiedBytes;
    this.updateThroughput();
  }

  private computeCopiedBytes(): number {
    let sum = 0;
    for (const task of this.pendingTasks.values()) sum += task.copiedBytes;
    const sourceActions = this.currentPlan?.actions ?? this.state.actions;
    for (const action of sourceActions) {
      if ((action.type === 'copy' || action.type === 'update') && action.status === 'done') {
        sum += action.size;
      }
    }
    return sum;
  }

  private updateThroughput(): void {
    const elapsed = Math.max(1, now() - this.startedAt);
    const throughput = (this.copiedBytes / elapsed) * 1000;
    const remaining = Math.max(0, this.totalBytes - this.copiedBytes);
    const etaMs = throughput > 0 ? Math.round((remaining / throughput) * 1000) : 0;
    this.state.summary.throughput = Math.round(throughput);
    this.state.summary.etaMs = etaMs;
    this.state.summary.elapsedMs = elapsed;
    this.state.summary.copiedBytes = this.copiedBytes;
    this.emit('progress', {
      copiedBytes: this.copiedBytes,
      bytes: this.totalBytes,
      activeFile: this.state.summary.activeFile,
      throughput: this.state.summary.throughput,
      etaMs,
    });
  }

  private async onCopyDone(result: CopyResult): Promise<void> {
    const { id: relPath, sha256, bytes } = result;
    const task = this.pendingTasks.get(relPath);
    const action = this.findActionByRel(relPath);
    if (!task || !action) return;

    const targetRoot = this.state.targetRoot;
    const finalPath = path.join(targetRoot, relPath);

    try {
      const committed = await this.commitToTarget(task.partPath, finalPath);
      if (!committed) {
        await this.handleMediaLoss(`目标端路径在写入过程中消失：${finalPath}`);
        return;
      }
    } catch (err) {
      const code = errorCode(err);
      if (code && MEDIA_ERROR_CODES.has(code)) {
        this.ioErrors += 1;
        await this.handleMediaLoss(errorText(err));
        return;
      }
      this.updateAction(action.id, { status: 'failed', error: errorText(err) });
      this.log('error', `写入失败：${relPath} — ${errorText(err)}`);
      this.pendingTasks.delete(relPath);
      return;
    }

    task.status = 'done';
    task.sha256 = sha256;
    task.copiedBytes = bytes;
    this.pendingTasks.delete(relPath);
    this.markJournalDirty();

    this.updateAction(action.id, { status: 'done', copiedBytes: bytes, sha256 });
    this.emit('copy-completed', result);
    this.copiedBytes = this.computeCopiedBytes();
    this.updateThroughput();
  }

  /**
   * 把产物提交到目标路径：先 rename，父目录缺失时才补建。
   *
   * 顺序很关键。若先 mkdir 再 rename，介质在复制途中掉线时这一步会把
   * **目标目录重新创建出来**——既等于往疑似已失效的介质上写了一笔，
   * 又会让随后的只读探测把这个自己造出来的目录当成「介质可达」，
   * 把 lost 状态悄悄翻回 online，掩盖掉线事实。
   *
   * 返回 false 表示目标根已不可达（介质掉线），调用方必须停止写入。
   */
  private async commitToTarget(srcPath: string, destPath: string): Promise<boolean> {
    try {
      await fs.rename(srcPath, destPath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // 父目录缺失：先复核目标根是否还可达，介质掉线时不得重建目录
      if (!(await this.checkMediaAlive())) return false;
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.rename(srcPath, destPath);
      return true;
    }
  }

  private async onCopyError(relPath: string, message: string, code?: string): Promise<void> {
    const action = this.findActionByRel(relPath);
    const task = this.pendingTasks.get(relPath);

    // 介质掉线时，文件级报错只是表象：先判定目标根是否还可达。
    // 不能只依赖定时探测——任务可能在首次探测前就因介质消失而结束。
    const mediaAlive = await this.checkMediaAlive();
    if (!mediaAlive) {
      await this.handleMediaLoss(message);
      return;
    }
    if (code && MEDIA_ERROR_CODES.has(code)) {
      this.ioErrors += 1;
      await this.handleMediaLoss(message);
      return;
    }
    // 校验失败单独计数：连续校验失败是介质损坏的强信号，应升级为 L2
    if (code === 'VERIFY_FAILED') {
      this.verifyFailures += 1;
      if (this.verifyFailures >= 2) {
        await this.handleMediaLoss(`连续校验失败 ${this.verifyFailures} 次：${message}`);
        return;
      }
    }
    // 目标根可达但不可写（写保护、介质已失效但盘符未消失）：
    // 此时任何写入都必然失败，继续重试只会刷出成百上千条文件级错误。
    // 判定为介质异常，停止写入并交由用户处置。
    if (this.lastProbe && !this.lastProbe.writable) {
      this.ioErrors += 1;
      await this.handleMediaLoss(`目标介质不可写：${message}`);
      return;
    }
    // 目标根可达可写，但写入报路径不存在：说明目标端目录结构在写入过程中
    // 消失（外部删除或介质中断未完全反映在探测结果里），按介质异常处理。
    if (code === 'ENOENT' && this.state.targetRoot) {
      const stillThere = await probeMedia(this.state.targetRoot);
      if (!stillThere.reachable || !stillThere.writable) {
        this.ioErrors += 1;
        await this.handleMediaLoss(`目标端路径在写入过程中消失：${message}`);
        return;
      }
    }

    if (action) {
      this.updateAction(action.id, { status: 'failed', error: message });
    }
    if (task) task.status = 'failed';
    this.log('error', `复制失败：${relPath} — ${message}`);
    this.pendingTasks.delete(relPath);
    this.copiedBytes = this.computeCopiedBytes();
    this.updateThroughput();
  }

  private async ensureTargetDir(relDir: string): Promise<void> {
    const targetRoot = this.state.targetRoot;
    if (!targetRoot) return;
    if (!(await this.checkMediaAlive())) {
      await this.handleMediaLoss('目标目录在同步目录结构期间不可达');
      return;
    }
    try {
      await fs.mkdir(path.join(targetRoot, relDir), { recursive: true });
    } catch (err) {
      const code = errorCode(err);
      if (code && MEDIA_ERROR_CODES.has(code)) {
        this.ioErrors += 1;
        await this.handleMediaLoss(errorText(err));
        return;
      }
      this.log('warn', `创建目录失败：${relDir} — ${errorText(err)}`);
    }
  }

  private async performRename(action: PlanAction): Promise<void> {
    const targetRoot = this.state.targetRoot;
    const from = path.join(targetRoot, action.fromRelPath ?? '');
    const to = path.join(targetRoot, action.relPath);
    try {
      const committed = await this.commitToTarget(from, to);
      if (!committed) {
        await this.handleMediaLoss(`目标端路径在改名过程中消失：${to}`);
        return;
      }
      this.updateAction(action.id, { status: 'done' });
      this.log('success', `改名同步：${action.fromRelPath} → ${action.relPath}`);
    } catch (err) {
      const code = errorCode(err);
      if (code && MEDIA_ERROR_CODES.has(code)) {
        this.ioErrors += 1;
        await this.handleMediaLoss(errorText(err));
        return;
      }
      this.updateAction(action.id, { status: 'failed', error: errorText(err) });
      this.log('error', `改名同步失败：${action.relPath} — ${errorText(err)}`);
    }
  }

  private async performDelete(action: PlanAction): Promise<void> {
    const targetRoot = this.state.targetRoot;
    const target = path.join(targetRoot, action.relPath);
    try {
      if (this.state.syncMode === 'mirror-archive') {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const archive = path.join(historyDir(targetRoot), stamp, action.relPath);
        const committed = await this.commitToTarget(target, archive);
        if (!committed) {
          await this.handleMediaLoss(`目标端路径在归档过程中消失：${target}`);
          return;
        }
        this.updateAction(action.id, { status: 'archived', note: '已归档至历史目录' });
      } else {
        await fs.unlink(target);
        this.updateAction(action.id, { status: 'done' });
      }
    } catch (err) {
      const code = errorCode(err);
      if (code && MEDIA_ERROR_CODES.has(code)) {
        this.ioErrors += 1;
        await this.handleMediaLoss(errorText(err));
        return;
      }
      this.updateAction(action.id, { status: 'failed', error: errorText(err) });
      this.log('error', `删除失败：${action.relPath} — ${errorText(err)}`);
    }
  }

  private findActionByRel(relPath: string): PlanAction | undefined {
    const sourceActions = this.currentPlan?.actions ?? this.state.actions;
    for (const action of sourceActions) {
      if (action.relPath === relPath && (action.type === 'copy' || action.type === 'update')) {
        return action;
      }
    }
    return undefined;
  }

  private updateAction(id: string, patch: Partial<PlanAction>): void {
    const action = this.actionIndex.get(id);
    if (!action) return;
    Object.assign(action, patch);
    this.emit('action', action);
  }

  // ---- 介质可用性 ----

  private startMediaMonitor(): void {
    this.stopMediaMonitor();
    this.mediaTimer = setInterval(() => {
      void this.probeMedia();
    }, MEDIA_PROBE_INTERVAL);
  }

  private stopMediaMonitor(): void {
    if (this.mediaTimer) {
      clearInterval(this.mediaTimer);
      this.mediaTimer = null;
    }
  }

  private async probeMedia(): Promise<void> {
    const targetRoot = this.state.targetRoot;
    if (!targetRoot) return;

    // 只读探测：不创建目录、不写任何字节
    const probe = await probeMedia(targetRoot);
    this.lastProbe = probe;

    if (probe.reachable) {
      this.probeFailures = 0;
      if (this.mediaLost) {
        // 同一路径可能已经插入了**另一块设备**。身份漂移不能当作「介质恢复」，
        // 否则后续会把数据写到错误的设备上。此时按身份漂移处置，禁止写入。
        if (this.expectedMedia && probe.identity && !sameMedia(this.expectedMedia, probe.identity)) {
          this.mediaLost = false;
          this.setMedia('quarantined');
          this.log('error', '目标路径指向了另一块介质（身份漂移），已禁止继续写入，请重新选择目标目录');
          this.state.phase = 'interrupted';
          this.emitState();
          return;
        }
        this.mediaLost = false;
        this.setMedia('online');
        // 不自动续传：介质回来后必须由用户重新扫描并确认
        this.log('success', '备份介质已重新接入。请重新扫描并确认后继续备份');
        this.state.phase = 'interrupted';
        this.emitState();
      }
      return;
    }

    // 连续失败达到阈值才判定掉线，避免单次抖动误判
    this.probeFailures += 1;
    if (!this.mediaLost && this.probeFailures >= MEDIA_LOSS_THRESHOLD) {
      await this.handleMediaLoss(probe.errorText ?? '目标根不可读');
    }
  }

  /** 只读探测目标根是否仍然可达 */
  private async checkMediaAlive(): Promise<boolean> {
    const targetRoot = this.state.targetRoot;
    if (!targetRoot) return true;
    const probe = await probeMedia(targetRoot);
    this.lastProbe = probe;
    return probe.reachable;
  }

  /**
   * 介质掉线处理。
   *
   * 关键动作：
   *  1. 立即停止派发新任务（pool.pause）
   *  2. 把断点写入**本机**账本——介质已掉线，盘上日志写不进去，本机是唯一权威
   *  3. 作废当前计划：掉线前算出的删除动作不能在恢复后被直接执行
   *  4. 状态置为 interrupted，等待用户重新扫描并确认
   */
  private async handleMediaLoss(message: string): Promise<void> {
    if (this.mediaLost) return;
    this.mediaLost = true;
    this.setMedia('lost');
    this.pool?.pause();

    const activeFiles = [...this.pendingTasks.entries()]
      .filter(([, task]) => task.status === 'copying')
      .map(([relPath]) => relPath);

    if (this.currentJob) {
      this.currentJob.interruption = {
        at: now(),
        reason: message,
        activeFiles,
        committedTasks: Object.values(this.currentJob.tasks).filter((t) => t.status === 'done').length,
      };
      // 本机账本立即落盘：介质已不可用，这是唯一能保住断点的地方
      await this.flushJournal(true);
      // 掉线后不再写目标盘。盘上日志镜像只会保留最后一次成功写入的记录，
      // 中断事实以本机账本为准（盘上镜像本就是「候选证据」，不是权威）。
      this.stopJournalFlush();
    }

    // 旧计划立即失效
    this.currentPlan = null;
    this.plannedMedia = null;

    this.log('error', `备份介质不可用（${message}）。已停止写入，断点保存在本机`);
    this.state.recoverableJob = await this.findRecoverableJob();
    this.emitState();
  }

  // ---- 任务收尾 ----

  private waitForCompletion(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (!this.running) {
          resolve();
          return;
        }
        // 介质离线期间也必须能响应取消，否则任务会永久挂起
        if (this.cancelled) {
          resolve();
          return;
        }
        if (this.mediaLost) {
          // 介质掉线：结束等待并进入中断路径，不无限挂起
          setTimeout(() => resolve(), 300);
          return;
        }
        if (this.pendingTasks.size === 0 && (this.pool?.pendingCount ?? 0) === 0) {
          // 给最后一次写盘与改名留出落盘时间
          setTimeout(() => {
            if (this.pendingTasks.size === 0) {
              resolve();
              return;
            }
            check();
          }, 150);
          return;
        }
        setTimeout(check, 120);
      };
      check();
    });
  }

  private async finalize(options: StartOptions, hasFailure: boolean): Promise<boolean> {
    const targetRoot = options.targetRoot;
    const manifest = await this.updateManifest(targetRoot);
    let manifestOk = true;
    await writeManifest(targetRoot, manifest).catch((err) => {
      manifestOk = false;
      this.log('error', `写入清单失败：${errorText(err)}`);
    });
    if (this.currentJob) {
      await this.journal.write(this.currentJob);
    }
    // 只有全部动作成功且清单已写入时才清理 .part 临时目录；失败/未完成时保留已拷贝分片供下次续传
    if (!hasFailure && manifestOk) {
      await fs.rm(partsDir(targetRoot), { recursive: true, force: true }).catch(() => undefined);
    }
    return manifestOk;
  }

  private async updateManifest(targetRoot: string): Promise<Manifest> {
    const manifest = (await readManifest(targetRoot)) ?? {
      version: 1 as const,
      sourceRoot: this.state.sourceRoot,
      updatedAt: now(),
      files: {},
    };
    const files: Record<string, ManifestEntry> = { ...manifest.files };
    const sourceActions = this.currentPlan?.actions ?? this.state.actions;

    for (const action of sourceActions) {
      if (action.type !== 'copy' && action.type !== 'update' && action.type !== 'rename') continue;
      if (action.status !== 'done' && action.status !== 'archived') continue;
      try {
        const stat = await fs.stat(path.join(targetRoot, action.relPath));
        files[action.relPath] = {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          sha256: action.sha256 ?? '',
          backedUpAt: now(),
        };
      } catch {
        // 目标端读取失败时保留旧记录
      }
    }

    // 被删除的文件从清单中移除
    for (const action of sourceActions) {
      if (action.type === 'delete' && (action.status === 'done' || action.status === 'archived')) {
        delete files[action.relPath];
      }
    }

    manifest.files = files;
    manifest.sourceRoot = this.state.sourceRoot;
    manifest.updatedAt = now();
    return manifest;
  }

  // ---- 账本落盘 ----

  private markJournalDirty(): void {
    this.journalDirty = true;
  }

  private startJournalFlush(): void {
    this.stopJournalFlush();
    this.journalTimer = setInterval(() => {
      void this.flushJournal();
    }, JOURNAL_FLUSH_INTERVAL);
  }

  private stopJournalFlush(): void {
    if (this.journalTimer) {
      clearInterval(this.journalTimer);
      this.journalTimer = null;
    }
  }

  private async flushJournal(force = false): Promise<void> {
    if (!this.currentJob) return;
    if (!this.journalDirty && !force) return;
    this.journalDirty = false;
    try {
      // 事务序列号单调递增，作为「最后已提交事务」的判据
      this.currentJob.txSeq += 1;
      this.currentJob.committedTx = this.currentJob.txSeq;
      await this.journal.write(this.currentJob);
      // 盘上日志双写：**仅在介质仍在线且身份未漂移时**执行。
      // 掉线后写目标盘既违反「掉线后停止写入」，也会让只读探测把
      // 自己造出来的目录当成「介质可达」，从而掩盖掉线事实。
      if (await this.canWriteMirror()) {
        await this.journal.writeMirror(this.state.targetRoot, this.currentJob).catch(() => false);
      }
    } catch (err) {
      this.journalDirty = true;
      if (force) {
        this.log('error', `本机断点账本落盘失败，续传进度可能丢失：${errorText(err)}`);
      }
    }
  }

  /**
   * 当前是否允许向目标盘写盘上日志镜像。
   *
   * 三个条件缺一不可：
   *  - 介质未判定掉线
   *  - 目标根仍然可达（**只读**复核，不得创建）
   *  - 介质身份未漂移（不得写到另一块设备上）
   */
  private async canWriteMirror(): Promise<boolean> {
    if (this.mediaLost) return false;
    const targetRoot = this.state.targetRoot;
    if (!targetRoot) return false;
    const probe = await probeMedia(targetRoot);
    this.lastProbe = probe;
    if (!probe.reachable) return false;
    if (this.expectedMedia && probe.identity && !sameMedia(this.expectedMedia, probe.identity)) {
      return false;
    }
    return true;
  }

  // ---- 控制指令 ----

  pause(): void {
    if (!this.running) return;
    this.pool?.pause();
    this.setPhase('paused');
    this.log('info', '任务已暂停');
  }

  async resume(): Promise<void> {
    if (!this.running) return;
    this.pool?.resume();
    this.setPhase('running');
    this.log('info', '任务已继续');
  }

  cancel(): void {
    if (!this.running) return;
    this.cancelled = true;
    this.pool?.pause();
    this.log('warn', '正在取消备份任务');
  }

  /** 清理目标端的元数据目录（恢复为普通文件夹） */
  async cleanupMeta(): Promise<void> {
    const targetRoot = this.state.targetRoot;
    if (!targetRoot) return;
    await fs.rm(path.join(targetRoot, META_DIR), { recursive: true, force: true }).catch(() => undefined);
    this.log('info', '已清除目标端的备份元数据');
  }
}
