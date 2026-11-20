import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppState,
  LogEntry,
  MediaAssessment,
  MediaState,
  PlanAction,
  RecycleBin,
  RecoverableJob,
  ScanResult,
  SyncMode,
} from '../shared/types';
import type { AutoHistory, AutoPairInput, AutoStatus } from '../shared/aut-types';

export interface StartOptions {
  sourceRoot: string;
  targetRoot: string;
  syncMode: SyncMode;
  allowMassDelete: boolean;
  resume: boolean;
}

export interface PlanPayload {
  actions: PlanAction[];
  summary: AppState['summary'];
  requiresConfirmation: boolean;
  confirmReason: string;
}

export interface ProgressPayload {
  copiedBytes: number;
  bytes: number;
  activeFile?: string;
  throughput: number;
  etaMs: number;
}

/**
 * 渲染层唯一能触碰的通道。
 * 关闭 nodeIntegration，磁盘访问只经由主进程受控的 IPC 方法。
 */
const api = {
  pickDirectory: (title: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:pick-directory', title),

  scan: (sourceRoot: string, targetRoot: string): Promise<ScanResult> =>
    ipcRenderer.invoke('backup:scan', sourceRoot, targetRoot),

  plan: (sourceRoot: string, targetRoot: string, syncMode: SyncMode): Promise<PlanPayload> =>
    ipcRenderer.invoke('backup:plan', sourceRoot, targetRoot, syncMode),

  start: (options: StartOptions): Promise<AppState> => ipcRenderer.invoke('backup:start', options),

  pause: (): Promise<AppState> => ipcRenderer.invoke('backup:pause'),

  resume: (): Promise<AppState> => ipcRenderer.invoke('backup:resume'),

  cancel: (): Promise<AppState> => ipcRenderer.invoke('backup:cancel'),

  getState: (): Promise<AppState> => ipcRenderer.invoke('backup:get-state'),

  cleanupMeta: (): Promise<AppState> => ipcRenderer.invoke('backup:cleanup-meta'),

  assess: (targetRoot: string): Promise<{ assessment: MediaAssessment; state: AppState }> =>
    ipcRenderer.invoke('backup:assess', targetRoot),

  recover: (confirmed: boolean): Promise<AppState> => ipcRenderer.invoke('backup:recover', confirmed),

  health: (root: string) => ipcRenderer.invoke('backup:health', root),
  reenumerate: (root: string) => ipcRenderer.invoke('backup:reenumerate', root),
  repairDryRun: (root: string, request: import('../shared/types').RepairRequest) => ipcRenderer.invoke('backup:repair-dry-run', root, request),
  exportPartitionEvidence: (root: string) => ipcRenderer.invoke('backup:partition-evidence', root),
  capabilities: () => ipcRenderer.invoke('backup:capabilities'),

  quarantine: (reason: string): Promise<AppState> => ipcRenderer.invoke('backup:quarantine', reason),

  releaseQuarantine: (): Promise<AppState> => ipcRenderer.invoke('backup:release-quarantine'),

  listRecycle: (targetRoot: string): Promise<RecycleBin> =>
    ipcRenderer.invoke('backup:recycle:list', targetRoot),

  restoreRecycle: (targetRoot: string, id: string, overwrite: boolean): Promise<RecycleBin> =>
    ipcRenderer.invoke('backup:recycle:restore', targetRoot, id, overwrite),

  removeRecycle: (targetRoot: string, id: string): Promise<RecycleBin> =>
    ipcRenderer.invoke('backup:recycle:remove', targetRoot, id),

  autoSync: {
    status: (): Promise<AutoStatus> => ipcRenderer.invoke('aut:status'),
    addPair: (input: AutoPairInput): Promise<AutoStatus> => ipcRenderer.invoke('aut:add-pair', input),
    updatePair: (pairId: string, input: Partial<AutoPairInput>): Promise<AutoStatus> =>
      ipcRenderer.invoke('aut:update-pair', pairId, input),
    removePair: (pairId: string): Promise<AutoStatus> => ipcRenderer.invoke('aut:remove-pair', pairId),
    setEnabled: (pairId: string, enabled: boolean): Promise<AutoStatus> =>
      ipcRenderer.invoke('aut:set-enabled', pairId, enabled),
    resume: (pairId: string): Promise<AutoStatus> => ipcRenderer.invoke('aut:resume', pairId),
    restore: (pairId: string, recycleId: string): Promise<AutoStatus> =>
      ipcRenderer.invoke('aut:restore', pairId, recycleId),
    restoreVersion: (pairId: string, versionId: string): Promise<AutoStatus> =>
      ipcRenderer.invoke('aut:restore-version', pairId, versionId),
    history: (pairId: string): Promise<AutoHistory> => ipcRenderer.invoke('aut:history', pairId),
  },

  reveal: (targetPath: string): Promise<void> => ipcRenderer.invoke('app:reveal', targetPath),

  setTheme: (mode: 'light' | 'dark' | 'system'): Promise<'light' | 'dark'> =>
    ipcRenderer.invoke('app:theme', mode),

  onState: (cb: (state: AppState) => void): (() => void) => subscribe('backup:state', cb),
  onPlan: (cb: (payload: PlanPayload) => void): (() => void) => subscribe('backup:plan', cb),
  onProgress: (cb: (payload: ProgressPayload) => void): (() => void) =>
    subscribe('backup:progress', cb),
  onAction: (cb: (action: PlanAction) => void): (() => void) => subscribe('backup:action', cb),
  onLog: (cb: (entry: LogEntry) => void): (() => void) => subscribe('backup:log', cb),
  onMedia: (cb: (media: MediaState) => void): (() => void) => subscribe('backup:media', cb),
};

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

export type BackupAPI = typeof api;

contextBridge.exposeInMainWorld('backupAPI', api);

export type { AppState, LogEntry, MediaAssessment, MediaState, PlanAction, RecycleBin, RecoverableJob, ScanResult, SyncMode };
