/**
 * 重复文件检测与清理（REQ-DUP-001）的跨进程类型契约。
 *
 * 依据 `docs/REQUIREMENTS-003-DUPLICATE-FINDER.md` §9.1 定版，并按实现需要做最小扩展
 * （扩展处均有 `扩展` 注释说明）。与 `aut-types.ts` 同构：主进程与渲染层共用同一份定义，
 * 避免 IPC 两侧结构漂移。
 *
 * 术语与口径：
 * - **内容重复**：两个及以上文件内容哈希相同，**与文件名是否相同无关**（§5）。
 * - **同名不同内容**：同一父目录内同名、但内容哈希不同（§5），是独立告警类，不是重复。
 * - **疑似重复**：大文件跳过全量校验，仅凭「大小 + 首尾局部哈希」判定（FR-03）。
 * - **抑制**：以内容哈希为键的黑名单，命中整组跳过（FR-12）。
 */

/** 结果类别：内容重复 / 同名不同内容 / 疑似重复 */
export type DupCategory = 'identical' | 'same-name-diff-content' | 'suspected';

/**
 * 检测页状态机（§7.1）。
 *
 * `idle` 未选目录；`scanning` 遍历目录；`bucketing` 大小分桶；`partial-hashing` 局部哈希；
 * `hashing` 全量哈希；`summarizing` 汇总；`ready` 结果就绪；`acting` 执行删除；
 * `done` 动作完成；`failed` 失败；`cancelled` 用户取消。
 *
 * 任一阶段被取消一律为 `cancelled`，不得置为 `done`。
 */
export type DupPhase =
  | 'idle'
  | 'scanning'
  | 'bucketing'
  | 'partial-hashing'
  | 'hashing'
  | 'summarizing'
  | 'ready'
  | 'acting'
  | 'done'
  | 'failed'
  | 'cancelled';

/** 单条结果的动作状态（§7.2） */
export type DupItemState =
  /** 未处理 */
  | 'pending'
  /** 用户选择「保留」 */
  | 'kept'
  /** 已进入待删队列 */
  | 'queued'
  /** 已删除（进回收站或隔离区） */
  | 'deleted'
  /** 扫描后已变更，已跳过 */
  | 'skipped'
  /** 被写入闸门或备份互斥阻断 */
  | 'blocked'
  /** 删除失败 */
  | 'failed';

/** 单个文件条目 */
export interface DupFileEntry {
  /** 稳定标识：`absPath` + 内容哈希前缀，同一根目录内唯一 */
  id: string;
  /** 绝对路径 */
  absPath: string;
  /** 相对扫描根的路径 */
  relPath: string;
  /** 父目录绝对路径：同名判定以「同一父目录」为界（FR-05） */
  dirPath: string;
  /** 文件名（含扩展名） */
  fileName: string;
  /** 字节数 */
  size: number;
  /** 修改时间（毫秒） */
  mtimeMs: number;
  /** 文件身份：用于删除前二次校验（FR-09、FR-20） */
  dev: string;
  /** 文件身份：inode */
  ino: string;
  /** 内容哈希；疑似项为局部哈希（此时 `suspected` 为 true） */
  sha256: string;
  /** 首尾 64 KiB 局部哈希（FR-03 第二级） */
  partialHash?: string;
  /** 疑似重复：未做全量校验 */
  suspected?: boolean;
  /** 动作状态 */
  state: DupItemState;
  /** 说明：为什么被跳过 / 被拒绝 / 为什么建议保留 */
  note?: string;
}

/** 一个结果组 */
export interface DupGroup {
  /** 稳定标识：内容重复用哈希，同名不同内容用「父目录 + 文件名」派生 */
  id: string;
  /** 类别 */
  category: DupCategory;
  /** 短哈希指纹：SHA-256 前 8 位十六进制（FR-04） */
  fingerprint: string;
  /**
   * 内容哈希。
   *
   * 内容重复 / 疑似组为组内共有的哈希；同名不同内容组没有共同哈希，为 `undefined`。
   */
  sha256?: string;
  /** 组内条目 */
  entries: DupFileEntry[];
  /** 单份大小（字节） */
  size: number;
  /**
   * 可回收空间 =（份数 − 1）× 单份大小；同名不同内容组恒为 0（FR-17）。
   */
  reclaimableBytes: number;
  /** 建议保留项的条目 id（FR-07 组主规则）；仅建议，不自动删除 */
  suggestedKeeperId?: string;
  /** 父目录（同名不同内容组）；内容重复组为 undefined */
  dirPath?: string;
  /** 文件名（同名不同内容组） */
  fileName?: string;
  /** 该组是否处于抑制黑名单中 */
  suppressed?: boolean;
}

/** 判定失败：无法完成哈希的文件，不参与任何分组 */
export interface DupFailure {
  absPath: string;
  relPath: string;
  reason: string;
}

/** 扫描摘要（FR-17、§9.1） */
export interface DupScanSummary {
  /** 扫描根 */
  root: string;
  /** 参与判定的文件总数 */
  totalFiles: number;
  /** 扫描到的总字节 */
  scannedBytes: number;
  /** 跳过的 0 字节文件数 */
  skippedEmpty: number;
  /** 跳过的低于最小尺寸的文件数 */
  skippedTooSmall: number;
  /** 跳过的符号链接数 */
  skippedSymlink: number;
  /** 因抑制黑名单跳过的组数 */
  skippedSuppressed: number;
  /** 内容重复组数 */
  identicalGroups: number;
  /** 同名不同内容组数 */
  nameConflictGroups: number;
  /** 疑似重复组数 */
  suspectedGroups: number;
  /** 耗时（毫秒） */
  durationMs: number;
}

/** 统计（FR-17）：可回收空间与待删字节必须分开呈现 */
export interface DupStats {
  /** 可回收空间：仅由内容重复组贡献（疑似组按同样口径计入但不保证一致，需界面标注） */
  reclaimableBytes: number;
  /** 待删字节：当前待删队列的总字节 */
  pendingDeleteBytes: number;
  /** 待删文件数 */
  pendingDeleteCount: number;
  /** 涉及组数 */
  pendingDeleteGroups: number;
}

/** 扫描进度（FR-15） */
export interface DupProgress {
  /** 当前阶段 */
  phase: DupPhase;
  /** 阶段显示名 */
  label: string;
  /** 已处理数 */
  done: number;
  /** 总数 */
  total: number;
  /** 已读字节 */
  bytesRead: number;
  /** 当前吞吐（字节/秒） */
  throughputBps: number;
  /** 预计剩余（毫秒）；无法估算时为 undefined */
  etaMs?: number;
}

/** 扫描结果 */
export interface DupScanResult {
  /** 扫描根 */
  root: string;
  /** 摘要 */
  summary: DupScanSummary;
  /** 全部组 */
  groups: DupGroup[];
  /** 内容重复组 */
  identicalGroups: DupGroup[];
  /** 疑似重复组 */
  suspectedGroups: DupGroup[];
  /** 同名不同内容组（独立告警区） */
  nameConflictGroups: DupGroup[];
  /** 判定失败清单 */
  failures: DupFailure[];
  /** 统计 */
  stats: DupStats;
  /** 覆盖完整性：false 表示扫描不完整，结论仅供参考 */
  complete: boolean;
  /** 组列表是否被截断（预览上限；统计始终基于全量） */
  truncated: boolean;
}

/** 抑制项（FR-12）：以内容哈希为键 */
export interface DupSuppression {
  /** 内容哈希 */
  sha256: string;
  /** 短指纹 */
  fingerprint: string;
  /** 作用域根目录 */
  scopeRoot: string;
  /** 作用域模式：当前根 / 全局 */
  scopeMode: 'root' | 'global';
  /** 抑制时间 */
  createdAt: number;
  /** 累计命中次数 */
  hitCount: number;
  /** 样例绝对路径 */
  samplePaths: string[];
  /** 样例文件名 */
  sampleFileNames: string[];
}

/** 单条动作结果 */
export interface DupActItemResult {
  /** 条目 id */
  id: string;
  /** 绝对路径 */
  absPath: string;
  /** 结果 */
  outcome: 'deleted' | 'skipped-changed' | 'blocked' | 'failed';
  /** 原因说明 */
  reason?: string;
  /** 落地方式：系统回收站 / 本机隔离区 */
  landedTo?: 'system-trash' | 'quarantine';
  /** 隔离区条目 id：降级落地时给出，界面据此提供「还原」入口（FR-08） */
  quarantineId?: string;
}

/** 批量动作结果 */
export interface DupActResult {
  /** 逐条结果 */
  items: DupActItemResult[];
  /** 成功删除数 */
  deleted: number;
  /** 跳过数（扫描后已变更） */
  skipped: number;
  /** 被闸门阻断数 */
  blocked: number;
  /** 失败数 */
  failed: number;
  /** 实际释放字节 */
  reclaimedBytes: number;
  /** 是否发生过降级：本机隔离区（FR-08） */
  degradedToQuarantine: boolean;
  /**
   * 审计日志是否写入失败（FR-19）。
   *
   * 审计是辅助证据，写失败不改变删除结果，但必须如实告知调用方，
   * 不能静默吞掉——否则用户以为每次动作都有据可查。
   */
  auditFailed?: boolean;
}

/** 逐条动作：保留 / 删除 / 下次不提醒（FR-06） */
export type DupItemAction = 'keep' | 'delete' | 'suppress';

/** 执行删除的请求（FR-09、FR-10、FR-18、FR-20） */
export interface DupActRequest {
  /** 扫描根；主进程据此做路径边界校验 */
  root: string;
  /** 待删条目：主进程必须逐条校验它确实来自本次扫描结果 */
  items: {
    id: string;
    absPath: string;
    groupId: string;
    /** 扫描时记录的内容哈希 */
    sha256: string;
    size: number;
    dev: string;
    ino: string;
  }[];
  /** 涉及的组 id：用于「每组至少保留一份」校验（FR-11） */
  groupIds: string[];
  /** 确认类别：同名不同内容区需要两次确认（FR-18） */
  category: DupCategory;
  /**
   * 同名不同内容告警区的显式二次确认（FR-18）。
   *
   * 告警区的条目**没有**内容相同的副本，删除它就是删除唯一一份，
   * 因此主进程必须看到显式确认才放行；未携带该标志时一律拒绝。
   */
  confirmSameNameConflict?: boolean;
}

/**
 * 本机隔离区条目（FR-08 降级路径）。
 *
 * 系统回收站不可用时，删除的文件被移动到本机隔离区而不是被丢弃，
 * 必须可列出、可还原——否则用户重启后就再也找不回这些文件。
 */
export interface DupQuarantineEntry {
  /** 隔离区条目 id */
  id: string;
  /** 被删除前的原始绝对路径（还原时写回这里） */
  originalPath: string;
  /** 文件大小（字节） */
  size: number;
  /** 进入隔离区的时间戳 */
  deletedAt: number;
  /** 已还原过（保留记录以便追溯，不再重复还原） */
  restored?: boolean;
}

/** 事件流条目（审计脱敏后写入，FR-19） */
export interface DupEvent {
  at: number;
  /** 动作类型 */
  action: string;
  /** 明细（已脱敏） */
  detail?: string;
  /** 结果 */
  outcome?: 'ok' | 'skipped' | 'blocked' | 'failed';
}

/** 检测页整体状态 */
export interface DupStatus {
  /** 当前阶段 */
  phase: DupPhase;
  /** 进度 */
  progress: DupProgress;
  /** 扫描结果；未扫描时为 null */
  result: DupScanResult | null;
  /** 抑制清单 */
  suppressions: DupSuppression[];
  /** 最近事件 */
  recent: DupEvent[];
  /** 全局原因说明（失败 / 取消 / 降级等） */
  reason?: string;
  /** 删除是否被禁止（备份运行中 / 闸门不放行） */
  blockedReason?: string;
  /** 删除入口是否可用 */
  canAct: boolean;
  /**
   * 当前扫描根。
   *
   * 渲染层切换工作区会卸载检测页，回来时需要据此回填目录，
   * 否则「保留 / 删除 / 定位」等动作会因缺少根而静默失效。
   */
  currentRoot?: string;
  /** 本机隔离区条目（FR-08 降级路径，可还原） */
  quarantine?: DupQuarantineEntry[];
}

/** 渲染层可调用的接口（主进程是唯一写入点，FR-20） */
export interface DupApi {
  /** 当前状态 */
  status(): Promise<DupStatus>;
  /** 扫描一个目录（FR-02） */
  scan(root: string, options?: { minSizeBytes?: number }): Promise<DupStatus>;
  /** 取消扫描或取消剩余删除项（FR-15） */
  cancel(): Promise<DupStatus>;
  /** 逐条标记动作（会话内状态；FR-06） */
  markAction(root: string, itemIds: string[], action: DupItemAction): Promise<DupStatus>;
  /** 组级动作：保留此份，其余可删（FR-07） */
  keepGroup(root: string, groupId: string, keeperId: string): Promise<DupStatus>;
  /** 执行删除（二次校验 + 闸门 + 回收站落地；FR-08/09/10/11/18/20） */
  act(root: string, request: DupActRequest): Promise<DupActResult>;
  /** 抑制：把内容哈希写入黑名单（FR-12） */
  suppress(
    root: string,
    sha256: string,
    scopeMode: 'root' | 'global',
    samplePaths: string[],
  ): Promise<DupStatus>;
  /** 抑制清单（FR-13） */
  listSuppressions(root: string): Promise<DupSuppression[]>;
  /** 撤销单条 / 全部抑制（FR-13） */
  revokeSuppression(sha256?: string): Promise<DupStatus>;
  /** 导出全量报告到本机文件 */
  exportReport(format: 'json' | 'csv'): Promise<{ path: string; bytes: number }>;
  /** 还原隔离区中的文件（FR-08 降级路径） */
  restoreQuarantine(id: string, overwrite?: boolean): Promise<{ restored: boolean; path?: string; reason?: string }>;
  /** 列出本机隔离区条目（FR-08 降级路径；重启后仍须能还原） */
  listQuarantine(): Promise<DupQuarantineEntry[]>;
  /**
   * 受校验的「定位文件」：路径必须落在本次扫描根之内，且确实是本次扫描结果中的条目。
   *
   * 与备份主页那条无校验的定位通道不同，这里由主进程做边界判定，
   * 伪造路径一律拒绝；文件已不存在时抛出明确错误，不静默失败（FR-14、FR-20）。
   */
  reveal(root: string, absPath: string): Promise<{ revealed: boolean }>;
}
