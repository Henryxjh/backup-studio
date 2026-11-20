import type {
  AppState,
  LogEntry,
  MediaState,
  PlanAction,
  ScanResult,
  SyncMode,
} from '../../shared/types';
import type {
  AutoBlock,
  AutoCommit,
  AutoEvent,
  AutoHistory,
  AutoPair,
  AutoPairInput,
  AutoPairStatus,
  AutoRecycleEntry,
  AutoRunState,
  AutoStatus,
  AutoVersion,
} from '../../shared/aut-types';
import type { BackupAPI, PlanPayload, ProgressPayload, StartOptions } from './api';

type Handler<T> = (payload: T) => void;

function makeHandlers<T>() {
  const handlers: Handler<T>[] = [];
  return {
    push: (handler: Handler<T>) => {
      handlers.push(handler);
      return () => {
        const index = handlers.indexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
    emit: (payload: T) => handlers.forEach((h) => h(payload)),
  };
}

/** AutoPairInput 的契约默认值（对应 shared/aut-types.ts 的 Required<AutoPairInput>）。 */
const DEFAULT_PAIR: Required<AutoPairInput> = {
  sourceRoot: '',
  targetRoot: '',
  excludes: [],
  syncDeletes: false,
  retentionDays: 7,
  recycleMaxBytes: 10 * 1024 ** 3,
  externalChanges: 'pause',
  pollOnly: false,
  pollMs: 30000,
  stableMs: 750,
  allowSnapshotFiles: false,
  historyMaxBytes: 50 * 1024 ** 3,
  historyMaxVersionsPerPath: 20,
};

/** mock 后端内部保存的单个配对状态。 */
interface MockPair {
  pair: AutoPair;
  state: AutoRunState;
  available: boolean;
  polling: boolean;
  pending: number;
  attempts: number;
  reason?: string;
  block?: AutoBlock;
  lastSync?: number;
  recent: AutoEvent[];
  recycle: AutoRecycleEntry[];
  recycleBytes: number;
  historyCounts: { commits: number; versions: number };
  sessionDeletes: number;
  unmanagedDeletes: number;
  history: AutoHistory;
}

/**
 * 浏览器预览用的模拟后端。
 * 仅在脱离 Electron 渲染层时启用（window.backupAPI 不存在），
 * 用于在普通浏览器里核对界面布局与动效，不参与真实备份。
 *
 * 自动备份部分实现了 shared/aut-types.ts 的多配对契约：
 * status / addPair / updatePair / removePair / setEnabled / resume / restore / restoreVersion / history。
 */
export function createMockApi(): BackupAPI {
  let seq = 0;
  const logs = makeHandlers<LogEntry>();
  const progress = makeHandlers<ProgressPayload>();
  const action = makeHandlers<PlanAction>();
  const plan = makeHandlers<PlanPayload>();
  const state = makeHandlers<AppState>();
  const media = makeHandlers<MediaState>();

  const baseState = (): AppState => ({
    phase: 'idle',
    media: 'online',
    syncMode: 'mirror',
    sourceRoot: '',
    targetRoot: '',
    jobId: null,
    summary: {
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
      media: 'online',
      phase: 'idle',
    },
    actions: [],
    logs: [],
    requiresConfirmation: false,
    confirmReason: '',
    recoverableJob: null,
    assessment: null,
    quarantine: null,
  });

  let current = baseState();
  let timer: number | null = null;

  // ---- 自动备份的浏览器演示状态：不触碰真实文件系统 ----
  let pairSeq = 0;
  const demoNow = Date.now();

  const demoVersions: AutoVersion[] = [
    {
      id: 'v-1',
      pairId: 'demo-pair',
      relPath: 'documents/合同/供应商合作协议-2025-签署版.pdf',
      hash: 'a3f91c02be7745d68a1e0c7b93f2d45',
      size: 1_482_112,
      at: demoNow - 86_400_000,
      commitId: 'c-1',
      kind: 'modify',
      previousId: undefined,
    },
    {
      id: 'v-2',
      pairId: 'demo-pair',
      relPath: 'documents/合同/供应商合作协议-2025-签署版.pdf',
      hash: 'c81d0f45a3b62e97d5108c4ab6e21f39',
      size: 1_471_008,
      at: demoNow - 259_200_000,
      commitId: 'c-2',
      kind: 'add',
    },
    {
      id: 'v-3',
      pairId: 'demo-pair',
      relPath: 'media/photos/IMAG20240712094530.jpg',
      hash: '5f2b9c1d84e07a63b91f0c2d7e58a401',
      size: 4_820_224,
      at: demoNow - 172_800_000,
      commitId: 'c-3',
      kind: 'modify',
    },
  ];

  const demoCommits: AutoCommit[] = [
    {
      id: 'c-1',
      pairId: 'demo-pair',
      at: demoNow - 86_400_000,
      changes: [
        { relPath: 'documents/合同/供应商合作协议-2025-签署版.pdf', kind: 'modify', hash: 'a3f91c02be7745d68a1e0c7b93f2d45', size: 1_482_112, versionId: 'v-1' },
        { relPath: 'notes/会议纪要/2025-03-18 周会同步.md', kind: 'modify', hash: '77c0a1b93f4e25d80c6b1e3947a5d082', size: 12_880 },
      ],
    },
    {
      id: 'c-2',
      pairId: 'demo-pair',
      at: demoNow - 259_200_000,
      changes: [
        { relPath: 'documents/合同/供应商合作协议-2025-签署版.pdf', kind: 'add', hash: 'c81d0f45a3b62e97d5108c4ab6e21f39', size: 1_471_008, versionId: 'v-2' },
      ],
    },
    {
      id: 'c-3',
      pairId: 'demo-pair',
      at: demoNow - 172_800_000,
      changes: [
        { relPath: 'media/photos/IMAG20240712094530.jpg', kind: 'modify', hash: '5f2b9c1d84e07a63b91f0c2d7e58a401', size: 4_820_224, versionId: 'v-3' },
      ],
    },
  ];

  const demoRecycle: AutoRecycleEntry[] = [
    {
      id: 'r-1',
      relPath: 'archives/legacy/系统迁移方案-归档版本.zip',
      size: 87_654_321,
      at: demoNow - 43_200_000,
      expiresAt: demoNow + 604_800_000,
      kind: 'delete',
      hash: '9be41d7c02a5f83610dc47e9b3a6208',
    },
    {
      id: 'r-2',
      relPath: 'documents/2024年度总结报告.docx',
      size: 2_411_520,
      at: demoNow - 8_640_000,
      expiresAt: demoNow + 691_200_000,
      kind: 'replace',
      hash: 'd2c7a91f4e60b83c5d19e7a2f804b6d5',
      versionId: 'v-1',
    },
  ];

  const pairs: MockPair[] = [
    {
      pair: {
        id: 'demo-pair',
        enabled: true,
        ...DEFAULT_PAIR,
        sourceRoot: 'D:\\资料库\\主目录',
        targetRoot: 'E:\\备份仓\\每日快照',
        excludes: ['node_modules/**', '*.tmp'],
        syncDeletes: true,
        retentionDays: 14,
        pollOnly: true,
        pollMs: 60000,
      },
      state: 'idle',
      available: true,
      polling: true,
      pending: 3,
      attempts: 0,
      reason: '浏览器演示：未连接真实文件系统，不进行实际同步',
      lastSync: demoNow - 900_000,
      recent: [
        { at: demoNow - 900_000, action: '对账完成', detail: '新增 2 / 更新 1 / 删除 0' },
        { at: demoNow - 1_800_000, action: '回收删除', detail: 'archives/legacy/系统迁移方案-归档版本.zip' },
      ],
      recycle: demoRecycle,
      recycleBytes: demoRecycle.reduce((sum, item) => sum + item.size, 0),
      historyCounts: { commits: demoCommits.length, versions: demoVersions.length },
      sessionDeletes: 1,
      unmanagedDeletes: 4,
      history: { commits: demoCommits, versions: demoVersions },
    },
  ];

  /** 已解除的配对：历史与回收站仍留在原备份介质上，这里只做计数展示。 */
  let releasedPairCount = 0;

  const toPairStatus = (entry: MockPair): AutoPairStatus => ({
    pair: entry.pair,
    state: entry.state,
    available: entry.available,
    polling: entry.polling,
    pending: entry.pending,
    attempts: entry.attempts,
    reason: entry.reason,
    block: entry.block,
    lastSync: entry.lastSync,
    recent: entry.recent,
    recycle: entry.recycle,
    recycleBytes: entry.recycleBytes,
    historyCounts: entry.historyCounts,
    sessionDeletes: entry.sessionDeletes,
    unmanagedDeletes: entry.unmanagedDeletes,
  });

  const aggregateState = (): AutoRunState => {
    if (pairs.some((entry) => entry.state === 'syncing')) return 'syncing';
    if (pairs.some((entry) => entry.state === 'scanning')) return 'scanning';
    if (pairs.some((entry) => entry.state === 'error')) return 'error';
    if (pairs.some((entry) => entry.state === 'waiting')) return 'waiting';
    if (pairs.some((entry) => entry.state === 'paused')) return 'paused';
    if (pairs.some((entry) => entry.pair.enabled)) return 'idle';
    return 'off';
  };

  const autoStatus = (activePairId?: string): AutoStatus => ({
    pairs: pairs.map(toPairStatus),
    state: aggregateState(),
    activePairId: activePairId ?? pairs[0]?.pair.id,
  });

  const findPair = (pairId: string): MockPair => {
    const entry = pairs.find((item) => item.pair.id === pairId);
    if (!entry) throw new Error(`找不到配对：${pairId}`);
    return entry;
  };

  const pushEvent = (entry: MockPair, action: string, detail?: string) => {
    entry.recent = [{ at: Date.now(), action, detail }, ...entry.recent].slice(0, 50);
  };

  const pushLog = (level: LogEntry['level'], text: string) => {
    seq += 1;
    const entry: LogEntry = { id: seq, ts: Date.now(), level, text };
    current = { ...current, logs: [...current.logs, entry] };
    logs.emit(entry);
  };

  const fakeActions = (): PlanAction[] => {
    const names = [
      'documents/2024年度总结报告.docx',
      'documents/合同/供应商合作协议-2025-签署版.pdf',
      'media/photos/IMAG20240712094530.jpg',
      'media/videos/产品发布会回放.mp4',
      'projects/atlas/src/services/backup-engine/worker-pool.ts',
      'projects/atlas/src/services/backup-engine/chunk-copier.ts',
      'projects/atlas/docs/architecture/backup-protocol.md',
      'archives/legacy/系统迁移方案-归档版本.zip',
      'assets/icons/app-store/1024x1024@2x.png',
      'notes/会议纪要/2025-03-18 周会同步.md',
      'projects/atlas/services/backup-engine/增量同步模块/worker-pool-implementation-2025-final.ts',
      'media/raw-captures/2024年度发布会现场录制原片未压缩母版文件.mov',
    ];
    const types: PlanAction['type'][] = ['copy', 'copy', 'copy', 'update', 'copy', 'rename', 'skip', 'delete'];
    return Array.from({ length: 48 }, (_, i) => {
      const relPath = names[i % names.length];
      const type = types[i % types.length];
      return {
        id: `${type}:${relPath}:${i}`,
        type,
        relPath,
        size: (i + 1) * 1024 * 37,
        status: 'pending',
        note:
          type === 'rename'
            ? '由 documents/旧版方案.docx 改名，内容一致，无需复制'
            : type === 'skip'
              ? '内容一致，无需复制'
              : undefined,
      } as PlanAction;
    });
  };

  return {
    async pickDirectory(title: string) {
      return title.includes('源') ? 'D:\\资料库\\主目录' : 'E:\\备份仓\\每日快照';
    },

    async scan(sourceRoot: string, targetRoot: string): Promise<ScanResult> {
      await new Promise((r) => setTimeout(r, 260));
      return {
        sourceRoot,
        targetRoot,
        sourceFiles: 12480,
        sourceBytes: 8_912_345_678,
        sourceDirs: 812,
        targetFiles: 11902,
        targetBytes: 8_204_112_233,
        durationMs: 412,
        errors: [],
      };
    },

    async plan(sourceRoot: string, targetRoot: string, syncMode: SyncMode): Promise<PlanPayload> {
      await new Promise((r) => setTimeout(r, 220));
      const actions = fakeActions();
      const summary = {
        totalFiles: 12480,
        copy: 218,
        update: 46,
        rename: 12,
        delete: 37,
        skip: 12167,
        bytes: 3_204_112_233,
        copiedBytes: 0,
        elapsedMs: 0,
        throughput: 0,
        etaMs: 0,
        media: 'online' as MediaState,
        phase: 'ready' as AppState['phase'],
      };
      const payload: PlanPayload = {
        actions,
        summary,
        requiresConfirmation: false,
        confirmReason: '',
      };
      current = { ...current, sourceRoot, targetRoot, syncMode, actions, summary };
      plan.emit(payload);
      return payload;
    },

    async start(options: StartOptions): Promise<AppState> {
      const payload = await this.plan(options.sourceRoot, options.targetRoot, options.syncMode);
      current = { ...current, phase: 'running', summary: { ...payload.summary, phase: 'running' } };
      state.emit(current);
      pushLog('success', '开始备份');

      let copied = 0;
      const total = payload.summary.bytes;
      const startedAt = Date.now();
      timer = window.setInterval(() => {
        copied += Math.round(total / 90);
        const elapsed = Date.now() - startedAt;
        const throughput = (copied / elapsed) * 1000;
        const next: ProgressPayload = {
          copiedBytes: Math.min(copied, total),
          bytes: total,
          activeFile: 'projects/atlas/src/services/backup-engine/chunk-copier.ts',
          throughput,
          etaMs: Math.round(((total - copied) / Math.max(1, throughput)) * 1000),
        };
        progress.emit(next);
        if (copied >= total) {
          if (timer) window.clearInterval(timer);
          timer = null;
          current = {
            ...current,
            phase: 'completed',
            summary: { ...current.summary, phase: 'completed', copiedBytes: total, elapsedMs: elapsed },
          };
          state.emit(current);
          pushLog('success', '备份完成');
        }
      }, 90);
      return current;
    },

    async pause() {
      current = { ...current, phase: 'paused' };
      state.emit(current);
      pushLog('info', '任务已暂停');
      return current;
    },

    async resume() {
      current = { ...current, phase: 'running' };
      state.emit(current);
      pushLog('info', '任务已继续');
      return current;
    },

    async cancel() {
      if (timer) window.clearInterval(timer);
      timer = null;
      current = { ...current, phase: 'cancelled' };
      state.emit(current);
      pushLog('warn', '备份已取消');
      return current;
    },

    async getState() {
      return current;
    },

    async cleanupMeta() {
      return current;
    },

    async health() {
      return { assessment: { level: 'L1', confidence: 0.95, writable: false, at: Date.now(), suggestion: '演示卷需人工检查，保持只读。', evidence: [{ kind: '演示卷', detail: 'NTFS / Full Repair Needed / 脏位置位', at: Date.now() }] }, condition: 'filesystem-repair', permission: true, volume: 'X:', smart: '能力缺失', index: '未验证', files: { complete: 0, truncated: 0, missing: 0, mismatch: 0, unchecked: 0 } };
    },
    async reenumerate(root) { return this.health(root); },
    async repairDryRun(_root, request) {
      if (request.volume !== 'X:' || !request.confirmed || !request.confirmedAgain || !request.disclaimerAccepted) throw new Error('须选择作用卷并完成两次确认');
      return { mode: 'dry-run', auditId: 'demo', volume: 'X:', imageCreated: false, guidance: '浏览器演示：未创建镜像或调用修复。' };
    },
    async exportPartitionEvidence() { return { auditId: 'demo', guidance: '浏览器演示：未写入文件。' }; },
    async capabilities() { return (await import('../../electron/engine/capability')).capabilityMatrix; },

    async assess(_targetRoot: string) {
      return {
        assessment: {
          level: 'L0' as const,
          confidence: 0.8,
          evidence: [],
          suggestion: '介质读取稳定',
          at: Date.now(),
          writable: true,
        },
        state: current,
      };
    },

    async recover() {
      current = { ...current, phase: 'running' };
      state.emit(current);
      return current;
    },

    async quarantine() {
      return current;
    },

    async releaseQuarantine() {
      return current;
    },

    async reveal() {},

    async setTheme(mode) {
      return mode === 'light' ? 'light' : 'dark';
    },

    autoSync: {
      async status(): Promise<AutoStatus> {
        return autoStatus();
      },

      async addPair(input: AutoPairInput): Promise<AutoStatus> {
        pairSeq += 1;
        const entry: MockPair = {
          pair: {
            id: `pair-${pairSeq}`,
            enabled: false,
            ...DEFAULT_PAIR,
            ...input,
            excludes: input.excludes ?? [],
          },
          state: 'off',
          available: true,
          polling: input.pollOnly ?? false,
          pending: 0,
          attempts: 0,
          reason: '浏览器演示：未连接真实文件系统，不进行实际同步',
          recent: [],
          recycle: [],
          recycleBytes: 0,
          historyCounts: { commits: 0, versions: 0 },
          sessionDeletes: 0,
          unmanagedDeletes: 0,
          history: { commits: [], versions: [] },
        };
        pairs.push(entry);
        return autoStatus(entry.pair.id);
      },

      async updatePair(pairId: string, input: Partial<AutoPairInput>): Promise<AutoStatus> {
        const entry = findPair(pairId);
        entry.pair = {
          ...entry.pair,
          ...input,
          excludes: input.excludes ?? entry.pair.excludes,
        };
        entry.polling = entry.pair.pollOnly;
        pushEvent(entry, '配对设置已更新');
        return autoStatus(pairId);
      },

      async removePair(pairId: string): Promise<AutoStatus> {
        const index = pairs.findIndex((item) => item.pair.id === pairId);
        if (index < 0) throw new Error(`找不到配对：${pairId}`);
        // 历史与回收站不随配对删除：它们留在原备份介质上，这里只做计数。
        releasedPairCount += 1;
        pairs.splice(index, 1);
        pushLog('info', `已解除配对，历史与回收站仍保留在原备份介质上（累计解除 ${releasedPairCount} 个）`);
        return autoStatus();
      },

      async setEnabled(pairId: string, enabled: boolean): Promise<AutoStatus> {
        const entry = findPair(pairId);
        entry.pair.enabled = enabled;
        entry.state = enabled ? 'idle' : 'off';
        entry.reason = enabled
          ? '浏览器演示：未连接真实文件系统，不进行实际同步'
          : '自动备份已关闭';
        pushEvent(entry, enabled ? '已开启自动备份' : '已关闭自动备份');
        return autoStatus(pairId);
      },

      async resume(pairId: string): Promise<AutoStatus> {
        const entry = findPair(pairId);
        entry.state = 'idle';
        entry.lastSync = Date.now();
        entry.pending = 0;
        entry.attempts = 0;
        pushEvent(entry, '重新对账完成');
        return autoStatus(pairId);
      },

      async restore(pairId: string, recycleId: string): Promise<AutoStatus> {
        const entry = findPair(pairId);
        const target = entry.recycle.find((item) => item.id === recycleId);
        if (!target) throw new Error('找不到回收项');
        entry.recycle = entry.recycle.filter((item) => item.id !== recycleId);
        entry.recycleBytes = entry.recycle.reduce((sum, item) => sum + item.size, 0);
        pushEvent(entry, '已从回收站恢复', target.relPath);
        return autoStatus(pairId);
      },

      async restoreVersion(pairId: string, versionId: string): Promise<AutoStatus> {
        const entry = findPair(pairId);
        const target = entry.history.versions.find((item) => item.id === versionId);
        if (!target) throw new Error('找不到历史版本');
        pushEvent(entry, '已撤回历史版本', target.relPath);
        return autoStatus(pairId);
      },

      async history(pairId: string): Promise<AutoHistory> {
        const entry = findPair(pairId);
        return entry.history;
      },
    },

    onState: (cb) => state.push(cb),
    onPlan: (cb) => plan.push(cb),
    onProgress: (cb) => progress.push(cb),
    onAction: (cb) => action.push(cb),
    onLog: (cb) => logs.push(cb),
    onMedia: (cb) => media.push(cb),
  };
}
