import type {
  AppState,
  LogEntry,
  MediaAssessment,
  MediaState,
  PlanAction,
  ScanResult,
  SyncMode,
} from '../../shared/types';
import type { AutoSyncApi } from '../../shared/aut-types';
import type { DupApi } from '../../shared/dup-types';

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

export interface StartOptions {
  sourceRoot: string;
  targetRoot: string;
  syncMode: SyncMode;
  allowMassDelete: boolean;
  resume: boolean;
}

export interface BackupAPI {
  pickDirectory(title: string): Promise<string | null>;
  scan(sourceRoot: string, targetRoot: string): Promise<ScanResult>;
  plan(sourceRoot: string, targetRoot: string, syncMode: SyncMode): Promise<PlanPayload>;
  start(options: StartOptions): Promise<AppState>;
  pause(): Promise<AppState>;
  resume(): Promise<AppState>;
  cancel(): Promise<AppState>;
  getState(): Promise<AppState>;
  cleanupMeta(): Promise<AppState>;
  assess(targetRoot: string): Promise<{ assessment: MediaAssessment; state: AppState }>;
  health(targetRoot: string): Promise<import('../../shared/types').HealthReport>;
  reenumerate(targetRoot: string): Promise<import('../../shared/types').HealthReport>;
  repairDryRun(targetRoot: string, request: import('../../shared/types').RepairRequest): Promise<import('../../shared/types').RepairResult>;
  exportPartitionEvidence(targetRoot: string): Promise<{ auditId: string; guidance: string }>;
  capabilities(): Promise<import('../../shared/types').CapabilityRow[]>;
  recover(confirmed: boolean): Promise<AppState>;
  quarantine(reason: string): Promise<AppState>;
  releaseQuarantine(): Promise<AppState>;
  autoSync: AutoSyncApi;
  duplicateFinder: DupApi;
  reveal(targetPath: string): Promise<void>;
  setTheme(mode: 'light' | 'dark' | 'system'): Promise<'light' | 'dark'>;
  onState(cb: (state: AppState) => void): () => void;
  onPlan(cb: (payload: PlanPayload) => void): () => void;
  onProgress(cb: (payload: ProgressPayload) => void): () => void;
  onAction(cb: (action: PlanAction) => void): () => void;
  onLog(cb: (entry: LogEntry) => void): () => void;
  onMedia(cb: (media: MediaState) => void): () => void;
}

declare global {
  interface Window {
    backupAPI?: BackupAPI;
  }
}

export function getApi(): BackupAPI | null {
  if (typeof window === 'undefined') return null;
  return window.backupAPI ?? null;
}
