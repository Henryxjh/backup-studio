/**
 * 重复文件查找器的跨进程类型契约。
 *
 * 与 `aut-types.ts` 同构：主进程与渲染层共用同一份定义，避免 IPC 两侧结构漂移。
 */

/** 重复副本所属端 */
export type DupSide = 'source' | 'target';

/**
 * 重复组内的关系类型。
 *
 * - `source-internal`：副本全在源端（源目录自身存在多份相同内容）
 * - `cross-side`：源端与目标端各有副本且相对路径不同（跨端重复）
 */
export type DupRelation = 'source-internal' | 'cross-side';

/** 哈希来源：实算 or 复用清单/排除记录中的历史值 */
export type DupBasis = 'computed' | 'manifest' | 'exclusion';

/** 单个副本。相对路径相同且内容相同的源端/目标端文件合并为一条 `both` 副本 */
export interface DupCopy {
  relPath: string;
  side: DupSide | 'both';
  size: number;
  mtimeMs: number;
  basis: DupBasis;
  /** 硬链接：同一 inode 共享同一份数据，删其一不影响其他 */
  inode?: string;
}

export interface DupGroup {
  /** 内容哈希（SHA-256） */
  hash: string;
  size: number;
  copies: DupCopy[];
  relation: DupRelation;
  /** 规范副本的相对路径；以源端目录结构为准，源端无副本时为 undefined */
  canonical?: string;
  /** 冗余副本（均在源端）；可被排除。带完整元数据，排除记录需要源端 mtime 才能安全复用哈希 */
  redundant: DupCopy[];
  /** 本组可回收字节：冗余副本总大小 */
  reclaimableBytes: number;
  /** 零字节组：所有零字节文件互为重复，不提供采纳入口 */
  zeroByte: boolean;
  /** 硬链接组：同一 inode 多路径，不可互相排除 */
  hardLinked: boolean;
  /** 是否可采纳排除 */
  adoptable: boolean;
  /** 副本列表是否被截断（组内副本过多时只保留前若干条） */
  copiesTruncated: boolean;
}

/** 判定失败：无法完成哈希计算的文件，不参与任何分组 */
export interface DupFailure {
  relPath: string;
  side: DupSide;
  reason: string;
}

export interface DupReport {
  sourceRoot: string;
  targetRoot: string;
  createdAt: number;
  durationMs: number;
  /** 分组列表（可能已按预览上限截断；统计始终基于全量） */
  groups: DupGroup[];
  truncated: boolean;
  totalGroups: number;
  totalCopies: number;
  /** 重复组涉及的总字节 */
  totalBytes: number;
  /** 全部可采纳组的冗余副本总字节 */
  reclaimableBytes: number;
  failures: DupFailure[];
  /** 覆盖完整性：false 表示扫描不完整，报告不可当作全量结论 */
  complete: boolean;
  /** 参与判定的文件数 */
  scannedFiles: number;
  /** 实际参与哈希计算的文件数（size 分桶后才有哈希成本） */
  hashedFiles: number;
  /** 源端 / 目标端扫描错误数 */
  sourceErrors: number;
  targetErrors: number;
}

/** 排除名单中的一条记录 */
export interface DupExclusionEntry {
  /** 内容哈希：排除时的判定依据 */
  hash: string;
  size: number;
  mtimeMs: number;
}

/**
 * 排除名单。
 *
 * 按源目录分组：**绑定源目录，不随目标介质切换而迁移或失效**。
 * 记录 mtime 与哈希，用于在下一次扫描时安全复用历史哈希（size+mtime 同时吻合才复用）。
 */
export interface DupExclusion {
  version: 1;
  bySource: Record<string, Record<string, DupExclusionEntry>>;
  updatedAt: number;
}

export type DupState = 'idle' | 'scanning' | 'hashing' | 'ready' | 'error';

export interface DupEvent {
  at: number;
  action: string;
  detail?: string;
}

export interface DupStatus {
  state: DupState;
  /** 预览用报告（可能已截断；导出仍是全量） */
  report: DupReport | null;
  /** 当前排除名单的源端相对路径 */
  excludedPaths: string[];
  excludedCount: number;
  excludedBytes: number;
  recent: DupEvent[];
  reason?: string;
}

export interface DupApi {
  status(): Promise<DupStatus>;
  scan(sourceRoot: string, targetRoot: string): Promise<DupStatus>;
  /** 采纳排除：按重复组哈希整组采纳 */
  adopt(hashes: string[]): Promise<DupStatus>;
  /** 撤销排除：给定哈希则撤销对应组，不给则撤销全部 */
  revoke(hashes?: string[]): Promise<DupStatus>;
  /** 导出全量报告到本机文件 */
  exportReport(format: 'json' | 'csv'): Promise<{ path: string; bytes: number }>;
  cancel(): Promise<DupStatus>;
}
