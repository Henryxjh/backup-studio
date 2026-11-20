import { useMemo, useState } from 'react';
import { IconArrowUpRight, IconCopy, IconLayers, IconTrash } from './Icons';
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
  syncMode: SyncMode;
  onSyncModeChange: (mode: SyncMode) => void;
  /** 引擎是否对计划预览做了截断。 */
  truncated?: boolean;
  /** 截断前的完整条目数。 */
  totalActions?: number;
  /** 预览上限（与引擎 MAX_PREVIEW_ACTIONS 对齐）。 */
  previewLimit?: number;
  /** 打开归档目录的入口（仅「镜像并保留历史」可用）。 */
  onRevealArchive?: () => void;
}

const ROW_HEIGHT = 30;

const KIND_LABEL: Record<ActionType, string> = {
  copy: '新增',
  update: '更新',
  rename: '改名',
  delete: '删除',
  skip: '内容一致（无需复制）',
};

const STATUS_LABEL: Record<ActionStatus, string> = {
  pending: '待执行',
  running: '执行中',
  done: '已完成',
  skipped: '已跳过',
  failed: '失败',
  archived: '已归档',
};

/** 计划条目的展示顺序：先写入，后删除，最后是内容一致的大批量条目。 */
const GROUP_ORDER: ActionType[] = ['copy', 'update', 'rename', 'delete', 'skip'];

function KindGlyph({ type }: { type: ActionType }) {
  if (type === 'copy') return <IconLayers size={12} className="icon-inline" />;
  if (type === 'rename') return <IconArrowUpRight size={12} className="icon-inline" />;
  if (type === 'delete') return <IconTrash size={12} className="icon-inline" />;
  if (type === 'update') return <IconCopy size={12} className="icon-inline" />;
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
  syncMode,
  onSyncModeChange,
  truncated,
  totalActions,
  previewLimit,
  onRevealArchive,
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
            <div className="stat">
              <span className="stat-value">{fmtInt(deleteCount)}</span>
              <span className="stat-label">删除</span>
            </div>
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
          <button
            type="button"
            className="mode-option"
            aria-pressed={syncMode === 'mirror'}
            onClick={() => onSyncModeChange('mirror')}
          >
            <span className="mode-option-title">镜像（目标端多余文件会被删除，不可恢复）</span>
          </button>
          <button
            type="button"
            className="mode-option"
            aria-pressed={syncMode === 'mirror-archive'}
            onClick={() => onSyncModeChange('mirror-archive')}
          >
            <span className="mode-option-title">镜像并保留历史（删除前归档，可还原）</span>
          </button>
        </div>
        {syncMode === 'mirror-archive' && onRevealArchive ? (
          <button type="button" className="btn btn-sm" onClick={onRevealArchive}>
            查看归档目录
          </button>
        ) : null}
      </div>

      <div className="section">
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
