import type {
  AppState,
  LogEntry,
  MediaState,
  PlanAction,
  ScanResult,
  SyncMode,
} from '../../shared/types';
import type { AutoPair, AutoStatus } from '../../shared/aut-types';
import type {
  DupActRequest,
  DupActResult,
  DupFileEntry,
  DupGroup,
  DupItemAction,
  DupPhase,
  DupProgress,
  DupScanResult,
  DupStatus,
  DupSuppression,
} from '../../shared/dup-types';
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

/**
 * 浏览器预览用的模拟后端。
 * 仅在脱离 Electron 渲染层时启用（window.backupAPI 不存在），
 * 用于在普通浏览器里核对界面布局与动效，不参与真实备份。
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

  // 自动备份的浏览器演示状态：不触碰真实文件系统。
  let autoPair: AutoPair | null = null;
  let autoEnabled = false;
  const autoStatus = (): AutoStatus => ({
    pair: autoPair,
    state: autoEnabled ? 'idle' : 'off',
    available: autoPair !== null,
    polling: autoPair?.pollOnly ?? false,
    pending: 0,
    attempts: 0,
    reason: autoPair ? '浏览器演示：未连接真实文件系统，不进行实际同步' : undefined,
    recent: [],
    recycle: [],
    recycleBytes: 0,
  });

  // 重复文件检测的浏览器演示状态：不触碰真实文件系统。
  const DUP_ROOT = 'D:\\资料库\\待清理目录';
  const dupSha = (seed: string) => seed.repeat(64).slice(0, 64);
  const dupEntry = (
    id: string,
    absPath: string,
    relPath: string,
    size: number,
    mtimeMs: number,
    sha256: string,
    suspected = false,
  ): DupFileEntry => ({
    id,
    absPath,
    relPath,
    dirPath: absPath.slice(0, Math.max(absPath.lastIndexOf('\\'), absPath.lastIndexOf('/'))),
    fileName: absPath.slice(absPath.lastIndexOf('\\') + 1),
    size,
    mtimeMs,
    dev: 'demo-dev',
    ino: `demo-ino-${id}`,
    sha256,
    suspected: suspected || undefined,
    state: 'pending',
  });

  const dupGroups = (): DupGroup[] => {
    const photoSha = dupSha('a1b2c3d4');
    const docSha = dupSha('b7c8d9e0');
    const bigSha = dupSha('f0e1d2c3');
    const noteShaA = dupSha('11111111');
    const noteShaB = dupSha('22222222');
    const conflictDir = `${DUP_ROOT}\\文档`;

    const photoSize = 4_410_318;
    const docSize = 128_442;
    const bigSize = 314_572_800;

    return [
      {
        id: photoSha,
        category: 'identical',
        fingerprint: 'a1b2c3d4',
        sha256: photoSha,
        entries: [
          dupEntry('p1', `${DUP_ROOT}\\照片\\IMG_20240712.jpg`, '照片/IMG_20240712.jpg', photoSize, 1_721_026_000_000, photoSha),
          dupEntry('p2', `${DUP_ROOT}\\照片\\归档\\IMG_20240712-已删除.jpg`, '照片/归档/IMG_20240712-已删除.jpg', photoSize, 1_721_030_000_000, photoSha),
          dupEntry('p3', `${DUP_ROOT}\\照片\\IMG_20240712 (1).jpg`, '照片/IMG_20240712 (1).jpg', photoSize, 1_721_090_000_000, photoSha),
        ],
        size: photoSize,
        reclaimableBytes: photoSize * 2,
        suggestedKeeperId: 'p1',
      },
      {
        id: docSha,
        category: 'identical',
        fingerprint: 'b7c8d9e0',
        sha256: docSha,
        entries: [
          dupEntry('d1', `${DUP_ROOT}\\文档\\2024年度总结报告.docx`, '文档/2024年度总结报告.docx', docSize, 1_720_000_000_000, docSha),
          dupEntry('d2', `${DUP_ROOT}\\归档\\2024年度总结报告-存档.pdf`, '归档/2024年度总结报告-存档.pdf', docSize, 1_720_500_000_000, docSha),
        ],
        size: docSize,
        reclaimableBytes: docSize,
        suggestedKeeperId: 'd1',
      },
      {
        id: bigSha,
        category: 'suspected',
        fingerprint: 'f0e1d2c3',
        sha256: bigSha,
        entries: [
          dupEntry('s1', `${DUP_ROOT}\\视频\\发布会原片.mov`, '视频/发布会原片.mov', bigSize, 1_719_000_000_000, bigSha, true),
          dupEntry('s2', `${DUP_ROOT}\\视频\\归档\\发布会原片.mov`, '视频/归档/发布会原片.mov', bigSize, 1_719_400_000_000, bigSha, true),
        ],
        size: bigSize,
        reclaimableBytes: bigSize,
        suggestedKeeperId: 's1',
      },
      {
        id: `${conflictDir}::会议纪要.md`,
        category: 'same-name-diff-content',
        fingerprint: '33333333',
        entries: [
          dupEntry('c1', `${conflictDir}\\会议纪要.md`, '文档/会议纪要.md', 12_884, 1_721_100_000_000, noteShaA),
          dupEntry('c2', `${conflictDir}\\会议纪要.md`, '文档/会议纪要.md', 13_210, 1_721_600_000_000, noteShaB),
        ],
        size: 13_210,
        reclaimableBytes: 0,
        dirPath: conflictDir,
        fileName: '会议纪要.md',
      },
    ];
  };

  let dupGroupsState: DupGroup[] = [];
  let dupResult: DupScanResult | null = null;
  let dupPhase: DupPhase = 'idle';
  let dupCancelled = false;
  let dupProgress: DupProgress = {
    phase: 'idle',
    label: '待选目录',
    done: 0,
    total: 0,
    bytesRead: 0,
    throughputBps: 0,
  };
  let dupSuppressions: DupSuppression[] = [
    {
      sha256: dupSha('deadbeef'),
      fingerprint: 'deadbeef',
      scopeRoot: DUP_ROOT,
      scopeMode: 'root',
      createdAt: Date.now() - 86_400_000,
      hitCount: 3,
      samplePaths: [`${DUP_ROOT}\\归档\\归档包 (1).zip`],
      sampleFileNames: ['归档包 (1).zip'],
    },
  ];

  const dupStats = () => {
    const groups = dupGroupsState;
    const queued = groups.flatMap((group) => group.entries).filter((entry) => entry.state === 'queued');
    const touched = new Set(
      groups.filter((group) => group.entries.some((entry) => entry.state === 'queued')).map((group) => group.id),
    );
    return {
      reclaimableBytes: groups
        .filter((group) => group.category !== 'same-name-diff-content')
        .reduce((sum, group) => sum + group.reclaimableBytes, 0),
      pendingDeleteBytes: queued.reduce((sum, entry) => sum + entry.size, 0),
      pendingDeleteCount: queued.length,
      pendingDeleteGroups: touched.size,
    };
  };

  const dupBuildResult = (root: string): DupScanResult => {
    const groups = dupGroupsState;
    const identicalGroups = groups.filter((group) => group.category === 'identical');
    const suspectedGroups = groups.filter((group) => group.category === 'suspected');
    const nameConflictGroups = groups.filter((group) => group.category === 'same-name-diff-content');
    return {
      root,
      summary: {
        root,
        totalFiles: 12_840,
        scannedBytes: 45_218_998_016,
        skippedEmpty: 37,
        skippedTooSmall: 12,
        skippedSymlink: 4,
        skippedSuppressed: dupSuppressions.length,
        identicalGroups: identicalGroups.length,
        nameConflictGroups: nameConflictGroups.length,
        suspectedGroups: suspectedGroups.length,
        durationMs: 42_300,
      },
      groups,
      identicalGroups,
      suspectedGroups,
      nameConflictGroups,
      failures: [],
      stats: dupStats(),
      complete: true,
      truncated: false,
    };
  };

  const dupStatus = (): DupStatus => ({
    phase: dupPhase,
    progress: dupProgress,
    result: dupResult,
    suppressions: dupSuppressions,
    recent: dupResult
      ? [{ at: Date.now(), action: '重复检测完成', detail: '浏览器演示：未连接真实文件系统', outcome: 'ok' }]
      : [],
    reason: dupResult ? '浏览器演示：未连接真实文件系统，结论仅供界面预览' : undefined,
    canAct: dupPhase === 'ready' || dupPhase === 'done',
  });

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
        note: type === 'rename' ? '由 documents/旧版方案.docx 改名，内容一致，无需复制' : undefined,
      } as PlanAction;
    });
  };

  return {
    async pickDirectory(title: string) {
      if (title.includes('检测')) return 'D:\\资料库\\待清理目录';
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
          current = { ...current, phase: 'completed' };
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

    async reveal(targetPath: string) {
      // 浏览器演示：没有真实文件系统，按演示约定模拟「扫描后该文件已不存在」
      if (targetPath.includes('已删除')) throw new Error('文件已不存在或不可访问');
    },

    async setTheme(mode) {
      return mode === 'light' ? 'light' : 'dark';
    },

    autoSync: {
      async status() {
        return autoStatus();
      },
      async configure(input) {
        autoPair = {
          id: 'demo-pair',
          enabled: false,
          sourceRoot: input.sourceRoot,
          targetRoot: input.targetRoot,
          excludes: input.excludes ?? [],
          syncDeletes: input.syncDeletes ?? false,
          retentionDays: input.retentionDays ?? 7,
          recycleMaxBytes: input.recycleMaxBytes ?? 10 * 1024 ** 3,
          externalChanges: input.externalChanges ?? 'pause',
          pollOnly: input.pollOnly ?? false,
          pollMs: input.pollMs ?? 30000,
          stableMs: input.stableMs ?? 750,
          allowSnapshotFiles: input.allowSnapshotFiles ?? false,
        };
        autoEnabled = false;
        return autoStatus();
      },
      async setEnabled(enabled) {
        if (enabled) autoEnabled = true;
        else autoEnabled = false;
        return autoStatus();
      },
      async resume() {
        return autoStatus();
      },
      async restore() {
        return autoStatus();
      },
    },

    duplicateFinder: {
      async status() {
        return dupStatus();
      },
      async scan(root: string) {
        dupCancelled = false;
        dupGroupsState = dupGroups();
        const stages: DupPhase[] = ['scanning', 'bucketing', 'partial-hashing', 'hashing', 'summarizing'];
        const labels: Record<string, string> = {
          scanning: '扫描目录',
          bucketing: '大小分桶',
          'partial-hashing': '局部哈希',
          hashing: '全量哈希',
          summarizing: '汇总',
        };
        for (const stage of stages) {
          if (dupCancelled) break;
          dupPhase = stage;
          for (let step = 0; step < 8; step += 1) {
            await new Promise((r) => setTimeout(r, 70));
            if (dupCancelled) break;
            dupProgress = {
              phase: stage,
              label: labels[stage],
              done: (step + 1) * 125,
              total: 1000,
              bytesRead: (step + 1) * 5_242_880,
              throughputBps: 5_242_880,
              etaMs: (8 - step) * 700,
            };
          }
        }
        if (dupCancelled) {
          dupPhase = 'cancelled';
          dupProgress = { phase: 'cancelled', label: '已取消', done: 0, total: 0, bytesRead: 0, throughputBps: 0 };
          return dupStatus();
        }
        dupResult = dupBuildResult(root);
        dupPhase = 'ready';
        dupProgress = {
          phase: 'ready',
          label: '结果就绪',
          done: 1000,
          total: 1000,
          bytesRead: 45_218_998_016,
          throughputBps: 0,
        };
        return dupStatus();
      },
      async cancel() {
        if (dupPhase === 'scanning' || dupPhase === 'bucketing' || dupPhase === 'partial-hashing' || dupPhase === 'hashing' || dupPhase === 'summarizing') {
          dupCancelled = true;
          dupPhase = 'cancelled';
          dupProgress = { phase: 'cancelled', label: '已取消', done: 0, total: 0, bytesRead: 0, throughputBps: 0 };
        }
        return dupStatus();
      },
      async markAction(_root: string, itemIds: string[], action: DupItemAction) {
        for (const group of dupGroupsState) {
          for (const entry of group.entries) {
            if (!itemIds.includes(entry.id)) continue;
            if (action === 'keep') entry.state = 'kept';
            else if (action === 'delete') entry.state = 'queued';
          }
        }
        if (dupResult) dupResult = dupBuildResult(dupResult.root);
        return dupStatus();
      },
      async keepGroup(_root: string, groupId: string, keeperId: string) {
        const group = dupGroupsState.find((item) => item.id === groupId);
        if (!group) return dupStatus();
        for (const entry of group.entries) entry.state = entry.id === keeperId ? 'kept' : 'queued';
        if (dupResult) dupResult = dupBuildResult(dupResult.root);
        return dupStatus();
      },
      async act(root: string, request: DupActRequest): Promise<DupActResult> {
        dupPhase = 'acting';
        const items: DupActResult['items'] = [];
        let reclaimedBytes = 0;
        for (const item of request.items) {
          const group = dupGroupsState.find((g) => g.id === item.groupId);
          const entry = group?.entries.find((e) => e.id === item.id);
          if (!entry) {
            items.push({ id: item.id, absPath: item.absPath, outcome: 'failed', reason: '条目已失效，请重新检测' });
            continue;
          }
          entry.state = 'deleted';
          reclaimedBytes += entry.size;
          items.push({ id: item.id, absPath: item.absPath, outcome: 'deleted', landedTo: 'system-trash' });
        }
        dupResult = dupBuildResult(root);
        dupPhase = 'done';
        dupProgress = { phase: 'done', label: '已完成', done: 1000, total: 1000, bytesRead: 0, throughputBps: 0 };
        return {
          items,
          deleted: items.filter((item) => item.outcome === 'deleted').length,
          skipped: 0,
          blocked: 0,
          failed: items.filter((item) => item.outcome === 'failed').length,
          reclaimedBytes,
          degradedToQuarantine: false,
        };
      },
      async suppress(root: string, sha256: string, scopeMode: 'root' | 'global', samplePaths: string[]) {
        const sampleFileNames = samplePaths
          .map((path) => path.slice(path.lastIndexOf('\\') + 1))
          .filter(Boolean);
        dupSuppressions = [
          ...dupSuppressions.filter((item) => item.sha256 !== sha256),
          {
            sha256,
            fingerprint: sha256.slice(0, 8),
            scopeRoot: root,
            scopeMode,
            createdAt: Date.now(),
            hitCount: 0,
            samplePaths,
            sampleFileNames,
          },
        ];
        for (const group of dupGroupsState) {
          if (group.sha256 === sha256) group.suppressed = true;
        }
        if (dupResult) dupResult = dupBuildResult(dupResult.root);
        return dupStatus();
      },
      async listSuppressions() {
        return dupSuppressions;
      },
      async revokeSuppression(sha256?: string) {
        const revoked = new Set(sha256 ? [sha256] : dupSuppressions.map((item) => item.sha256));
        dupSuppressions = dupSuppressions.filter((item) => !revoked.has(item.sha256));
        for (const group of dupGroupsState) {
          if (!group.sha256 || !revoked.has(group.sha256)) continue;
          group.suppressed = false;
          for (const entry of group.entries) entry.state = 'pending';
        }
        if (dupResult) dupResult = dupBuildResult(dupResult.root);
        return dupStatus();
      },
      async exportReport(format: 'json' | 'csv') {
        const text = format === 'csv' ? 'fingerprint,size,relPath\n' : JSON.stringify(dupResult, null, 2);
        return { path: `D:\\报告\\duplicate-report.${format}`, bytes: text.length };
      },
      async restoreQuarantine(id: string) {
        return { restored: false, reason: `浏览器演示：未连接真实文件系统，未还原隔离区条目 ${id}` };
      },
      async reveal(root: string, absPath: string) {
        // 浏览器演示：按演示约定模拟「扫描后该文件已不存在」
        if (!root) throw new Error('当前没有扫描结果，请先执行重复文件检测');
        if (absPath.includes('已删除')) throw new Error('文件已不存在或不可访问');
        return { revealed: true };
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
