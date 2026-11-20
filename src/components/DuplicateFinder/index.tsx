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
  DupStatus,
} from '../../../shared/dup-types';
import { VirtualList } from '../VirtualList';
import { FileName } from '../FileName';
import { IconAlert, IconFolder, IconTrash } from '../Icons';
import { SuppressPanel } from './SuppressPanel';
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

const SCANNING_PHASES: DupPhase[] = [
  'scanning',
  'bucketing',
  'partial-hashing',
  'hashing',
  'summarizing',
  'acting',
];

type ActItem = DupActRequest['items'][number];

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

/**
 * 绝对路径：目录部分从左省略（保留最近的父目录），文件名走中间省略、后缀完整。
 */
function DupPath({ absPath, relPath }: { absPath: string; relPath: string }) {
  const cut = Math.max(absPath.lastIndexOf('\\'), absPath.lastIndexOf('/'));
  const sep = cut >= 0 ? absPath[cut] : '';
  const dir = cut >= 0 ? absPath.slice(0, cut) : '';
  const name = cut >= 0 ? absPath.slice(cut + 1) : absPath;
  const shortDir = dir.length > 36 ? `…${dir.slice(-35)}` : dir;
  return (
    <span className="dup-path" title={`${relPath}\n${absPath}`}>
      {shortDir ? <span className="dup-path-dir">{shortDir}{sep}</span> : null}
      <FileName value={name} />
    </span>
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
 */
export function DuplicateFinderPage({
  api,
  pickDirectory,
  onBack,
  backupRunning = false,
}: DuplicateFinderPageProps) {
  const [status, setStatus] = useState<DupStatus | null>(null);
  const [root, setRoot] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [actSummary, setActSummary] = useState('');
  /** 降级到本机隔离区的条目：可逐条还原（FR-08） */
  const [quarantineEntries, setQuarantineEntries] = useState<{ id: string; absPath: string }[]>([]);
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

  useEffect(() => {
    let stopped = false;
    void api
      .status()
      .then((value) => {
        if (!stopped) setStatus(value);
      })
      .catch(() => {
        if (!stopped) setError('无法读取重复文件检测状态');
      });
    return () => {
      stopped = true;
    };
  }, [api]);

  // 扫描过程没有事件推送，靠轮询把五阶段进度搬到界面上
  useEffect(() => {
    if (!status || !SCANNING_PHASES.includes(status.phase)) return undefined;
    const timer = window.setInterval(() => {
      void api
        .status()
        .then((next) => setStatus(next))
        .catch(() => undefined);
    }, 350);
    return () => window.clearInterval(timer);
  }, [api, status]);

  const phase = status?.phase ?? 'idle';
  const result = status?.result ?? null;
  const progress = status?.progress;
  const suppressions = status?.suppressions ?? [];
  const scanning = SCANNING_PHASES.includes(phase);

  const actBlockedReason = (() => {
    if (scanning) return '检测进行中，暂不能删除';
    if (backupRunning) return '备份任务或自动同步正在运行，暂不能删除';
    if (status && !status.canAct) return status.blockedReason ?? '当前介质状态不允许删除';
    return undefined;
  })();

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

  const handleBrowse = useCallback(async () => {
    setError('');
    const picked = await pickDirectory('选择要检测重复文件的目录');
    if (!picked) return;
    setRoot(picked);
  }, [pickDirectory]);

  const handleScan = useCallback(() => {
    if (!root) return;
    setError('');
    setNotice('');
    setActSummary('');
    setSelected(new Set());
    setKeeperChoice({});
    void perform(() => api.scan(root));
  }, [api, perform, root]);

  const handleCancel = useCallback(() => {
    void perform(() => api.cancel());
  }, [api, perform]);

  const handleMark = useCallback(
    (ids: string[], action: DupItemAction) => {
      if (!root || !ids.length) return;
      setNotice('');
      void perform(() => api.markAction(root, ids, action));
    },
    [api, perform, root],
  );

  const handleKeepGroup = useCallback(
    (group: DupGroup, keeperId: string) => {
      if (!root) return;
      setNotice('');
      setKeeperChoice((prev) => ({ ...prev, [group.id]: keeperId }));
      void perform(() => api.keepGroup(root, group.id, keeperId));
    },
    [api, perform, root],
  );

  const handleSuppress = useCallback(
    async (sha256: string, entries: DupFileEntry[]) => {
      if (!root || !sha256 || !entries.length) return;
      setNotice('');
      await perform(() => api.suppress(root, sha256, scopeMode, entries.map((entry) => entry.absPath)));
    },
    [api, perform, root, scopeMode],
  );

  const handleReveal = useCallback(
    async (entry: DupFileEntry) => {
      if (!root) return;
      setError('');
      setNotice('');
      try {
        // 走受校验的定位通道：路径必须落在本次扫描根内且是真实扫描结果（FR-14、FR-20）
        await api.reveal(root, entry.absPath);
      } catch (err) {
        setError(err instanceof Error ? err.message : `文件已不存在或不可访问：${entry.absPath}`);
      }
    },
    [api, root],
  );

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /**
   * 执行删除前先按「每组至少保留一份」分组校验（FR-11）：
   * 整组都被标成删除的组不纳入本次请求，自动把建议保留项改回保留。
   */
  const requestExecute = useCallback(
    async (category: DupCategory) => {
      if (!root) return;
      const groups = groupsOf(category);
      const violating: DupGroup[] = [];
      const items: ActItem[] = [];
      const groupIds: string[] = [];

      for (const group of groups) {
        const queued = group.entries.filter((entry) => entry.state === 'queued');
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
        if (keeperIds.length) await api.markAction(root, keeperIds, 'keep');
        setNotice(
          `该组至少保留一份：${violating.length} 个组被整组标记为删除，本次未删除这些组中的任何文件（已全部保留，含建议保留项）。`,
        );
        const next = await api.status();
        setStatus(next);
      }

      if (!items.length) {
        if (!violating.length) setNotice('当前没有待删文件。');
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
    [api, groupsOf, root],
  );

  const executeDelete = useCallback(async () => {
    if (!confirm || !root) return;
    setBusy(true);
    setError('');
    try {
      const outcome = await api.act(root, {
        root,
        items: confirm.items,
        groupIds: confirm.groupIds,
        category: confirm.category,
      });
      const bits = [
        `成功删除 ${outcome.deleted} 个`,
        `跳过 ${outcome.skipped} 个`,
        `被阻断 ${outcome.blocked} 个`,
        `失败 ${outcome.failed} 个`,
        `释放 ${fmtBytes(outcome.reclaimedBytes)}`,
      ];
      setActSummary(bits.join('，'));
      // 降级到本机隔离区的条目要能还原：留住隔离区 id，界面给还原入口（FR-08）
      const quarantined = outcome.items.filter((item) => item.quarantineId);
      setQuarantineEntries(
        quarantined.map((item) => ({ id: item.quarantineId as string, absPath: item.absPath })),
      );
      if (outcome.degradedToQuarantine) {
        setNotice(
          '系统回收站不可用，本次删除已降级为本机隔离区（可还原），删除动作仍可撤回。',
        );
      }
      setConfirm(null);
      setSelected(new Set());
      setStatus(await api.status());
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }, [api, confirm, root]);

  const stats = result?.stats;
  const summary = result?.summary;

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
        setQuarantineEntries((prev) => prev.filter((entry) => entry.id !== id));
        setNotice(`已还原到原路径：${outcome.path ?? ''}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : '还原失败');
      }
    },
    [api],
  );

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
            <button className="btn btn-sm" type="button" disabled={!scanning || busy} onClick={handleCancel}>
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

        {quarantineEntries.length > 0 ? (
          <div className="dup-banner" data-tone="warn" role="status">
            <IconAlert size={13} className="icon-inline" />
            <span>以下文件被移入本机隔离区（系统回收站不可用），可逐条还原：</span>
            <ul className="dup-restore-list">
              {quarantineEntries.map((entry) => (
                <li key={entry.id}>
                  <span className="dup-restore-path" title={entry.absPath}>
                    {entry.absPath}
                  </span>
                  <button
                    className="btn btn-sm"
                    type="button"
                    aria-label={`还原 ${entry.absPath}`}
                    onClick={() => void handleRestore(entry.id)}
                  >
                    还原
                  </button>
                </li>
              ))}
            </ul>
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
                selected={selected}
                onToggleSelect={toggleSelect}
                onMark={handleMark}
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
                selected={selected}
                onToggleSelect={toggleSelect}
                onMark={handleMark}
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
              <div className="dup-warn-strip" role="alert">
                <IconAlert size={14} className="icon-inline" />
                <div>
                  <strong>同名不等于重复：这些文件内容不同，删除任意一份都会丢失独有内容。</strong>
                  <p>
                    本区默认不预选任何删除项。删除同名文件不会释放任何空间，本区不计入「可回收空间」。
                  </p>
                </div>
              </div>
              <ResultZone
                zoneId="conflict"
                title={CATEGORY_LABEL['same-name-diff-content']}
                hint="同一目录内同名但内容哈希不同，删除前须两次确认。"
                groups={groupsOf('same-name-diff-content')}
                selected={selected}
                onToggleSelect={toggleSelect}
                onMark={handleMark}
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
      </div>

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

interface ZoneProps {
  zoneId: string;
  title: string;
  hint: string;
  groups: DupGroup[];
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onMark: (ids: string[], action: DupItemAction) => void;
  onKeepGroup: (group: DupGroup, keeperId: string) => void;
  onSuppress: (sha256: string, entries: DupFileEntry[]) => void;
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
  groups,
  selected,
  onToggleSelect,
  onMark,
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
    () => groups.flatMap((group) => group.entries.filter((entry) => entry.state === 'queued')),
    [groups],
  );
  const selectedInZone = useMemo(
    () =>
      groups.flatMap((group) => group.entries).filter((entry) => selected.has(entry.id)),
    [groups, selected],
  );

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
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
      <header className="dup-zone-head">
        <div className="dup-zone-title">
          <span className="dup-zone-name">{title}</span>
          <span className="dup-zone-count">{fmtInt(groups.length)} 组</span>
        </div>
        <p className="dup-hint">{hint}</p>
        <div className="dup-zone-actions">
          <button
            className="btn btn-sm"
            type="button"
            disabled={busy || !selectedInZone.length}
            onClick={() => onMark(selectedInZone.map((entry) => entry.id), 'delete')}
            aria-label={`删除所选 ${selectedInZone.length} 项`}
          >
            删除所选 ({selectedInZone.length})
          </button>
          <button
            className="btn btn-sm"
            type="button"
            disabled={busy || !selectedInZone.length}
            onClick={() => onMark(selectedInZone.map((entry) => entry.id), 'keep')}
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
              for (const [sha, entries] of byHash) void onSuppress(sha, entries);
            }}
            aria-label={`下次不提醒所选 ${selectedInZone.length} 项`}
          >
            下次不提醒所选
          </button>
          <button
            className="btn btn-sm"
            type="button"
            disabled={busy || !queuedEntries.length}
            onClick={() => onMark(queuedEntries.map((entry) => entry.id), 'keep')}
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
                        {isConflict ? group.fileName : `指纹 ${group.fingerprint}`}
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
                          onChange={(event) => onKeepGroup(group, event.target.value)}
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
                        disabled={busy || !group.entries.length}
                        onClick={() => void onSuppress(group.sha256 ?? group.entries[0]?.sha256 ?? '', group.entries)}
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
              return (
                <div
                  className="dup-entry-row"
                  data-dup-row={index}
                  data-active={index === activeIndex}
                  data-state={entry.state}
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
                    {entry.state !== 'pending' ? (
                      <em className="dup-state-badge">{STATE_LABEL[entry.state]}</em>
                    ) : null}
                    {entry.note ? <em className="dup-note">{entry.note}</em> : null}
                  </span>
                  <span className="dup-entry-meta">
                    <span>{fmtBytes(entry.size)}</span>
                    <span>{timeText(entry.mtimeMs)}</span>
                    {isConflict ? <span>指纹 {entry.sha256.slice(0, 8)}</span> : null}
                  </span>
                  <span className="dup-entry-actions">
                    {entry.state === 'queued' ? (
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
                      aria-pressed={entry.state === 'kept'}
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
                      aria-pressed={entry.state === 'queued'}
                      onClick={() => onMark([entry.id], 'delete')}
                      aria-label={`删除 ${entry.fileName}`}
                    >
                      删除
                    </button>
                    <button
                      className="btn btn-sm"
                      type="button"
                      disabled={busy}
                      onClick={() => void onSuppress(entry.sha256, [entry])}
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
