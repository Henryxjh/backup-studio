export interface AutoPairInput {
  sourceRoot: string;
  targetRoot: string;
  excludes?: string[];
  syncDeletes?: boolean;
  retentionDays?: number;
  recycleMaxBytes?: number;
  externalChanges?: 'pause' | 'overwrite';
  pollOnly?: boolean;
  pollMs?: number;
  stableMs?: number;
  allowSnapshotFiles?: boolean;
  /** 版本历史总容量上限（字节）。 */
  historyMaxBytes?: number;
  /** 单个路径保留的历史版本数量上限。 */
  historyMaxVersionsPerPath?: number;
}

export interface AutoPair extends Required<AutoPairInput> { id: string; enabled: boolean }
export type AutoRunState = 'off' | 'scanning' | 'syncing' | 'idle' | 'waiting' | 'paused' | 'error';
export type AutoBlockCode = 'offline' | 'isolated' | 'level2' | 'repair-required' | 'health-unknown' | 'denied';
export interface AutoBlock { code: AutoBlockCode; reason: string; evidence?: readonly string[] }
export interface AutoEvent { at: number; action: string; detail?: string }

/** 回收站条目：删除或替换前的受管副本，可在保留期内撤回。 */
export interface AutoRecycleEntry {
  id: string;
  relPath: string;
  size: number;
  at: number;
  expiresAt: number;
  kind: 'delete' | 'replace';
  pending?: boolean;
  /** 受保护副本的内容哈希。 */
  hash?: string;
  /** 关联的历史版本 ID。 */
  versionId?: string;
}

/** 一次变更的类型。 */
export type AutoChangeKind = 'add' | 'modify' | 'delete' | 'restore' | 'replace';

/** 一次同步提交中的单条变更，语义类似 git commit 的文件条目。 */
export interface AutoChange {
  relPath: string;
  kind: AutoChangeKind;
  hash?: string;
  size?: number;
  versionId?: string;
}

/** 一次同步提交（commit）。 */
export interface AutoCommit {
  id: string;
  pairId: string;
  at: number;
  changes: AutoChange[];
}

/** 一个路径的历史版本（blob + 元数据）。 */
export interface AutoVersion {
  id: string;
  pairId: string;
  relPath: string;
  hash: string;
  size: number;
  at: number;
  commitId: string;
  kind: AutoChangeKind;
  /** 同一路径的上一版本 ID。 */
  previousId?: string;
}

/** 配对的历史记录：提交日志 + 版本索引。 */
export interface AutoHistory {
  commits: AutoCommit[];
  versions: AutoVersion[];
}

/** 单个配对的状态。 */
export interface AutoPairStatus {
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
  /** 本次软件运行期间被受管同步的删除数量。 */
  sessionDeletes: number;
  /** 本次软件运行前发生的删除（不归软件管，保留在备份端）。 */
  unmanagedDeletes: number;
}

/** 整体状态：支持多个配对。 */
export interface AutoStatus {
  pairs: AutoPairStatus[];
  /** 聚合状态：任一配对处于活动态即为活动态。 */
  state: AutoRunState;
  /** 界面当前聚焦的配对 ID。 */
  activePairId?: string;
}

export interface AutoSyncApi {
  status(): Promise<AutoStatus>;
  /** 新增一个配对，返回更新后的整体状态。 */
  addPair(input: AutoPairInput): Promise<AutoStatus>;
  /** 更新指定配对的设置。 */
  updatePair(pairId: string, input: Partial<AutoPairInput>): Promise<AutoStatus>;
  /** 移除配对。已产生的历史记录保留在备份介质上。 */
  removePair(pairId: string): Promise<AutoStatus>;
  setEnabled(pairId: string, enabled: boolean): Promise<AutoStatus>;
  resume(pairId: string): Promise<AutoStatus>;
  /** 从回收站撤回一个条目。 */
  restore(pairId: string, recycleId: string): Promise<AutoStatus>;
  /** 撤回某个历史版本。 */
  restoreVersion(pairId: string, versionId: string): Promise<AutoStatus>;
  /** 读取配对的历史提交与版本。 */
  history(pairId: string): Promise<AutoHistory>;
}
