import { useMemo, useState } from 'react';
import { IconAlert, IconArrowUpRight, IconCopy, IconLayers, IconShield, IconTrash } from './Icons';
import { FileName } from './FileName';
import { VirtualList } from './VirtualList';
import { fmtBytes, fmtInt } from '../lib/format';
import type { ActionStatus, ActionType, PlanAction, SyncMode } from '../../shared/types';

interface Props {
  actions: PlanAction[];
  copy: number;
  update: number;
  rename: number;
  deleteCount: number;
  skip: number;
  totalFiles: number;
  bytes: number;
  /** 非破坏性模式下保留在目标端的多余文件数。 */
  retained: number;
  syncMode: SyncMode;
  onSyncModeChange: (mode: SyncMode) => void;
  /** 当前模式下被删除的文件是否可恢复（进入回收站）。 */
  recycleRecoverable?: boolean;
  /** 引擎是否对计划预览做了截断。 */
  truncated?: boolean;
  /** 截断前的完整条目数。 */
  totalActions?: number;
  /** 预览上限（与引擎 MAX_PREVIEW_ACTIONS 对齐）。 */
  previewLimit?: number;
  /** 打开归档目录的入口（仅「镜像并保留历史」可用）。 */
  onRevealArchive?: () => void;
  /** 归档目录定位失败的原因（如作用域已过期）；只提示，不改写备份状态。 */
  revealArchiveError?: string;
}

const ROW_HEIGHT = 30;

const KIND_LABEL: Record<ActionType, string> = {
  copy: '新增',
  update: '更新',
  rename: '改名',
  delete: '删除',
  skip: '内容一致（无需复制）',
  retain: '保留（目标端多余文件）',
};

const STATUS_LABEL: Record<ActionStatus, string> = {
  pending: '待执行',
  running: '执行中',
  done: '已完成',
  skipped: '已跳过',
  failed: '失败',
  archived: '已归档',
};

/** 计划条目的展示顺序：先写入，后删除，再是被保留的多余文件，最后是内容一致的大批量条目。 */
const GROUP_ORDER: ActionType[] = ['copy', 'update', 'rename', 'delete', 'retain', 'skip'];

/**
 * 同步方式选项。
 *
 * 顺序即推荐顺序，默认的非破坏性语义排在最前；严格镜像放在最后并标出不可恢复，
 * 让用户在点下去之前就知道后果，而不是在删除完成后才知道。
 */
const MODE_OPTIONS: { mode: SyncMode; title: string; desc: string; danger?: boolean }[] = [
  {
    mode: 'copy',
    title: '非破坏性（推荐）：目标端多余文件保留不删',
    desc: '只做新增、更新与改名，永远不会删除备份端已有文件',
  },
  {
    mode: 'mirror-archive',
    title: '安全镜像：删除的文件进入回收站，可一键还原',
    desc: '与源端保持一致，被删除的文件仍可找回',
  },
  {
    mode: 'mirror',
    title: '严格镜像：删除且不留副本，不可恢复',
    desc: '源端消失的文件会从备份端永久删除，仅在明确需要时选用',
    danger: true,
  },
];

function KindGlyph({ type }: { type: ActionType }) {
  if (type === 'copy') return <IconLayers size={12} className="icon-inline" />;
  if (type === 'rename') return <IconArrowUpRight size={12} className="icon-inline" />;
  if (type === 'delete') return <IconTrash size={12} className="icon-inline" />;
  if (type === 'update') return <IconCopy size={12} className="icon-inline" />;
  if (type === 'retain') return <IconShield size={12} className="icon-inline" />;
  return null;
}

export function PlanPanel({
  actions,
  copy,
  update,
  rename,
  deleteCount,
  skip,
  totalFiles,
  bytes,
  retained,
  syncMode,
  onSyncModeChange,
  recycleRecoverable,
  truncated,
  totalActions,
  previewLimit,
  onRevealArchive,
  revealArchiveError,
}: Props) {
  const groups = useMemo(() => {
    const buckets = new Map<ActionType, PlanAction[]>();
    for (const action of actions) {
      const bucket = buckets.get(action.type);
      if (bucket) bucket.push(action);
      else buckets.set(action.type, [action]);
    }
    return GROUP_ORDER.filter((type) => (buckets.get(type)?.length ?? 0) > 0).map((type) => ({
      type,
      label: KIND_LABEL[type],
      items: buckets.get(type) ?? [],
    }));
  }, [actions]);

  // 内容一致的条目通常占绝大多数，默认收起；其余分组默认展开。
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ skip: true });
  const toggle = (type: ActionType) =>
    setCollapsed((prev) => ({ ...prev, [type]: !prev[type] }));

  const limit = previewLimit ?? 20000;
  const shownTotal = totalActions ?? actions.length;
  // 还没生成计划时不摆一排 0，避免把「没有计划」误读成「计划是空的」。
  const hasPlan = totalFiles > 0 || actions.length > 0;

  return (
    <>
      <div className="section">
        <div className="section-title">备份计划</div>
        {hasPlan ? (
          <div className="stat-row">
            <div className="stat">
              <span className="stat-value">{fmtInt(totalFiles)}</span>
              <span className="stat-label">源端文件</span>
            </div>
            <div className="stat">
              <span className="stat-value">{fmtInt(copy)}</span>
              <span className="stat-label">新增</span>
            </div>
            <div className="stat">
              <span className="stat-value">{fmtInt(update)}</span>
              <span className="stat-label">更新</span>
            </div>
            <div className="stat">
              <span className="stat-value">{fmtInt(rename)}</span>
              <span className="stat-label">改名</span>
            </div>
            <div className="stat" data-tone={deleteCount > 0 ? 'danger' : undefined}>
              <span className="stat-value">{fmtInt(deleteCount)}</span>
              <span className="stat-label">删除</span>
            </div>
            {retained > 0 ? (
              <div className="stat">
                <span className="stat-value">{fmtInt(retained)}</span>
                <span className="stat-label">保留</span>
              </div>
            ) : null}
            <div className="stat">
              <span className="stat-value">{fmtInt(skip)}</span>
              <span className="stat-label">内容一致</span>
            </div>
            <div className="stat">
              <span className="stat-value">{fmtBytes(bytes)}</span>
              <span className="stat-label">待传输</span>
            </div>
          </div>
        ) : (
          <p className="empty-hint">尚未生成计划</p>
        )}
      </div>

      <div className="section">
        <div className="section-title">同步方式</div>
        <div className="mode-options" role="group" aria-label="同步方式">
          {MODE_OPTIONS.map((option) => (
            <button
              key={option.mode}
              type="button"
              className="mode-option"
              data-danger={option.danger ? 'true' : undefined}
              aria-pressed={syncMode === option.mode}
              onClick={() => onSyncModeChange(option.mode)}
            >
              <span className="mode-option-title">{option.title}</span>
              <span className="mode-option-desc">{option.desc}</span>
            </button>
          ))}
        </div>
        {syncMode === 'mirror-archive' && onRevealArchive ? (
          <>
            <button type="button" className="btn btn-sm" onClick={onRevealArchive}>
              查看归档目录
            </button>
            {revealArchiveError ? (
              <div className="plan-warning" data-tone="danger" role="alert">
                <IconAlert size={13} className="icon-inline" />
                <span className="plan-warning-text">{revealArchiveError}</span>
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="section">
        {deleteCount > 0 ? (
          <div
            className="plan-warning"
            data-tone={recycleRecoverable ? 'recoverable' : 'danger'}
            role="status"
          >
            {recycleRecoverable ? (
              <IconShield size={13} className="icon-inline" />
            ) : (
              <IconAlert size={13} className="icon-inline" />
            )}
            <span className="plan-warning-text">
              {recycleRecoverable
                ? `本次将从备份端删除 ${fmtInt(deleteCount)} 个文件（源端已不存在），删除内容会进入回收站，可随时还原。`
                : `本次将从备份端永久删除 ${fmtInt(deleteCount)} 个文件（源端已不存在），且不留副本，无法恢复。`}
            </span>
          </div>
        ) : null}
        <div className="section-title">待处理文件</div>
        {truncated ? (
          <p className="plan-truncated">
            共 {fmtInt(shownTotal)} 项，已展示前 {fmtInt(limit)} 项
          </p>
        ) : null}
        {groups.length === 0 ? (
          <p className="empty-hint">扫描后在此按类型列出待处理文件</p>
        ) : (
          <div className="plan-groups">
            {groups.map((group) => {
              const open = !collapsed[group.type];
              return (
                <section key={group.type} className="plan-group" data-open={open}>
                  <button
                    type="button"
                    className="plan-group-head"
                    aria-expanded={open}
                    onClick={() => toggle(group.type)}
                  >
                    <span className="plan-group-label">{group.label}</span>
                    <span className="plan-group-count">{fmtInt(group.items.length)}</span>
                  </button>
                  {open ? (
                    <div className="list-shell">
                      <VirtualList
                        items={group.items}
                        rowHeight={ROW_HEIGHT}
                        rowClassName="action-row"
                        emptyHint="没有此类条目"
                        renderRow={(action) => (
                          <>
                            <span className="action-kind" data-kind={action.type}>
                              <KindGlyph type={action.type} />
                              {KIND_LABEL[action.type]}
                            </span>
                            <FileName value={action.relPath} className="action-name" />
                            {action.note ? (
                              <span className="action-note" title={action.note}>
                                {action.note}
                              </span>
                            ) : null}
                            <span className="action-status" data-status={action.status}>
                              {STATUS_LABEL[action.status]}
                            </span>
                            <span className="action-size">{fmtBytes(action.size)}</span>
                          </>
                        )}
                      />
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
