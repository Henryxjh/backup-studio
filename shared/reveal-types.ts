import type { AppState } from './types';

export type BackupRevealSide = 'source' | 'target' | 'renameFrom';

export type BackupRevealRequest =
  | { kind: 'action'; scopeId: string; actionId: string; side: BackupRevealSide }
  | { kind: 'archive'; scopeId: string };

export type BackupRevealErrorCode =
  | 'INVALID_REQUEST'
  | 'FORBIDDEN_SENDER'
  | 'STALE_SCOPE'
  | 'NOT_REGISTERED'
  | 'OUTSIDE_ROOT'
  | 'UNSAFE_LINK'
  | 'NOT_FOUND'
  | 'PATH_CHANGED'
  | 'INACCESSIBLE'
  | 'SHELL_FAILED';

export type BackupRevealResult =
  | { ok: true }
  | { ok: false; code: BackupRevealErrorCode; message: string };

/** 只由主进程装饰 IPC 状态；引擎本身不持有授权 ID。 */
export type BackupRevealState = AppState & { revealScopeId?: string };
