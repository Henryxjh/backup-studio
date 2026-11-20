import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DupApi, DupCopy, DupGroup, DupStatus } from '../../../shared/dup-types';
import { VirtualList } from '../VirtualList';
import './duplicate-finder.css';

const stateLabel: Record<DupStatus['state'], string> = {
  idle: '未扫描',
  scanning: '扫描中',
  hashing: '判定中',
  ready: '报告就绪',
  error: '扫描失败',
};

const relationLabel: Record<DupGroup['relation'], string> = {
  'source-internal': '源端内部',
  'cross-side': '跨端',
};

/** 判定依据：哈希是实算还是复用来的，必须如实标注 */
const basisLabel: Record<DupCopy['basis'], string> = {
  computed: '实算哈希',
  manifest: '清单复用',
  exclusion: '排除记录复用',
};

const time = (n?: number) => (n ? new Date(n).toLocaleString('zh-CN', { hour12: false }) : '尚无');
const mib = (n: number) => `${(n / 1024 ** 2).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} MiB`;
const gib = (n: number) => `${(n / 1024 ** 3).toLocaleString('zh-CN', { maximumFractionDigits: 3 })} GiB`;

export interface DuplicateFinderPanelProps {
  api: DupApi;
  sourceRoot?: string;
  targetRoot?: string;
}

/**
 * 重复文件查找面板。
 *
 * 处置语义（REQ-DUP-001 FR-08 / FR-15）：
 * - 采纳排除只让冗余副本**不再写入目标端**，源端文件一个不动
 * - 采纳前必须明确告知恢复语义变化，避免用户不知情地改变恢复结果
 */
export function DuplicateFinderPanel({ api, sourceRoot = '', targetRoot = '' }: DuplicateFinderPanelProps) {
  const [status, setStatus] = useState<DupStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<string>('');
  const [confirming, setConfirming] = useState(false);
  const [exported, setExported] = useState('');

  useEffect(() => {
    let stopped = false;
    void api
      .status()
      .then((value) => {
        if (!stopped) setStatus(value);
      })
      .catch(() => {
        if (!stopped) setError('无法读取重复文件状态');
      });
    return () => {
      stopped = true;
    };
  }, [api]);

  const perform = useCallback(
    async (fn: () => Promise<DupStatus>) => {
      setBusy(true);
      setError('');
      try {
        const value = await fn();
        setStatus(value);
        return value;
      } catch (err) {
        setError(err instanceof Error ? err.message : '操作失败');
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const report = status?.report;
  const groups = useMemo(() => report?.groups ?? [], [report]);
  const adoptable = useMemo(() => groups.filter((g) => g.adoptable), [groups]);
  const selectedGroups = useMemo(
    () => adoptable.filter((g) => selected.has(g.hash)),
    [adoptable, selected],
  );
  const selectedBytes = selectedGroups.reduce((sum, g) => sum + g.reclaimableBytes, 0);
  const selectedCopies = selectedGroups.reduce((sum, g) => sum + g.redundant.length, 0);
  const current = groups.find((g) => g.hash === detail);

  const toggle = (hash: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  };

  const scanning = status?.state === 'scanning' || status?.state === 'hashing';

  return (
    <section className="dup-panel" aria-label="重复文件">
      <header className="dup-header">
        <div>
          <h2>重复文件</h2>
          <span aria-live="polite">{status ? stateLabel[status.state] : '读取状态中'}</span>
        </div>
        <div className="dup-actions">
          <button
            type="button"
            disabled={busy || !sourceRoot || !targetRoot}
            onClick={() => {
              setSelected(new Set());
              setDetail('');
              void perform(() => api.scan(sourceRoot, targetRoot));
            }}
          >
            {scanning ? '扫描中' : '扫描重复文件'}
          </button>
          {scanning ? (
            <button type="button" disabled={busy} onClick={() => void perform(() => api.cancel())}>
              取消
            </button>
          ) : null}
        </div>
      </header>

      {error ? (
        <p className="dup-alert" role="alert">
          {error}
        </p>
      ) : null}

      {status?.reason ? (
        <p className="dup-alert" role="alert">
          {status.reason}
        </p>
      ) : null}

      {!report ? (
        <p className="dup-hint">尚未扫描。选择源目录与备份目录后点击「扫描重复文件」。</p>
      ) : (
        <>
          <dl className="dup-meter">
            <div>
              <dt>重复组</dt>
              <dd>{report.totalGroups}</dd>
            </div>
            <div>
              <dt>副本总数</dt>
              <dd>{report.totalCopies}</dd>
            </div>
            <div>
              <dt>可回收</dt>
              <dd>{mib(report.reclaimableBytes)}</dd>
            </div>
            <div>
              <dt>判定失败</dt>
              <dd>{report.failures.length}</dd>
            </div>
          </dl>

          {!report.complete ? (
            <p className="dup-alert" role="alert">
              扫描不完整：源端 {report.sourceErrors} 处、目标端 {report.targetErrors} 处不可读，
              另有 {report.failures.length} 个文件判定失败。结论仅供参考，未判定成功的文件不会出现在下方列表中。
            </p>
          ) : null}

          {report.truncated ? (
            <p className="dup-hint">
              共 {report.totalGroups} 组重复，界面仅展示前 {groups.length} 组。导出文件包含全部分组。
            </p>
          ) : null}

          {report.failures.length ? (
            <details>
              <summary>判定失败清单：{report.failures.length} 项</summary>
              <ul className="dup-list">
                {report.failures.slice(0, 100).map((f, i) => (
                  <li key={`${f.relPath}-${i}`}>
                    <span>
                      {f.relPath}
                      <small>
                        {f.side === 'source' ? '源端' : '目标端'} · {f.reason}
                      </small>
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <div className="dup-groups">
            <VirtualList
              items={groups}
              rowHeight={64}
              rowClassName="dup-row"
              emptyHint="未发现重复文件"
              renderRow={(group) => {
                const checked = selected.has(group.hash);
                return (
                  <div className="dup-group">
                    <label className="dup-pick">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!group.adoptable || busy}
                        onChange={() => toggle(group.hash)}
                        aria-label={`选择重复组 ${group.hash.slice(0, 12)}`}
                      />
                    </label>
                    <button
                      type="button"
                      className="dup-open"
                      onClick={() => setDetail(group.hash === detail ? '' : group.hash)}
                    >
                      <span className="dup-title">
                        {group.copies.length} 份副本 · {mib(group.size)}
                        <em data-relation={group.relation}>{relationLabel[group.relation]}</em>
                        {group.zeroByte ? <em data-tone="warn">零字节</em> : null}
                        {group.hardLinked ? <em data-tone="warn">硬链接</em> : null}
                      </span>
                      <small>
                        哈希 {group.hash.slice(0, 16)}… · 规范副本 {group.canonical ?? '源端无副本'} ·
                        可回收 {mib(group.reclaimableBytes)}
                      </small>
                    </button>
                  </div>
                );
              }}
            />
          </div>

          {current ? (
            <details open onChange={(e) => e.currentTarget.open && setDetail(current.hash)}>
              <summary>组内副本（{current.copies.length}）</summary>
              <ul className="dup-list">
                {current.copies.map((copy) => (
                  <li key={copy.relPath}>
                    <span>
                      {copy.relPath}
                      <small>
                        {copy.side === 'source' ? '源端' : copy.side === 'target' ? '目标端' : '源端 + 目标端'} ·{' '}
                        {mib(copy.size)} · {basisLabel[copy.basis]}
                        {copy.relPath === current.canonical ? ' · 规范副本' : ''}
                        {current.redundant.some((r) => r.relPath === copy.relPath) ? ' · 冗余副本' : ''}
                      </small>
                    </span>
                  </li>
                ))}
              </ul>
              {current.copiesTruncated ? <p className="dup-hint">副本过多，组内仅展示前若干条。</p> : null}
            </details>
          ) : null}

          {confirming ? (
            <div className="dup-confirm">
              <p>
                采纳后，{selectedCopies} 个冗余副本将<b>不再写入备份目录</b>，可少写入约{' '}
                {mib(selectedBytes)}。源端文件不会被删除、移动或改名。
              </p>
              <p className="dup-hint">
                恢复语义变化：恢复出的目录不再与源端结构一一对应，内容字节可完整还原，
                被排除副本的路径与独立元数据（修改时间、权限）不再还原。
              </p>
              <div className="dup-actions">
                <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
                  取消
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void perform(async () => {
                      const next = await api.adopt([...selected]);
                      setSelected(new Set());
                      setConfirming(false);
                      return next;
                    });
                  }}
                >
                  确认采纳排除
                </button>
              </div>
            </div>
          ) : (
            <div className="dup-actions">
              <button
                type="button"
                disabled={busy || selectedGroups.length === 0}
                onClick={() => setConfirming(true)}
              >
                排除选中的 {selectedGroups.length} 组
              </button>
              <button
                type="button"
                disabled={busy || (status?.excludedCount ?? 0) === 0}
                onClick={() => {
                  setSelected(new Set());
                  void perform(() => api.revoke());
                }}
              >
                撤销全部排除（{status?.excludedCount ?? 0}）
              </button>
              <button
                type="button"
                disabled={busy || !report}
                onClick={() => {
                  void perform(async () => {
                    const result = await api.exportReport('json');
                    setExported(`${result.path}（${mib(result.bytes)}）`);
                    return (await api.status()) as DupStatus;
                  });
                }}
              >
                导出报告
              </button>
            </div>
          )}

          {exported ? <p className="dup-hint">已导出：{exported}</p> : null}

          {status?.excludedCount ? (
            <details>
              <summary>排除名单：{status.excludedCount} 项，占用 {gib(status.excludedBytes)}</summary>
              <ul className="dup-list">
                {status.excludedPaths.map((rel) => (
                  <li key={rel}>
                    <span>
                      {rel}
                      <small>不再写入备份目录；源端文件保留</small>
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}

      {status?.recent.length ? (
        <details>
          <summary>最近事件</summary>
          <ul className="dup-list">
            {status.recent.slice(0, 10).map((event, i) => (
              <li key={`${event.at}-${i}`}>
                <span>
                  {event.action}
                  {event.detail ? <small>{event.detail}</small> : null}
                </span>
                <time>{time(event.at)}</time>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
