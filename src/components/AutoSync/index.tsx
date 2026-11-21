import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  AutoPairInput,
  AutoPairStatus,
  AutoRunState,
  AutoStatus,
  AutoSyncApi,
} from '../../../shared/aut-types';
import { ConfirmDialog } from '../ConfirmDialog';
import { PairForm } from './PairForm';
import { PairHistory } from './PairHistory';
import { fmtBytes } from '../../lib/format';
import './auto-sync.css';

export interface AutoSyncPanelProps {
  api: AutoSyncApi;
  pickDirectory?: (title: string) => Promise<string | null>;
  /** 聚焦配对的备份目标目录变化时回调，供右栏诊断使用。 */
  onActiveTargetChange?: (targetRoot: string) => void;
  onRunningChange?: (running: boolean) => void;
}

const STATE_LABEL: Record<AutoRunState, string> = {
  off: '已关闭',
  scanning: '对账中',
  syncing: '同步中',
  idle: '空闲',
  waiting: '等待介质',
  paused: '已暂停',
  error: '错误',
};

const BLOCK_LABEL: Record<string, string> = {
  offline: '介质离线',
  isolated: '隔离观察中',
  level2: '容灾判定 L2',
  'repair-required': '需人工修复',
  'health-unknown': '健康状况未知',
  denied: '写入被拒绝',
};

const time = (n?: number) => (n ? new Date(n).toLocaleString('zh-CN', { hour12: false }) : '尚无');

type Tab = 'recycle' | 'history' | 'events';
type FormMode = 'view' | 'add' | 'edit';

type ConfirmState =
  | { kind: 'remove'; pairId: string; targetRoot: string }
  | { kind: 'restore'; pairId: string; recycleId: string; relPath: string }
  | { kind: 'restoreVersion'; pairId: string; versionId: string; relPath: string }
  | null;

/**
 * 自动备份（REQ-AUT-003）。
 *
 * 整个模块是一个整体：上层是配对列表，下层是当前配对的详情；
 * 回收站与版本历史都属于「这个配对会删什么、留什么、能不能撤回」，
 * 因此直接嵌在配对详情里，不做成互相割裂的独立区块。
 */
export function AutoSyncPanel({ api, pickDirectory, onActiveTargetChange, onRunningChange }: AutoSyncPanelProps) {
  const [status, setStatus] = useState<AutoStatus>();
  const [focusId, setFocusId] = useState('');
  const [tab, setTab] = useState<Tab>('recycle');
  const [formMode, setFormMode] = useState<FormMode>('view');
  const [formOpen, setFormOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState('');
  const [confirm, setConfirm] = useState<ConfirmState>(null);

  // 轮询状态：引擎侧没有推送配对状态变更，只能低频读取。
  useEffect(() => {
    if (busy) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const value = await api.status();
        if (!stopped) setStatus(value);
      } catch (err) {
        if (!stopped) setAlert(err instanceof Error ? err.message : '无法读取自动备份状态');
      }
      if (!stopped) timer = setTimeout(refresh, 1000);
    };
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [api, busy]);

  useEffect(() => {
    if (status) onRunningChange?.(status.state === 'scanning' || status.state === 'syncing');
  }, [status, onRunningChange]);

  const pairs = status?.pairs ?? [];
  // 优先用用户在本界面选中的配对；没选过时沿用引擎给出的 activePairId。
  const focused = useMemo(
    () =>
      pairs.find((item) => item.pair.id === focusId) ??
      pairs.find((item) => item.pair.id === status?.activePairId) ??
      pairs[0],
    [pairs, focusId, status?.activePairId],
  );

  useEffect(() => {
    onActiveTargetChange?.(focused?.pair.targetRoot ?? '');
  }, [focused, onActiveTargetChange]);

  const perform = async (fn: () => Promise<AutoStatus>) => {
    setBusy(true);
    setAlert('');
    try {
      const next = await fn();
      setStatus(next);
      return next;
    } catch (err) {
      setAlert(err instanceof Error ? err.message : '操作失败');
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  /** 开关不可用的原因：必须讲清楚，而不是把开关悄悄灰掉。 */
  const switchReason = (entry: AutoPairStatus): string | undefined => {
    if (busy) return '操作进行中，请稍候';
    if (entry.block) return `引擎已阻止：${entry.block.reason}`;
    if (!entry.available) {
      return entry.reason ? `配对当前不可用：${entry.reason}` : '配对当前不可用（引擎未上报原因）';
    }
    return undefined;
  };

  const submitPair = (input: AutoPairInput) => {
    if (formMode === 'edit' && focused) {
      void perform(async () => {
        const next = await api.updatePair(focused.pair.id, input);
        setFormMode('view');
        return next;
      });
      return;
    }
    void perform(async () => {
      const next = await api.addPair(input);
      const created = next.pairs[next.pairs.length - 1];
      setFocusId(created?.pair.id ?? '');
      setFormMode('view');
      return next;
    });
  };

  const recycle = focused?.recycle ?? [];
  const earliestExpiry = recycle.reduce<number | undefined>(
    (earliest, item) => (earliest === undefined || item.expiresAt < earliest ? item.expiresAt : earliest),
    undefined,
  );

  const confirmCopy = (): { title: string; confirmLabel: string; body: ReactNode } | null => {
    if (!confirm) return null;
    if (confirm.kind === 'remove') {
      return {
        title: '解除配对',
        confirmLabel: '解除配对',
        body: (
          <>
            <p>解除后，Backup Studio 不再监控这个源目录，也不会再向该备份目标目录写入。</p>
            <p>
              <strong>历史与回收站仍保留在原备份介质上</strong>
              ：{confirm.targetRoot}
            </p>
            <p>介质上的文件不会被删除，仍可手动取回。</p>
          </>
        ),
      };
    }
    if (confirm.kind === 'restore') {
      return {
        title: '恢复到备份目录',
        confirmLabel: '恢复',
        body: (
          <>
            <p>
              将 <strong>{confirm.relPath}</strong> 从回收站取回。
            </p>
            <p>只恢复到备份目录，不会写回源目录。</p>
          </>
        ),
      };
    }
    return {
      title: '撤回历史版本',
      confirmLabel: '撤回',
      body: (
        <>
          <p>
            将 <strong>{confirm.relPath}</strong> 回退到所选历史版本。
          </p>
          <p>只恢复到备份目录，不会写回源目录。</p>
        </>
      ),
    };
  };

  const confirmView = confirmCopy();

  return (
    <section className="aut-panel" aria-label="自动备份">
      <header className="aut-header">
        <div className="aut-header-titles">
          <h2 className="section-title">自动备份</h2>
          <span aria-live="polite">
            {status ? STATE_LABEL[status.state] : '读取状态中'}
            {pairs.length ? ` · ${pairs.length} 个配对` : ''}
          </span>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            setFormMode('add');
            setFormOpen(true);
          }}
        >
          新增配对
        </button>
      </header>

      {alert ? (
        <div className="aut-alert" role="alert">
          <span>{alert}</span>
          <span style={{ flex: '1 1 auto' }} />
          <button type="button" className="btn btn-sm" onClick={() => setAlert('')}>
            关闭
          </button>
        </div>
      ) : null}

      <div className="aut-columns">
        {/* ---------- 第一层：配对列表 ---------- */}
        <div className="aut-list-pane" aria-label="配对列表">
          <div className="aut-subtitle">配对列表</div>
          {pairs.length === 0 ? (
            <p className="aut-hint">尚未配置配对。手动备份用的目录不会自动变成自动备份配对。</p>
          ) : (
            <ul className="aut-list">
              {pairs.map((entry) => {
                const reason = switchReason(entry);
                const reasonId = `aut-switch-reason-${entry.pair.id}`;
                return (
                  <li key={entry.pair.id} className="aut-pair" data-active={entry.pair.id === focused?.pair.id}>
                    <button
                      type="button"
                      className="aut-pair-main"
                      onClick={() => {
                        setFocusId(entry.pair.id);
                        setFormMode('view');
                      }}
                    >
                      <span className="aut-pair-route">
                        <span className="aut-pair-path">{entry.pair.sourceRoot}</span>
                        <span className="aut-pair-arrow" aria-hidden="true">
                          →
                        </span>
                        <span className="aut-pair-path">{entry.pair.targetRoot}</span>
                      </span>
                      <span className="aut-pair-state" data-state={entry.state}>
                        {entry.block ? (BLOCK_LABEL[entry.block.code] ?? entry.state) : STATE_LABEL[entry.state]}
                      </span>
                      <span className="aut-pair-counts">
                        提交 {entry.historyCounts.commits} · 版本 {entry.historyCounts.versions}
                      </span>
                    </button>
                    <label className="aut-switch">
                      <input
                        type="checkbox"
                        role="switch"
                        checked={entry.pair.enabled}
                        disabled={Boolean(reason)}
                        aria-describedby={reason ? reasonId : undefined}
                        onChange={(event) => {
                          const enabled = event.currentTarget.checked;
                          void perform(() => api.setEnabled(entry.pair.id, enabled));
                        }}
                      />
                      <span>自动备份</span>
                    </label>
                    {reason ? (
                      <p className="aut-switch-reason" id={reasonId}>
                        {reason}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* ---------- 第二层：当前配对详情 ---------- */}
        <div className="aut-detail" aria-label="当前配对详情">
          {!focused ? (
            <>
              <div className="aut-subtitle">当前配对</div>
              <p className="aut-hint" data-tone="danger">
                未配置（未绑定）
              </p>
            </>
          ) : (
            <>
              <div className="aut-detail-head">
                <div className="aut-subtitle">当前配对</div>
                <div className="action-bar-group">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setFormMode('edit');
                      setFormOpen(true);
                    }}
                  >
                    修改配对
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      setConfirm({
                        kind: 'remove',
                        pairId: focused.pair.id,
                        targetRoot: focused.pair.targetRoot,
                      })
                    }
                  >
                    解除配对
                  </button>
                </div>
              </div>

              <dl className="aut-route">
                <dt>源目录</dt>
                <dd>{focused.pair.sourceRoot}</dd>
                <dt>备份目标目录</dt>
                <dd>{focused.pair.targetRoot}</dd>
              </dl>

              <dl className="aut-meter">
                <div>
                  <dt>监听方式</dt>
                  <dd>{focused.polling ? '轮询（非实时）' : '本地监听'}</dd>
                </div>
                <div>
                  <dt>待处理批次</dt>
                  <dd>
                    {focused.pending} / 重试 {focused.attempts}
                  </dd>
                </div>
                <div>
                  <dt>最后对账</dt>
                  <dd>{time(focused.lastSync)}</dd>
                </div>
                <div>
                  <dt>删除保护</dt>
                  <dd>
                    {focused.pair.syncDeletes
                      ? `回收站，至少保留 ${focused.pair.retentionDays} 天`
                      : '备份端保留'}
                  </dd>
                </div>
                <div>
                  <dt>本次运行删除</dt>
                  <dd>{focused.sessionDeletes} 个（受软件管理）</dd>
                </div>
                <div>
                  <dt>运行前删除</dt>
                  <dd>{focused.unmanagedDeletes} 个（不归软件管）</dd>
                </div>
                <div>
                  <dt>最近提交数</dt>
                  <dd>{focused.historyCounts.commits}</dd>
                </div>
                <div>
                  <dt>版本数</dt>
                  <dd>{focused.historyCounts.versions}</dd>
                </div>
              </dl>

              {focused.reason ? (
                <p className="aut-hint" data-tone={focused.block ? 'danger' : undefined}>
                  {focused.reason}
                </p>
              ) : null}

              {focused.block ? (
                <div className="aut-alert" role="alert">
                  <span>
                    {focused.block.reason}
                    {focused.block.code === 'repair-required'
                      ? '：请停止使用该卷，由人工在系统中核对并处理；处理后再重新对账。'
                      : ''}
                  </span>
                  {focused.block.evidence?.length ? (
                    <details>
                      <summary>查看只读检测证据</summary>
                      <ul className="aut-list">
                        {focused.block.evidence.map((item, index) => (
                          <li key={index}>{item}</li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </div>
              ) : null}

              {focused.pair.enabled && ['waiting', 'paused', 'error'].includes(focused.state) ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy || !focused.available}
                  onClick={() => void perform(() => api.resume(focused.pair.id))}
                >
                  确认并重新对账
                </button>
              ) : null}

              <section className="aut-form-section">
                <div className="aut-detail-head">
                  <div className="aut-subtitle">
                    {formMode === 'add' ? '新增配对' : formMode === 'edit' ? '修改配对' : '配对设置'}
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-expanded={formOpen}
                    onClick={() => setFormOpen((open) => !open)}
                  >
                    {formOpen ? '收起' : '展开'}
                  </button>
                </div>
                {formOpen ? (
                  formMode === 'add' ? (
                    <PairForm
                      key="new"
                      busy={busy}
                      pickDirectory={pickDirectory}
                      onSubmit={submitPair}
                      onCancel={() => setFormMode('view')}
                    />
                  ) : (
                    <PairForm
                      key={focused.pair.id}
                      initial={focused.pair}
                      busy={busy}
                      pickDirectory={pickDirectory}
                      onSubmit={submitPair}
                      onCancel={() => setFormMode('view')}
                    />
                  )
                ) : null}
              </section>

              {/* 回收站摘要常驻：项数、占用、最早到期时间 */}
              <section className="aut-recycle-summary" aria-label="回收站摘要">
                <div className="aut-subtitle">回收站</div>
                <dl className="aut-meter">
                  <div>
                    <dt>条目数</dt>
                    <dd>{recycle.length}</dd>
                  </div>
                  <div>
                    <dt>占用</dt>
                    <dd>{fmtBytes(focused.recycleBytes)}</dd>
                  </div>
                  <div>
                    <dt>最早到期</dt>
                    <dd>{earliestExpiry ? time(earliestExpiry) : '无'}</dd>
                  </div>
                </dl>
              </section>

              <nav className="aut-tabs" aria-label="配对详情视图">
                <button
                  type="button"
                  aria-pressed={tab === 'recycle'}
                  onClick={() => setTab('recycle')}
                >
                  回收站 ({recycle.length})
                </button>
                <button
                  type="button"
                  aria-pressed={tab === 'history'}
                  onClick={() => setTab('history')}
                >
                  版本历史 ({focused.historyCounts.versions})
                </button>
                <button
                  type="button"
                  aria-pressed={tab === 'events'}
                  onClick={() => setTab('events')}
                >
                  最近事件
                </button>
              </nav>

              <div className="aut-tab-body">
                {tab === 'recycle' ? (
                  recycle.length === 0 ? (
                    <p className="aut-hint">该配对的回收站为空。</p>
                  ) : (
                    <ul className="aut-list">
                      {recycle.map((item) => (
                        <li key={item.id} className="aut-entry">
                          <span>
                            {item.relPath}
                            <small>
                              {item.kind === 'delete' ? '已回收' : '替换前版本'} · 最早保留至{' '}
                              {time(item.expiresAt)} · {fmtBytes(item.size)}
                            </small>
                          </span>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busy || !focused.available || Boolean(focused.block) || item.pending}
                            onClick={() =>
                              setConfirm({
                                kind: 'restore',
                                pairId: focused.pair.id,
                                recycleId: item.id,
                                relPath: item.relPath,
                              })
                            }
                          >
                            恢复到备份目录
                          </button>
                        </li>
                      ))}
                    </ul>
                  )
                ) : null}

                {tab === 'history' ? (
                  <PairHistory
                    api={api}
                    pairId={focused.pair.id}
                    busy={busy}
                    onRestoreVersion={(versionId, relPath) =>
                      setConfirm({
                        kind: 'restoreVersion',
                        pairId: focused.pair.id,
                        versionId,
                        relPath,
                      })
                    }
                  />
                ) : null}

                {tab === 'events' ? (
                  focused.recent.length === 0 ? (
                    <p className="aut-hint">该配对还没有事件。</p>
                  ) : (
                    <ul className="aut-list">
                      {focused.recent.slice(0, 20).map((event, index) => (
                        <li key={`${event.at}-${index}`} className="aut-entry">
                          <span>
                            {event.action}
                            {event.detail ? <small>{event.detail}</small> : null}
                          </span>
                          <time>{time(event.at)}</time>
                        </li>
                      ))}
                    </ul>
                  )
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>

      {confirmView ? (
        <ConfirmDialog
          title={confirmView.title}
          confirmLabel={confirmView.confirmLabel}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const current = confirm;
            setConfirm(null);
            if (!current) return;
            if (current.kind === 'remove') {
              void perform(async () => {
                const next = await api.removePair(current.pairId);
                setFocusId(next.pairs[0]?.pair.id ?? '');
                return next;
              });
              return;
            }
            if (current.kind === 'restore') {
              void perform(() => api.restore(current.pairId, current.recycleId));
              return;
            }
            void perform(() => api.restoreVersion(current.pairId, current.versionId));
          }}
        >
          {confirmView.body}
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
