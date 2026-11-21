import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type {
  DupActRequest,
  DupApi,
  DupCategory,
  DupFileEntry,
  DupGroup,
  DupItemAction,
  DupPhase,
  DupQuarantineEntry,
  DupStatus,
} from '../../../shared/dup-types';
import { VirtualList } from '../VirtualList';
import { FileName } from '../FileName';
import { IconAlert, IconFolder, IconTrash, IconX } from '../Icons';
import { SuppressPanel } from './SuppressPanel';
import { isScanActive } from './scanState';
import { fmtBytes, fmtDuration, fmtInt, fmtThroughput } from '../../lib/format';
import './duplicate-finder.css';

/** 单行高度：虚拟列表按固定行高渲染 */
const ROW_HEIGHT = 44;

/** 判定流水线五阶段（FR-03 / FR-15） */
const STAGES: { phase: DupPhase; label: string }[] = [
  { phase: 'scanning', label: '扫描目录' },
  { phase: 'bucketing', label: '大小分桶' },
  { phase: 'partial-hashing', label: '局部哈希' },
  { phase: 'hashing', label: '全量哈希' },
  { phase: 'summarizing', label: '汇总' },
];

const PHASE_LABEL: Record<DupPhase, string> = {
  idle: '待选目录',
  scanning: '扫描目录',
  bucketing: '大小分桶',
  'partial-hashing': '局部哈希',
  hashing: '全量哈希',
  summarizing: '汇总',
  ready: '结果就绪',
  acting: '执行删除',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const CATEGORY_LABEL: Record<DupCategory, string> = {
  identical: '内容重复',
  suspected: '疑似重复（未全量校验）',
  'same-name-diff-content': '同名不同内容',
};

const STATE_LABEL: Record<DupFileEntry['state'], string> = {
  pending: '未处理',
  kept: '保留',
  queued: '待删',
  deleted: '已删除',
  skipped: '已跳过',
  blocked: '被阻断',
  failed: '失败',
};

/**
 * 条目意图：保留 / 删除 / 下次不提醒。
 *
 * 三态互斥，同一条目同一时刻只有一个意图（FR-06）。
 * 这是用户决策的**唯一**来源：勾选框只是批量操作的工作集，不表达任何删除意图。
 */
type ItemIntent = DupItemAction;

const INTENT_LABEL: Record<ItemIntent, string> = {
  keep: '保留',
  delete: '待删',
  suppress: '下次不提醒',
};

const CONFLICT_SUPPRESS_REASON =
  '同名不同内容组没有共同内容哈希，整组抑制不成立；请对单份文件使用「下次不提醒」';

type ActItem = DupActRequest['items'][number];

/** 抑制目标：按内容哈希分组，一次抑制覆盖同哈希的全部条目（FR-12） */
interface SuppressTarget {
  sha256: string;
  entries: DupFileEntry[];
}

interface ConfirmState {
  category: DupCategory;
  items: ActItem[];
  groupIds: string[];
  count: number;
  bytes: number;
  groups: number;
  /** 同名不同内容区需要两次确认（FR-18） */
  step: 1 | 2;
}

type Row =
  | { kind: 'group'; group: DupGroup }
  | { kind: 'entry'; group: DupGroup; entry: DupFileEntry };

function timeText(ts: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function baseName(absPath: string): string {
  const cut = Math.max(absPath.lastIndexOf('\\'), absPath.lastIndexOf('/'));
  return cut >= 0 ? absPath.slice(cut + 1) : absPath;
}

/**
 * 指纹截断：首尾各留 4 位，中间省略。
 *
 * 标题行放不下完整哈希，但用户随时可能要核对完整值，
 * 所以这里只压缩显示，取回完整值的路径（悬停、单击复制）必须始终保留。
 */
function shortFingerprint(value: string): string {
  if (value.length < 8) return value;
  return `${value.slice(0, 4)}……${value.slice(-4)}`;
}

/**
 * 写入剪贴板：优先用渲染层原生能力。
 *
 * 原生剪贴板在权限被拒时不会写入，此时退回传统复制路径：
 * 用户仍然要把完整指纹拿走，不能因为接口不可用就静默失败。
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落到兜底路径
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/**
 * 条目当前意图：本地意图优先，未表态时回落到引擎记录的状态。
 *
 * 引擎是保留/删除的持久事实来源，本地只额外承载「下次不提醒」与乐观更新，
 * 两者合起来才是界面上显示的那个状态。
 */
function intentOf(
  entry: DupFileEntry,
  intents: Record<string, ItemIntent>,
): ItemIntent | undefined {
  const local = intents[entry.id];
  if (local) return local;
  if (entry.state === 'kept') return 'keep';
  if (entry.state === 'queued') return 'delete';
  return undefined;
}

/** 条目对外显示的状态：执行结果（已删除/失败等）优先于意图 */
function displayState(
  entry: DupFileEntry,
  intents: Record<string, ItemIntent>,
): DupFileEntry['state'] {
  if (entry.state === 'deleted' || entry.state === 'skipped' || entry.state === 'blocked' || entry.state === 'failed') {
    return entry.state;
  }
  const intent = intentOf(entry, intents);
  if (intent === 'keep') return 'kept';
  if (intent === 'delete') return 'queued';
  return entry.state;
}

/**
 * 绝对路径：目录部分从左省略（保留最近的父目录），文件名走中间省略、后缀完整。
 */
function DupPath({ absPath, relPath }: { absPath: string; relPath: string }) {
  const cut = Math.max(absPath.lastIndexOf('\\'), absPath.lastIndexOf('/'));
  const sep = cut >= 0 ? absPath[cut] : '';
  const dir = cut >= 0 ? absPath.slice(0, cut) : '';
  const name = cut >= 0 ? absPath.slice(cut + 1) : absPath;
  return (
    <span className="dup-path" title={`${relPath}\n${absPath}`}>
      {dir ? (
        <span className="dup-path-dir"><bdi dir="ltr">{dir}{sep}</bdi></span>
      ) : null}
      <FileName value={name} />
    </span>
  );
}

/**
 * 指纹标签：截断显示 + 悬停给完整值 + 单击复制完整值。
 *
 * 指纹是判断「两份文件内容是否真的一样」的唯一凭据，
 * 截断只是显示层的取舍，取回完整值的路径必须一直留在界面上。
 * 复制后要给出可见反馈：剪贴板写入本身没有任何画面，
 * 没有反馈用户无从判断到底复制成功没有。
 */
function FingerprintTag({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const handleCopy = useCallback(async () => {
    const ok = await copyToClipboard(value);
    if (!ok) return;
    setCopied(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 2500);
  }, [value]);

  return (
    <button
      type="button"
      className="dup-fingerprint"
      data-copied={copied ? 'true' : undefined}
      title={value}
      aria-label={copied ? '已复制指纹' : `复制指纹 ${value}`}
      onClick={() => void handleCopy()}
    >
      {copied ? '已复制' : shortFingerprint(value)}
    </button>
  );
}

export interface DuplicateFinderPageProps {
  api: DupApi;
  /** 复用既有目录选择框（FR-02） */
  pickDirectory: (title: string) => Promise<string | null>;
  /** 返回备份主界面（FR-01） */
  onBack: () => void;
  /** 备份任务或自动同步正在运行：删除动作必须禁用（FR-10） */
  backupRunning?: boolean;
}

/**
 * 重复文件检测独立页面（REQ-DUP-001）。
 *
 * 语义要点：
 * - 「内容重复」与「同名不同内容」是**两件事**：前者可回收空间，后者删了不省空间
 * - 删除只进系统回收站，界面不提供任何不可撤销的删除入口（FR-08 / FR-20）
 * - 同名不同内容区默认不预选任何删除项（FR-05）
 * - 工作区切换会卸载本页，目录与结果必须能靠状态回填，否则动作会静默失效
 */
export function DuplicateFinderPage({
  api,
  pickDirectory,
  onBack,
  backupRunning = false,
}: DuplicateFinderPageProps) {
  const [status, setStatus] = useState<DupStatus | null>(null);
  const [root, setRoot] = useState('');
  const [scanPending, setScanPending] = useState(false);
  const pollVersion = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [actSummary, setActSummary] = useState('');
  /** 本机隔离区条目：降级落地时删除的文件在这里，可逐条还原（FR-08） */
  const [quarantine, setQuarantine] = useState<DupQuarantineEntry[]>([]);
  const [quarantineOpen, setQuarantineOpen] = useState(false);
  const [reportNote, setReportNote] = useState('');
  /** 条目意图：保留 / 删除 / 下次不提醒 的唯一来源，三态互斥（FR-06） */
  const [intents, setIntents] = useState<Record<string, ItemIntent>>({});
  /** 批量操作的工作集：只表示「本次批量作用的对象」，不表达任何删除意图 */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [keeperChoice, setKeeperChoice] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [suppressOpen, setSuppressOpen] = useState(false);
  const [scopeMode, setScopeMode] = useState<'root' | 'global'>('root');

  const perform = useCallback(async (fn: () => Promise<DupStatus>) => {
    setBusy(true);
    setError('');
    try {
      const next = await fn();
      setStatus(next);
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * 隔离区条目必须来自引擎的持久列表。
   *
   * 只靠本次 act() 的返回值，重启或切页后还原入口就消失了，文件再也回不来（FR-08）。
   */
  const loadQuarantine = useCallback(
    async (fallback?: DupQuarantineEntry[]) => {
      try {
        const list = await api.listQuarantine();
        setQuarantine(Array.isArray(list) ? list : []);
      } catch {
        // 引擎尚未提供隔离区列表时，退回状态里带回的条目，不能因此丢掉还原入口
        if (fallback) setQuarantine(fallback);
      }
    },
    [api],
  );

  useEffect(() => {
    let stopped = false;
    void (async () => {
      try {
        const value = await api.status();
        if (stopped) return;
        setStatus(value);
        // 本页会被工作区切换卸载：目录只能从状态回填，否则回来后所有动作都因缺根而静默失效
        const backfilled = value.currentRoot ?? value.result?.root ?? '';
        if (backfilled) setRoot((prev) => prev || backfilled);
        await loadQuarantine(value.quarantine);
      } catch {
        if (!stopped) setError('无法读取重复文件检测状态');
      }
    })();
    return () => {
      stopped = true;
    };
  }, [api, loadQuarantine]);

  const phase = status?.phase ?? 'idle';
  const scanning = isScanActive(scanPending, phase);

  // 扫描过程没有事件推送，靠轮询把五阶段进度搬到界面上
  useEffect(() => {
    if (!scanning) return undefined;
    let stopped = false;
    let inFlight = false;
    const timer = window.setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      const version = pollVersion.current;
      void api
        .status()
        .then((next) => {
          if (!stopped && version === pollVersion.current) setStatus(next);
        })
        .catch(() => undefined)
        .finally(() => { inFlight = false; });
    }, 350);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [api, scanning]);

  // 引擎是保留/删除的持久事实来源：状态回来后同步到本地意图，保证重新挂载后显示一致
  useEffect(() => {
    if (!status?.result) return;
    const derived: Record<string, ItemIntent> = {};
    const cleared = new Set<string>();
    for (const group of status.result.groups) {
      for (const entry of group.entries) {
        if (entry.state === 'kept') derived[entry.id] = 'keep';
        else if (entry.state === 'queued') derived[entry.id] = 'delete';
        else if (entry.state === 'deleted' || entry.state === 'skipped') cleared.add(entry.id);
      }
    }
    if (!Object.keys(derived).length && !cleared.size) return;
    setIntents((prev) => {
      const next = { ...prev };
      for (const id of cleared) delete next[id];
      for (const [id, intent] of Object.entries(derived)) {
        // 抑制按内容哈希生效，不能被条目状态推导覆盖
        if (next[id] === 'suppress') continue;
        next[id] = intent;
      }
      return next;
    });
  }, [status]);

  const result = status?.result ?? null;
  const progress = status?.progress;
  const suppressions = status?.suppressions ?? [];
  const recent = status?.recent ?? [];

  const actBlockedReason = (() => {
    if (scanning) return '检测进行中，暂不能删除';
    if (backupRunning) return '备份任务或自动同步正在运行，暂不能删除';
    if (status && !status.canAct) return status.blockedReason ?? '当前介质状态不允许删除';
    return undefined;
  })();

  /**
   * 动作前置校验：缺目录时必须给出可见原因，不能静默返回。
   *
   * 目录靠 status 回填，回填失败时用户点的每个动作都必须看到「为什么不能做」。
   */
  const requireRoot = useCallback(
    (label: string): string | null => {
      if (root) return root;
      setError(`无法${label}：当前没有检测目录。请先选择目录并执行检测。`);
      return null;
    },
    [root],
  );

  /** 删除类动作的校验：除目录外还要有结果，且删除入口必须放行（FR-10） */
  const requireDelete = useCallback(
    (label: string): string | null => {
      const base = requireRoot(label);
      if (!base) return null;
      if (!result) {
        setError(`无法${label}：当前没有检测结果，请先执行检测。`);
        return null;
      }
      if (actBlockedReason) {
        setError(`无法${label}：${actBlockedReason}`);
        return null;
      }
      return base;
    },
    [actBlockedReason, requireRoot, result],
  );

  const groupsOf = useCallback(
    (category: DupCategory): DupGroup[] => {
      if (!result) return [];
      const source =
        category === 'identical'
          ? result.identicalGroups
          : category === 'suspected'
            ? result.suspectedGroups
            : result.nameConflictGroups;
      return source.filter((group) => !group.suppressed);
    },
    [result],
  );

  /** 写入本地意图；intent 为 null 表示撤销该条目的意图 */
  const writeIntents = useCallback((ids: string[], intent: ItemIntent | null) => {
    setIntents((prev) => {
      const next = { ...prev };
      for (const id of ids) {
        if (intent) next[id] = intent;
        else delete next[id];
      }
      return next;
    });
  }, []);

  const handleBrowse = useCallback(async () => {
    setError('');
    const picked = await pickDirectory('选择要检测重复文件的目录');
    if (!picked) return;
    setRoot(picked);
  }, [pickDirectory]);

  const handleScan = useCallback(() => {
    const base = requireRoot('开始检测');
    if (!base) return;
    setError('');
    setNotice('');
    setActSummary('');
    setSelected(new Set());
    setKeeperChoice({});
    setIntents({});
    pollVersion.current += 1;
    setScanPending(true);
    void perform(async () => {
      try {
        return await api.scan(base);
      } finally {
        pollVersion.current += 1;
        setScanPending(false);
      }
    });
  }, [api, perform, requireRoot]);

  const handleCancel = useCallback(async () => {
    try {
      const next = await api.cancel();
      pollVersion.current += 1;
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : '取消失败');
    }
  }, [api]);

  /** 逐条明确选择：直接改写意图，并同步给引擎 */
  const handleMark = useCallback(
    async (ids: string[], action: DupItemAction) => {
      if (!ids.length) return;
      const label = action === 'delete' ? '标记删除' : '标记保留';
      const base = action === 'delete' ? requireDelete(label) : requireRoot(label);
      if (!base) return;
      setError('');
      setNotice('');
      const before = intents;
      writeIntents(ids, action);
      try {
        const next = await api.markAction(base, ids, action);
        setStatus(next);
      } catch (err) {
        // 引擎拒绝时回滚本地意图，避免界面显示与引擎状态不一致
        setIntents(before);
        setError(err instanceof Error ? err.message : `${label}失败`);
      }
    },
    [api, intents, requireDelete, requireRoot, writeIntents],
  );

  /** 批量选择：不得覆盖已明确的逐条选择（FR-06） */
  const handleMarkBatch = useCallback(
    async (ids: string[], action: DupItemAction) => {
      if (!ids.length) return;
      const label = action === 'delete' ? '批量标记删除' : '批量标记保留';
      const base = action === 'delete' ? requireDelete(label) : requireRoot(label);
      if (!base) return;
      const targets = ids.filter((id) => !intents[id]);
      const skipped = ids.length - targets.length;
      if (!targets.length) {
        setError(`${label}未执行：所选 ${ids.length} 项都已有明确的逐条选择，批量操作不会覆盖它们。`);
        return;
      }
      setError('');
      setNotice('');
      const before = intents;
      writeIntents(targets, action);
      try {
        const next = await api.markAction(base, targets, action);
        setStatus(next);
        setNotice(
          skipped
            ? `已标记 ${targets.length} 项；${skipped} 项已有明确的逐条选择，未被覆盖。`
            : '',
        );
      } catch (err) {
        setIntents(before);
        setError(err instanceof Error ? err.message : `${label}失败`);
      }
    },
    [api, intents, requireDelete, requireRoot, writeIntents],
  );

  /** 撤销待删：把待删意图改回保留 */
  const handleRevokeQueued = useCallback(
    async (ids: string[]) => {
      if (!ids.length) return;
      const base = requireRoot('撤销待删');
      if (!base) return;
      setError('');
      setNotice('');
      const before = intents;
      writeIntents(ids, 'keep');
      try {
        const next = await api.markAction(base, ids, 'keep');
        setStatus(next);
      } catch (err) {
        setIntents(before);
        setError(err instanceof Error ? err.message : '撤销待删失败');
      }
    },
    [api, intents, requireRoot, writeIntents],
  );

  /** 组级动作：保留此份，其余可删（FR-07） */
  const handleKeepGroup = useCallback(
    async (group: DupGroup, keeperId: string) => {
      const base = requireRoot('组级保留');
      if (!base) return;
      if (!keeperId) {
        setError('组级保留失败：该组没有可选的保留项。');
        return;
      }
      setError('');
      setNotice('');
      const before = intents;
      writeIntents([keeperId], 'keep');
      writeIntents(
        group.entries.filter((entry) => entry.id !== keeperId).map((entry) => entry.id),
        'delete',
      );
      try {
        const next = await api.keepGroup(base, group.id, keeperId);
        setStatus(next);
      } catch (err) {
        setIntents(before);
        setError(err instanceof Error ? err.message : '组级保留失败');
      }
    },
    [api, intents, requireRoot, writeIntents],
  );

  /**
   * 抑制：整批必须串行。
   *
   * 并发调用会争抢同一份 busy/error 状态：busy 提前解除，报错也被后一次清空抹掉。
   */
  const handleSuppress = useCallback(
    async (targets: SuppressTarget[]) => {
      if (!targets.length) return;
      const base = requireRoot('加入抑制清单');
      if (!base) return;
      setError('');
      setNotice('');
      setBusy(true);
      let done = 0;
      let lastError = '';
      for (const target of targets) {
        try {
          const next = await api.suppress(
            base,
            target.sha256,
            scopeMode,
            target.entries.map((entry) => entry.absPath),
          );
          setStatus(next);
          writeIntents(
            target.entries.map((entry) => entry.id),
            'suppress',
          );
          done += 1;
        } catch (err) {
          lastError = err instanceof Error ? err.message : '抑制失败';
        }
      }
      setBusy(false);
      if (lastError) {
        setError(`抑制未全部成功（${done}/${targets.length} 条抑制记录已保存）：${lastError}`);
      } else {
        setNotice(
          `已保存 ${done} 条抑制记录，作用域${scopeMode === 'global' ? '全局' : '当前根'}。`,
        );
      }
    },
    [api, requireRoot, scopeMode, writeIntents],
  );

  const handleReveal = useCallback(
    async (entry: DupFileEntry) => {
      const base = requireRoot('定位文件');
      if (!base) return;
      setError('');
      setNotice('');
      try {
        // 走受校验的定位通道：路径必须落在本次扫描根内且是真实扫描结果（FR-14、FR-20）
        await api.reveal(base, entry.absPath);
      } catch (err) {
        setError(err instanceof Error ? err.message : `文件已不存在或不可访问：${entry.absPath}`);
      }
    },
    [api, requireRoot],
  );

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** 下拉框只记录「保留哪份」的意图，由「保留此份，其余可删」按钮显式执行（FR-07） */
  const handleKeeperChange = useCallback((groupId: string, keeperId: string) => {
    setKeeperChoice((prev) => ({ ...prev, [groupId]: keeperId }));
  }, []);

  /**
   * 执行删除前先按「每组至少保留一份」分组校验（FR-11）：
   * 整组都被标成删除的组不纳入本次请求，自动把建议保留项改回保留。
   */
  const requestExecute = useCallback(
    async (category: DupCategory) => {
      const base = requireDelete('执行删除');
      if (!base) return;
      const groups = groupsOf(category);
      const violating: DupGroup[] = [];
      const items: ActItem[] = [];
      const groupIds: string[] = [];

      for (const group of groups) {
        const queued = group.entries.filter((entry) => intentOf(entry, intents) === 'delete');
        if (!queued.length) continue;
        if (queued.length === group.entries.length) {
          violating.push(group);
          continue;
        }
        groupIds.push(group.id);
        for (const entry of queued) {
          items.push({
            id: entry.id,
            absPath: entry.absPath,
            groupId: group.id,
            sha256: entry.sha256,
            size: entry.size,
            dev: entry.dev,
            ino: entry.ino,
          });
        }
      }

      if (violating.length) {
        // 整组都被标成删除的组：整组回退为保留，宁可少删也不让任何一组被清空
        const keeperIds = violating.flatMap((group) =>
          group.entries.map((entry) => entry.id),
        );
        try {
          if (keeperIds.length) {
            await api.markAction(base, keeperIds, 'keep');
            writeIntents(keeperIds, 'keep');
          }
          setNotice(
            `该组至少保留一份：${violating.length} 个组被整组标记为删除，本次未删除这些组中的任何文件（已全部保留，含建议保留项）。`,
          );
          setStatus(await api.status());
        } catch (err) {
          setError(err instanceof Error ? err.message : '执行删除前的分组校验失败');
          return;
        }
      }

      if (!items.length) {
        if (!violating.length) {
          setError('当前没有待删文件：请先对条目选择「删除」，或勾选后使用「删除所选」。');
        }
        return;
      }

      setConfirm({
        category,
        items,
        groupIds,
        count: items.length,
        bytes: items.reduce((sum, item) => sum + item.size, 0),
        groups: groupIds.length,
        step: 1,
      });
    },
    [api, groupsOf, intents, requireDelete, writeIntents],
  );

  const executeDelete = useCallback(async () => {
    if (!confirm) return;
    const base = requireDelete('执行删除');
    if (!base) {
      setConfirm(null);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const outcome = await api.act(base, {
        root: base,
        items: confirm.items,
        groupIds: confirm.groupIds,
        category: confirm.category,
        // 同名不同内容区没有内容相同的副本，删除就是丢掉唯一一份，
        // 主进程要求显式的二次确认标志，缺失时一律拒绝（FR-18）
        confirmSameNameConflict:
          confirm.category === 'same-name-diff-content' ? true : undefined,
      });
      const bits = [
        `成功删除 ${outcome.deleted} 个`,
        `跳过 ${outcome.skipped} 个`,
        `被阻断 ${outcome.blocked} 个`,
        `失败 ${outcome.failed} 个`,
        `释放 ${fmtBytes(outcome.reclaimedBytes)}`,
      ];
      setActSummary(bits.join('，'));
      if (outcome.degradedToQuarantine) {
        setNotice(
          '系统回收站不可用，本次删除已降级为本机隔离区（可还原）。请在右上角「隔离区」中逐条还原。',
        );
      }
      setConfirm(null);
      setSelected(new Set());
      setStatus(await api.status());
      await loadQuarantine();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }, [api, confirm, loadQuarantine, requireDelete]);

  /** 还原隔离区中的文件：还原失败要如实告知，不静默吞掉（FR-08） */
  const handleRestore = useCallback(
    async (id: string) => {
      setError('');
      setNotice('');
      try {
        const outcome = await api.restoreQuarantine(id);
        if (!outcome.restored) {
          setError(outcome.reason ?? '还原失败');
          return;
        }
        setNotice(`已还原到原路径：${outcome.path ?? ''}`);
        // 还原后刷新隔离区与检测结果，避免界面停留在已删除的状态
        await loadQuarantine();
        setStatus(await api.status());
      } catch (err) {
        setError(err instanceof Error ? err.message : '还原失败');
      }
    },
    [api, loadQuarantine],
  );

  /** 报告导出：路径要回显给用户，失败也要说明原因（FR-19） */
  const handleExport = useCallback(
    async (format: 'json' | 'csv') => {
      setError('');
      setReportNote('');
      try {
        const outcome = await api.exportReport(format);
        setReportNote(`报告已导出：${outcome.path}（${fmtInt(outcome.bytes)} 字节）`);
      } catch (err) {
        setError(err instanceof Error ? err.message : '导出报告失败');
      }
    },
    [api],
  );

  const stats = result?.stats;
  const summary = result?.summary;
  const truncated = result?.truncated ?? false;

  return (
    <div className="dup-page">
      <header className="dup-page-bar">
        <button className="btn btn-sm" type="button" onClick={onBack}>
          返回主界面
        </button>
        <h1>重复文件检测</h1>
        <span className="dup-phase" aria-live="polite">
          {PHASE_LABEL[phase]}
        </span>
        <div className="dup-toolbar">
          <label className="dup-scope">
            抑制作用域
            <select
              value={scopeMode}
              onChange={(event) => setScopeMode(event.target.value as 'root' | 'global')}
              aria-label="抑制作用域"
            >
              <option value="root">当前根</option>
              <option value="global">全局</option>
            </select>
          </label>
          <button
            className="btn btn-sm"
            type="button"
            onClick={() => setSuppressOpen(true)}
            aria-label={`抑制清单，当前 ${suppressions.length} 项`}
          >
            抑制清单 ({suppressions.length})
          </button>
          <button
            className="btn btn-sm"
            type="button"
            onClick={() => {
              setQuarantineOpen(true);
              void loadQuarantine();
            }}
            aria-label={`本机隔离区，当前 ${quarantine.length} 项`}
          >
            隔离区 ({quarantine.length})
          </button>
        </div>
      </header>

      <div className="dup-page-body">
        <section className="dup-scan-bar">
          <div className="path-field-row dup-path-row">
            <span className="path-icon">
              <IconFolder size={15} />
            </span>
            <input
              className="path-field"
              value={root}
              spellCheck={false}
              placeholder="选择要检测重复文件的目录"
              onChange={(event) => setRoot(event.target.value)}
            />
            <button className="btn btn-sm" type="button" onClick={() => void handleBrowse()} disabled={busy}>
              浏览
            </button>
          </div>
          <div className="dup-scan-actions">
            <button
              className="btn btn-primary btn-sm"
              type="button"
              disabled={busy || !root || scanning}
              onClick={handleScan}
            >
              {scanning ? '检测中' : '开始检测'}
            </button>
            <button className="btn btn-sm" type="button" disabled={!scanning} onClick={handleCancel}>
              取消
            </button>
          </div>
          <p className="dup-hint">检测目录与备份的源目录、目标目录无关，可以检测任意目录。</p>
        </section>

        {error ? (
          <div className="dup-banner" data-tone="danger" role="alert">
            <IconAlert size={13} className="icon-inline" />
            <span>{error}</span>
          </div>
        ) : null}

        {notice ? (
          <div className="dup-banner" data-tone="warn" role="status">
            <IconAlert size={13} className="icon-inline" />
            <span>{notice}</span>
          </div>
        ) : null}

        {actSummary ? (
          <div className="dup-banner" data-tone="plain" role="status">
            <span>{actSummary}</span>
          </div>
        ) : null}

        {status?.reason ? (
          <div className="dup-banner" data-tone="plain" role="status">
            <span>{status.reason}</span>
          </div>
        ) : null}

        {phase === 'cancelled' ? (
          <div className="dup-banner" data-tone="warn" role="status">
            <IconAlert size={13} className="icon-inline" />
            <span>已取消：本次检测未完成，已计算的哈希结果保留在本次会话中，可重新检测。</span>
          </div>
        ) : null}

        {phase === 'failed' ? (
          <div className="dup-banner" data-tone="danger" role="alert">
            <IconAlert size={13} className="icon-inline" />
            <span>检测失败：{status?.reason ?? '请重新检测'}</span>
          </div>
        ) : null}

        {scanning ? (
          <section className="dup-progress" aria-label="检测进度">
            <ol className="dup-stages">
              {STAGES.map((stage) => {
                const index = STAGES.findIndex((item) => item.phase === phase);
                const current = STAGES.indexOf(stage);
                const state = current < index ? 'done' : current === index ? 'active' : 'idle';
                return (
                  <li key={stage.phase} className="dup-stage" data-state={state}>
                    <span className="dup-stage-dot" aria-hidden="true" />
                    {stage.label}
                  </li>
                );
              })}
            </ol>
            <div className="dup-progress-track" aria-hidden="true">
              <div
                className="dup-progress-fill"
                style={{
                  width: progress && progress.total ? `${Math.min(100, (progress.done / progress.total) * 100)}%` : '0%',
                }}
              />
            </div>
            <dl className="dup-progress-grid">
              <div>
                <dt>已处理</dt>
                <dd>
                  {fmtInt(progress?.done ?? 0)} / {fmtInt(progress?.total ?? 0)}
                </dd>
              </div>
              <div>
                <dt>已读字节</dt>
                <dd>{fmtBytes(progress?.bytesRead ?? 0)}</dd>
              </div>
              <div>
                <dt>吞吐</dt>
                <dd>{fmtThroughput(progress?.throughputBps ?? 0)}</dd>
              </div>
              <div>
                <dt>预计剩余</dt>
                <dd>{progress?.etaMs !== undefined ? fmtDuration(progress.etaMs) : '估算中'}</dd>
              </div>
            </dl>
          </section>
        ) : null}

        {summary ? (
          <section className="dup-stats" aria-label="扫描摘要">
            <div className="stat">
              <span className="stat-value">{fmtInt(summary.totalFiles)}</span>
              <span className="stat-label">文件总数</span>
            </div>
            <div className="stat">
              <span className="stat-value">{fmtBytes(summary.scannedBytes)}</span>
              <span className="stat-label">总字节</span>
            </div>
            <div className="stat">
              <span className="stat-value">{fmtDuration(summary.durationMs)}</span>
              <span className="stat-label">耗时</span>
            </div>
            <div className="stat">
              <span className="stat-value">{fmtInt(summary.identicalGroups)}</span>
              <span className="stat-label">内容重复组</span>
            </div>
            <div className="stat">
              <span className="stat-value">{fmtInt(summary.suspectedGroups)}</span>
              <span className="stat-label">疑似重复组</span>
            </div>
            <div className="stat">
              <span className="stat-value">{fmtInt(summary.nameConflictGroups)}</span>
              <span className="stat-label">同名不同内容组</span>
            </div>
            <div className="stat">
              <span className="stat-value">{fmtBytes(stats?.reclaimableBytes ?? 0)}</span>
              <span className="stat-label">可回收空间（仅内容重复）</span>
            </div>
            <div className="stat">
              <span className="stat-value">{fmtBytes(stats?.pendingDeleteBytes ?? 0)}</span>
              <span className="stat-label">待删字节（当前队列）</span>
            </div>
          </section>
        ) : null}

        {summary ? (
          <p className="dup-hint">
            跳过：空文件 {fmtInt(summary.skippedEmpty)} | 过小 {fmtInt(summary.skippedTooSmall)} |
            符号链接 {fmtInt(summary.skippedSymlink)} | 命中抑制 {fmtInt(summary.skippedSuppressed)}
          </p>
        ) : null}

        {truncated ? (
          <div className="dup-banner" data-tone="warn" role="status">
            <IconAlert size={13} className="icon-inline" />
            <span>
              预览已截断：下方各区只展示前若干组，统计（组数、可回收空间、跳过计数）基于全量结果。
            </span>
          </div>
        ) : null}

        {result && !result.complete ? (
          <div className="dup-banner" data-tone="warn" role="status">
            <IconAlert size={13} className="icon-inline" />
            <span>
              扫描不完整：{result.failures.length} 个文件判定失败，结论仅供参考。
            </span>
          </div>
        ) : null}

        {result ? (
          <div className="dup-columns">
            <div className="dup-column">
              <ResultZone
                zoneId="identical"
                title={CATEGORY_LABEL.identical}
                hint="内容哈希完全相同，与文件名无关；删除其中多余的一份可回收空间。"
                groups={groupsOf('identical')}
                fullCount={summary?.identicalGroups ?? 0}
                truncated={truncated}
                intents={intents}
                selected={selected}
                onToggleSelect={toggleSelect}
                onMark={handleMark}
                onMarkBatch={handleMarkBatch}
                onRevokeQueued={handleRevokeQueued}
                onKeeperChange={handleKeeperChange}
                onKeepGroup={handleKeepGroup}
                onSuppress={handleSuppress}
                onReveal={handleReveal}
                onExecute={() => void requestExecute('identical')}
                keeperChoice={keeperChoice}
                canAct={!actBlockedReason}
                blockedReason={actBlockedReason}
                busy={busy}
              />
              <ResultZone
                zoneId="suspected"
                title={CATEGORY_LABEL.suspected}
                hint="大文件跳过了全量校验，仅凭大小与首尾局部哈希判定，不保证内容完全一致。"
                groups={groupsOf('suspected')}
                fullCount={summary?.suspectedGroups ?? 0}
                truncated={truncated}
                intents={intents}
                selected={selected}
                onToggleSelect={toggleSelect}
                onMark={handleMark}
                onMarkBatch={handleMarkBatch}
                onRevokeQueued={handleRevokeQueued}
                onKeeperChange={handleKeeperChange}
                onKeepGroup={handleKeepGroup}
                onSuppress={handleSuppress}
                onReveal={handleReveal}
                onExecute={() => void requestExecute('suspected')}
                keeperChoice={keeperChoice}
                canAct={!actBlockedReason}
                blockedReason={actBlockedReason}
                busy={busy}
              />
            </div>

            <div className="dup-column">
              <ResultZone
                zoneId="conflict"
                title={CATEGORY_LABEL['same-name-diff-content']}
                hint="同一目录内同名但内容哈希不同，删除前须两次确认。"
                warning={{
                  title: '同名不等于重复：这些文件内容不同，删除任意一份都会丢失独有内容。',
                  body: '本区默认不预选任何删除项。删除同名文件不会释放任何空间，本区不计入「可回收空间」。',
                }}
                groups={groupsOf('same-name-diff-content')}
                fullCount={summary?.nameConflictGroups ?? 0}
                truncated={truncated}
                intents={intents}
                selected={selected}
                onToggleSelect={toggleSelect}
                onMark={handleMark}
                onMarkBatch={handleMarkBatch}
                onRevokeQueued={handleRevokeQueued}
                onKeeperChange={handleKeeperChange}
                onKeepGroup={handleKeepGroup}
                onSuppress={handleSuppress}
                onReveal={handleReveal}
                onExecute={() => void requestExecute('same-name-diff-content')}
                keeperChoice={keeperChoice}
                canAct={!actBlockedReason}
                blockedReason={actBlockedReason}
                busy={busy}
              />
            </div>
          </div>
        ) : (
          <p className="dup-hint">尚未检测。选择目录后点击「开始检测」。</p>
        )}

        {status ? (
          <section className="dup-events" aria-label="最近事件与报告">
            <div className="dup-zone-head">
              <div className="dup-zone-title">
                <span className="dup-zone-name">最近事件</span>
                <span className="dup-zone-count">{fmtInt(recent.length)} 条</span>
              </div>
              <p className="dup-hint">
                检测与清理动作会记录在这里（已脱敏）；完整报告可导出到本机文件留档。
              </p>
              <div className="dup-zone-actions">
                <button
                  className="btn btn-sm"
                  type="button"
                  disabled={busy}
                  onClick={() => void handleExport('json')}
                >
                  导出报告 JSON
                </button>
                <button
                  className="btn btn-sm"
                  type="button"
                  disabled={busy}
                  onClick={() => void handleExport('csv')}
                >
                  导出报告 CSV
                </button>
              </div>
            </div>
            {reportNote ? (
              <p className="dup-hint" role="status">
                {reportNote}
              </p>
            ) : null}
            {recent.length === 0 ? (
              <p className="dup-hint">暂无事件记录。</p>
            ) : (
              <ul className="dup-event-list">
                {recent
                  .slice()
                  .reverse()
                  .slice(0, 20)
                  .map((event, index) => (
                    <li
                      key={`${event.at}-${index}`}
                      className="dup-event"
                      data-outcome={event.outcome ?? 'ok'}
                    >
                      <span className="dup-event-time">{timeText(event.at)}</span>
                      <span className="dup-event-action">{event.action}</span>
                      {event.detail ? (
                        <span className="dup-event-detail" title={event.detail}>
                          {event.detail}
                        </span>
                      ) : null}
                    </li>
                  ))}
              </ul>
            )}
          </section>
        ) : null}
      </div>

      {quarantineOpen ? (
        <div className="dup-drawer" role="dialog" aria-modal="false" aria-label="本机隔离区">
          <div className="dup-drawer-card">
            <header className="dup-drawer-head">
              <div>
                <h2>本机隔离区 ({fmtInt(quarantine.length)})</h2>
                <p className="dup-hint">
                  系统回收站不可用时删除的文件会移到这里，可逐条还原回原路径。清单来自本机持久记录，重启后仍在。
                </p>
              </div>
              <div className="dup-drawer-actions">
                <button
                  className="btn btn-sm"
                  type="button"
                  disabled={busy}
                  onClick={() => void loadQuarantine()}
                >
                  刷新
                </button>
                <button
                  className="btn btn-sm btn-icon"
                  type="button"
                  onClick={() => setQuarantineOpen(false)}
                  aria-label="关闭隔离区"
                >
                  <IconX size={14} />
                </button>
              </div>
            </header>

            {quarantine.length === 0 ? (
              <p className="dup-hint">隔离区为空：没有需要还原的文件。</p>
            ) : (
              <ul className="dup-suppress-list">
                {quarantine.map((entry) => (
                  <li key={entry.id} className="dup-suppress-row">
                    <span className="dup-suppress-main">
                      <span className="dup-suppress-fingerprint" title={entry.originalPath}>
                        {baseName(entry.originalPath)}
                      </span>
                      <span className="dup-suppress-name" title={entry.originalPath}>
                        {entry.originalPath}
                      </span>
                      <span className="dup-suppress-meta">
                        大小 {fmtBytes(entry.size)} | 进入隔离区 {timeText(entry.deletedAt)}
                        {entry.restored ? ' | 已还原' : ''}
                      </span>
                    </span>
                    <button
                      className="btn btn-sm"
                      type="button"
                      disabled={busy || entry.restored}
                      onClick={() => void handleRestore(entry.id)}
                      aria-label={`还原 ${entry.originalPath}`}
                    >
                      还原
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}

      {suppressOpen ? (
        <SuppressPanel
          items={suppressions}
          busy={busy}
          onClose={() => setSuppressOpen(false)}
          onRevoke={(sha256) => {
            setNotice('');
            void perform(() => api.revokeSuppression(sha256));
          }}
        />
      ) : null}

      {confirm ? (
        <div className="dup-modal" role="dialog" aria-modal="true" aria-label="删除确认">
          <div className="dup-modal-card">
            <h2>确认删除</h2>
            <p className="dup-modal-note">
              文件只会移入系统回收站；系统回收站不可用时降级为本机隔离区，同样可还原。
            </p>
            <dl className="dup-confirm-list">
              <div>
                <dt>待删文件数</dt>
                <dd>{fmtInt(confirm.count)}</dd>
              </div>
              <div>
                <dt>涉及组数</dt>
                <dd>{fmtInt(confirm.groups)}</dd>
              </div>
              <div>
                <dt>总字节数</dt>
                <dd>{fmtBytes(confirm.bytes)}</dd>
              </div>
              <div>
                <dt>落地方式</dt>
                <dd>系统回收站（不可用时降级为本机隔离区）</dd>
              </div>
            </dl>
            {confirm.category === 'same-name-diff-content' ? (
              <p className="dup-confirm-warn" role="alert">
                <IconAlert size={13} className="icon-inline" />
                {confirm.step === 1
                  ? '警告：这些文件内容不同，删除任意一份都会丢失独有内容。请再次确认。'
                  : '第二次确认：内容不同的文件将被移入回收站，无法在本界面撤销。'}
              </p>
            ) : null}
            <div className="dup-modal-actions">
              <button className="btn btn-sm" type="button" onClick={() => setConfirm(null)} disabled={busy}>
                取消
              </button>
              {confirm.category === 'same-name-diff-content' && confirm.step === 1 ? (
                <button
                  className="btn btn-sm"
                  type="button"
                  onClick={() => setConfirm({ ...confirm, step: 2 })}
                  disabled={busy}
                >
                  我已知晓内容不同，继续
                </button>
              ) : (
                <button className="btn btn-sm btn-primary" type="button" onClick={() => void executeDelete()} disabled={busy}>
                  确认删除
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 结果区顶部的告警头。
 *
 * 警告描述的就是这个分区，所以它必须渲染在分区自己的盒子里，
 * 单独成卡时用户得自己推断两者是同一件事。
 */
interface ZoneWarning {
  title: string;
  body: string;
}

interface ZoneProps {
  zoneId: string;
  title: string;
  hint: string;
  /** 顶部告警头：与分区正文同处一个盒子 */
  warning?: ZoneWarning;
  groups: DupGroup[];
  /** 全量组数：引擎截断预览时与实际展示的组数不一致，界面要说明（FR-17） */
  fullCount: number;
  /** 引擎是否截断了预览列表 */
  truncated: boolean;
  /** 条目意图：保留 / 删除 / 下次不提醒 的唯一来源 */
  intents: Record<string, ItemIntent>;
  /** 批量操作的工作集：只表示作用对象，不表达删除意图 */
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  /** 逐条明确选择 */
  onMark: (ids: string[], action: DupItemAction) => void;
  /** 批量选择：不得覆盖已明确的逐条选择 */
  onMarkBatch: (ids: string[], action: DupItemAction) => void;
  /** 撤销待删 */
  onRevokeQueued: (ids: string[]) => void;
  /** 下拉框只改本地意图 */
  onKeeperChange: (groupId: string, keeperId: string) => void;
  onKeepGroup: (group: DupGroup, keeperId: string) => void;
  onSuppress: (targets: SuppressTarget[]) => void;
  onReveal: (entry: DupFileEntry) => void;
  onExecute: () => void;
  keeperChoice: Record<string, string>;
  canAct: boolean;
  blockedReason?: string;
  busy: boolean;
}

/**
 * 一个结果区（内容重复 / 疑似重复 / 同名不同内容）。
 *
 * 结果按「组标题行 + 条目行」摊平后交给虚拟列表，
 * 虚拟化只影响渲染，批量动作始终作用于全量数据（FR-16）。
 */
export function ResultZone({
  zoneId,
  title,
  hint,
  warning,
  groups,
  fullCount,
  truncated,
  intents,
  selected,
  onToggleSelect,
  onMark,
  onMarkBatch,
  onRevokeQueued,
  onKeeperChange,
  onKeepGroup,
  onSuppress,
  onReveal,
  onExecute,
  keeperChoice,
  canAct,
  blockedReason,
  busy,
}: ZoneProps) {
  /** 组默认展开；只有用户手动收起的组才折叠（虚拟化保证大结果也不打爆 DOM） */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const group of groups) {
      out.push({ kind: 'group', group });
      if (!collapsed.has(group.id)) {
        for (const entry of group.entries) out.push({ kind: 'entry', group, entry });
      }
    }
    return out;
  }, [groups, collapsed]);

  const toggleExpand = (groupId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const queuedEntries = useMemo(
    () =>
      groups
        .flatMap((group) => group.entries)
        .filter((entry) => intentOf(entry, intents) === 'delete'),
    [groups, intents],
  );
  const selectedInZone = useMemo(
    () =>
      groups.flatMap((group) => group.entries).filter((entry) => selected.has(entry.id)),
    [groups, selected],
  );

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // 行内控件自己处理按键：容器不能劫持 Enter/Space，否则行内按钮与复选框都按不下去
    if (event.target !== event.currentTarget) return;
    if (!rows.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = Math.min(rows.length - 1, Math.max(0, activeIndex + delta));
      setActiveIndex(next);
      const scroller = listRef.current?.querySelector('.list-scroll');
      const el = listRef.current?.querySelector(`[data-dup-row="${next}"]`);
      if (el) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
      else if (scroller) {
        (scroller as HTMLElement).scrollTop = Math.max(
          0,
          next * ROW_HEIGHT - (scroller as HTMLElement).clientHeight / 2,
        );
      }
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      const row = rows[activeIndex];
      if (row && row.kind === 'entry') {
        event.preventDefault();
        onToggleSelect(row.entry.id);
      }
    }
  };

  return (
    <section className="dup-zone" data-zone={zoneId} aria-label={title}>
      {warning ? (
        <div className="dup-zone-warn" role="alert">
          <IconAlert size={14} className="icon-inline" />
          <div>
            <strong>{warning.title}</strong>
            <p>{warning.body}</p>
            {zoneId === 'conflict' ? <p>{CONFLICT_SUPPRESS_REASON}</p> : null}
          </div>
        </div>
      ) : null}
      <header className="dup-zone-head">
        <div className="dup-zone-title">
          <span className="dup-zone-name">{title}</span>
          <span className="dup-zone-count">
            {fmtInt(groups.length)} 组
            {truncated ? `（预览已截断，全量 ${fmtInt(fullCount)} 组）` : ''}
          </span>
        </div>
        <p className="dup-hint">{hint}</p>
        <div className="dup-zone-actions">
          <button
            className="btn btn-sm"
            type="button"
            disabled={busy || !selectedInZone.length}
            onClick={() => onMarkBatch(selectedInZone.map((entry) => entry.id), 'delete')}
            aria-label={`删除所选 ${selectedInZone.length} 项`}
          >
            删除所选 ({selectedInZone.length})
          </button>
          <button
            className="btn btn-sm"
            type="button"
            disabled={busy || !selectedInZone.length}
            onClick={() => onMarkBatch(selectedInZone.map((entry) => entry.id), 'keep')}
            aria-label={`保留所选 ${selectedInZone.length} 项`}
          >
            保留所选
          </button>
          <button
            className="btn btn-sm"
            type="button"
            disabled={busy || !selectedInZone.length}
            onClick={() => {
              const byHash = new Map<string, DupFileEntry[]>();
              for (const entry of selectedInZone) {
                const list = byHash.get(entry.sha256) ?? [];
                list.push(entry);
                byHash.set(entry.sha256, list);
              }
              onSuppress(
                Array.from(byHash.entries()).map(([sha256, entries]) => ({ sha256, entries })),
              );
            }}
            aria-label={`下次不提醒所选 ${selectedInZone.length} 项`}
          >
            下次不提醒所选
          </button>
          <button
            className="btn btn-sm"
            type="button"
            disabled={busy || !queuedEntries.length}
            onClick={() => onRevokeQueued(queuedEntries.map((entry) => entry.id))}
            aria-label="撤销全部待删"
          >
            撤销待删 ({queuedEntries.length})
          </button>
          <button
            className="btn btn-sm btn-primary"
            type="button"
            disabled={busy || !canAct || !queuedEntries.length}
            title={blockedReason}
            onClick={onExecute}
            aria-label={`执行删除 ${queuedEntries.length} 个文件`}
          >
            <IconTrash size={13} className="icon-inline" />
            执行删除 ({queuedEntries.length})
          </button>
        </div>
        {blockedReason ? (
          <p className="dup-hint" role="status">
            删除已禁用：{blockedReason}
          </p>
        ) : null}
        <p className="dup-hint">
          勾选只是批量操作的对象；每条的去向由「保留 / 删除 / 下次不提醒」决定，批量操作不会覆盖已明确的逐条选择。
        </p>
      </header>

      {groups.length === 0 ? (
        <p className="dup-hint">本区暂无结果。</p>
      ) : (
        <div
          className="dup-list"
          ref={listRef}
          tabIndex={0}
          role="group"
          aria-label={`${title} 结果列表，可用上下键选择`}
          onKeyDown={handleKeyDown}
        >
          <VirtualList
            items={rows}
            rowHeight={ROW_HEIGHT}
            rowClassName="dup-row"
            emptyHint="本区暂无结果"
            renderRow={(row, index) => {
              if (row.kind === 'group') {
                const group = row.group;
                const keeperId = keeperChoice[group.id] ?? group.suggestedKeeperId ?? group.entries[0]?.id ?? '';
                const suggestedId = group.suggestedKeeperId;
                const isConflict = group.category === 'same-name-diff-content';
                return (
                  <div
                    className="dup-group-row"
                    data-dup-row={index}
                    data-active={index === activeIndex}
                    role="listitem"
                  >
                    <button
                      className="dup-group-toggle"
                      type="button"
                      onClick={() => toggleExpand(group.id)}
                      aria-expanded={!collapsed.has(group.id)}
                      aria-label={`${collapsed.has(group.id) ? '展开' : '收起'}重复组 ${group.fingerprint}`}
                    >
                      {collapsed.has(group.id) ? '展开' : '收起'}
                    </button>
                    <div className="dup-group-info">
                      <span className="dup-group-title">
                        {isConflict ? (
                          <FileName value={group.fileName ?? group.entries[0]?.fileName ?? '未命名文件'} />
                        ) : (
                          <span className="dup-fingerprint-label">
                            指纹
                            <FingerprintTag value={group.fingerprint} />
                          </span>
                        )}
                        <em>{group.entries.length} 份</em>
                        <em>{fmtBytes(group.size)}</em>
                        {isConflict ? (
                          <em data-tone="warn">不计入可回收空间</em>
                        ) : (
                          <em data-tone="accent">可回收 {fmtBytes(group.reclaimableBytes)}</em>
                        )}
                      </span>
                      <span className="dup-group-meta">
                        {isConflict && group.dirPath ? `${group.dirPath} | ` : ''}
                        建议保留：
                        <select
                          className="dup-keeper-select"
                          value={keeperId}
                          aria-label="选择要保留的文件"
                          onChange={(event) => onKeeperChange(group.id, event.target.value)}
                        >
                          {group.entries.map((entry) => (
                            <option key={entry.id} value={entry.id}>
                              {entry.fileName}
                              {entry.id === suggestedId ? '（建议保留）' : ''}
                            </option>
                          ))}
                        </select>
                      </span>
                    </div>
                    <div className="dup-group-actions">
                      <button
                        className="btn btn-sm"
                        type="button"
                        disabled={busy || !keeperId}
                        onClick={() => onKeepGroup(group, keeperId)}
                        aria-label={`保留此份，其余可删，重复组 ${group.fingerprint}`}
                      >
                        保留此份，其余可删
                      </button>
                      <button
                        className="btn btn-sm"
                        type="button"
                        disabled={busy || isConflict || !group.entries.length}
                        title={isConflict ? CONFLICT_SUPPRESS_REASON : undefined}
                        onClick={() =>
                          onSuppress([
                            {
                              sha256: group.sha256 ?? group.entries[0]?.sha256 ?? '',
                              entries: group.entries,
                            },
                          ])
                        }
                        aria-label={`整组不再提醒，重复组 ${group.fingerprint}`}
                      >
                        整组不再提醒
                      </button>
                    </div>
                  </div>
                );
              }

              const { group, entry } = row;
              const isConflict = group.category === 'same-name-diff-content';
              const suggested = entry.id === group.suggestedKeeperId;
              const intent = intentOf(entry, intents);
              const state = displayState(entry, intents);
              return (
                <div
                  className="dup-entry-row"
                  data-dup-row={index}
                  data-active={index === activeIndex}
                  data-state={state}
                  role="listitem"
                >
                  <input
                    type="checkbox"
                    className="dup-pick"
                    checked={selected.has(entry.id)}
                    onChange={() => onToggleSelect(entry.id)}
                    aria-label={`选择 ${entry.fileName}`}
                  />
                  <span
                    className="dup-entry-path"
                    title="双击在文件管理器中定位该文件"
                    onDoubleClick={() => void onReveal(entry)}
                  >
                    <DupPath absPath={entry.absPath} relPath={entry.relPath} />
                    {suggested ? <em className="dup-keep-badge">建议保留</em> : null}
                    {intent === 'suppress' ? (
                      <em className="dup-state-badge">{INTENT_LABEL.suppress}</em>
                    ) : state !== 'pending' ? (
                      <em className="dup-state-badge">{STATE_LABEL[state]}</em>
                    ) : null}
                    {entry.note ? <em className="dup-note">{entry.note}</em> : null}
                  </span>
                  <span className="dup-entry-meta">
                    <span>{fmtBytes(entry.size)}</span>
                    <span>{timeText(entry.mtimeMs)}</span>
                    {isConflict ? (
                      <span className="dup-fingerprint-label">
                        指纹
                        <FingerprintTag value={entry.sha256} />
                      </span>
                    ) : null}
                  </span>
                  <span className="dup-entry-actions">
                    {intent === 'delete' ? (
                      <button
                        className="btn btn-sm"
                        type="button"
                        disabled={busy}
                        onClick={() => onMark([entry.id], 'keep')}
                        aria-label={`撤销删除 ${entry.fileName}`}
                      >
                        撤销
                      </button>
                    ) : null}
                    <button
                      className="btn btn-sm"
                      type="button"
                      disabled={busy}
                      aria-pressed={intent === 'keep'}
                      onClick={() => onMark([entry.id], 'keep')}
                      aria-label={`保留 ${entry.fileName}`}
                    >
                      保留
                    </button>
                    <button
                      className="btn btn-sm"
                      type="button"
                      disabled={busy || !canAct}
                      title={blockedReason}
                      aria-pressed={intent === 'delete'}
                      onClick={() => onMark([entry.id], 'delete')}
                      aria-label={`删除 ${entry.fileName}`}
                    >
                      删除
                    </button>
                    <button
                      className="btn btn-sm"
                      type="button"
                      disabled={busy}
                      onClick={() => onSuppress([{ sha256: entry.sha256, entries: [entry] }])}
                      aria-label={`下次不提醒 ${entry.fileName}`}
                    >
                      下次不提醒
                    </button>
                  </span>
                </div>
              );
            }}
          />
        </div>
      )}
    </section>
  );
}
