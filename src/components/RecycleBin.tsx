import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import { FileName } from './FileName';
import { fmtBytes, fmtInt } from '../lib/format';
import type { BackupAPI } from '../lib/api';
import type { RecycleBin, RecycleEntry } from '../../shared/types';

interface Props {
  api: Pick<BackupAPI, 'listRecycle' | 'restoreRecycle' | 'removeRecycle'>;
  targetRoot: string;
  disabled?: boolean;
  onRetryCleanup?: (entry: RecycleEntry) => Promise<RecycleBin>;
  /**
   * 外部状态变化时递增，触发重新读取。
   * 备份完成后回收站会多出新条目，不刷新的话用户会以为删除没进回收站。
   */
  refreshToken?: number;
}

/** 待确认的动作：还原冲突时的覆盖确认，以及不可逆的彻底删除确认。 */
type Pending = { kind: 'overwrite' | 'remove'; entry: RecycleEntry } | null;

function verifyLabel(entry: RecycleEntry): string {
  const state = entry.contentState ?? (entry.contentVerified ? 'verified'
    : entry.hashBaseline ?? Boolean(entry.archiveSha256) ? 'unverified' : 'unknown');
  switch (state) {
    case 'verified': return '内容已校验';
    case 'unverified': return '有内容校验基线，还原时会严格校验';
    case 'failed': return '内容校验未通过，需人工核对';
    case 'unknown': return '无内容校验基线：还原的是磁盘当前内容';
  }
}

/**
 * 手动备份回收站。
 *
 * 删除的文件只有在进入回收站后才谈得上「可恢复」，所以这里必须能看清三件事：
 * 删掉了什么、占了多少空间、以及还能不能还原。彻底删除是不可逆动作，
 * 一律先过确认层，把后果写在确认按钮之前。
 *
 * 回收站自身也可能有状态问题（索引缺失、条目待核对、实体丢失），
 * 这些必须显式呈现：把「读不出来」显示成「回收站是空的」等于骗用户。
 */
export function RecycleBin({ api, targetRoot, disabled, refreshToken, onRetryCleanup }: Props) {
  const [snapshot, setSnapshot] = useState<RecycleBin | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  // 目标目录切换时旧请求可能后到，用序号丢弃过期结果，避免新数据被旧数据覆盖。
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = (requestSeq.current += 1);
    if (!targetRoot) {
      setSnapshot(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await api.listRecycle(targetRoot);
      if (seq !== requestSeq.current) return;
      setSnapshot(result);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setSnapshot(null);
      setError(err instanceof Error ? err.message : '读取回收站失败');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [api, targetRoot]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const restore = useCallback(
    async (entry: RecycleEntry, overwrite: boolean) => {
      setBusyId(entry.id);
      setError(null);
      try {
        const result = await api.restoreRecycle(targetRoot, entry.id, overwrite);
        setSnapshot(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : '还原失败';
        // 目标位置已被占用不是失败，而是需要用户决定是否覆盖原文件。
        if (!overwrite && message.includes('占用')) {
          setPending({ kind: 'overwrite', entry });
        } else {
          setError(message);
        }
      } finally {
        setBusyId(null);
      }
    },
    [api, targetRoot],
  );

  const remove = useCallback(
    async (entry: RecycleEntry) => {
      setBusyId(entry.id);
      setError(null);
      try {
        const result = await api.removeRecycle(targetRoot, entry.id);
        setSnapshot(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : '彻底删除失败');
      } finally {
        setBusyId(null);
      }
    },
    [api, targetRoot],
  );

  const retryCleanup = useCallback(async (entry: RecycleEntry) => {
    if (!onRetryCleanup) return;
    setBusyId(entry.id);
    setError(null);
    try {
      setSnapshot(await onRetryCleanup(entry));
    } catch (err) {
      setError(err instanceof Error ? err.message : '重试收尾失败');
    } finally {
      setBusyId(null);
    }
  }, [onRetryCleanup]);

  const locked = Boolean(disabled) || loading;
  const pendingEntry = pending?.entry;
  const entries = snapshot?.entries ?? [];
  const totalBytes = snapshot?.totalBytes ?? 0;
  const usedBytes = snapshot?.usedBytes ?? totalBytes;
  const limitBytes = snapshot?.limitBytes;
  const pendingBytes = snapshot?.pendingBytes ?? 0;
  const orphanBytes = snapshot?.orphanBytes ?? 0;
  const uncertainCount = snapshot?.uncertainCount ?? entries.filter((e) => e.state === 'uncertain').length;
  const indexState = snapshot?.indexState ?? 'ok';
  const overLimit = snapshot?.overLimit ?? false;
  const blockedReason = snapshot?.blockedReason;
  // 索引缺失/损坏/不一致时，回收站不是「空的」，而是「读不准的」。
  const inconsistent = indexState !== 'ok';

  return (
    <div className="section">
      <div className="recycle-head">
        <div className="section-title">回收站</div>
        <button
          type="button"
          className="btn btn-sm"
          disabled={locked || !targetRoot}
          onClick={() => void load()}
        >
          {error && !snapshot ? '重试' : '刷新'}
        </button>
      </div>

      {snapshot ? <div className="stat-row">
        <div className="stat">
          <span className="stat-value">{fmtInt(entries.length)}</span>
          <span className="stat-label">回收条目</span>
        </div>
        <div className="stat">
          <span className="stat-value">{fmtBytes(totalBytes)}</span>
          <span className="stat-label">占用空间</span>
        </div>
        {limitBytes !== undefined ? (
          <div className="stat">
            <span className="stat-value">{fmtBytes(limitBytes)}</span>
            <span className="stat-label">容量上限</span>
          </div>
        ) : null}
        {uncertainCount > 0 ? (
          <div className="stat">
            <span className="stat-value">{fmtInt(uncertainCount)}</span>
            <span className="stat-label">待人工核对</span>
          </div>
        ) : null}
      </div> : null}

      {snapshot && limitBytes !== undefined ? (
        <p className="recycle-meta">
          已索引实体 {fmtBytes(usedBytes)}
          {pendingBytes > 0 ? ` · 未决事务 ${fmtBytes(pendingBytes)}` : ''}
          {orphanBytes > 0 ? ` · 无索引实体 ${fmtBytes(orphanBytes)}` : ''}
          {` · 上限 ${fmtBytes(limitBytes)}`}
          {overLimit ? '（已超限）' : ''}
        </p>
      ) : null}

      {error ? (
        <p className="recycle-error" role="alert">
          {error}
        </p>
      ) : null}

      {blockedReason ? (
        <p className="recycle-error" role="alert">
          {blockedReason}
        </p>
      ) : null}

      {!targetRoot ? (
        <p className="empty-hint">选择备份目标目录后可查看回收站</p>
      ) : loading && !snapshot ? (
        <p className="empty-hint">正在读取回收站…</p>
      ) : !snapshot ? (
        error ? <p className="empty-hint">读取失败，请重试。</p> : null
      ) : entries.length === 0 && inconsistent ? (
        <p className="empty-hint">
          回收站状态异常（{indexState}），条目未能可靠读出，请先人工核对后再操作。
        </p>
      ) : entries.length === 0 ? (
        <p className="empty-hint">回收站是空的。被删除的备份文件会出现在这里，随时可以还原。</p>
      ) : (
        <div className="list-shell recycle-list">
          {entries.map((entry) => (
            <div key={entry.id} className="recycle-row">
              <FileName value={entry.relPath} className="recycle-path" />
              <span className="recycle-meta">{fmtBytes(entry.size)}</span>
              <span className="recycle-meta">
                {new Date(entry.deletedAt).toLocaleString('zh-CN')}
              </span>
              {entry.state === 'uncertain' ? (
                <span className="recycle-meta">需人工核对</span>
              ) : null}
              {entry.entityState === 'missing' ? (
                <span className="recycle-meta">副本缺失</span>
              ) : null}
              {entry.cleanupPending ? (
                <span className="recycle-meta">待收尾</span>
              ) : entry.entityState === 'pending' ? (
                <span className="recycle-meta">事务未完成</span>
              ) : null}
              <span className="recycle-meta">{verifyLabel(entry)}</span>
              {entry.error ? <span className="recycle-meta">{entry.error}</span> : null}
              <div className="recycle-actions">
                {entry.cleanupPending ? (
                  <button type="button" className="btn btn-sm" disabled={locked || busyId === entry.id || !onRetryCleanup}
                    onClick={() => void retryCleanup(entry)} title={!onRetryCleanup ? '收尾接口尚未接入' : undefined}>
                    重试收尾
                  </button>
                ) : <><button
                  type="button"
                  className="btn btn-sm"
                  disabled={locked || busyId === entry.id}
                  onClick={() => void restore(entry, false)}
                >
                  还原
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  data-tone="danger"
                  disabled={locked || busyId === entry.id}
                  onClick={() => setPending({ kind: 'remove', entry })}
                >
                  彻底删除
                </button></>}
              </div>
            </div>
          ))}
        </div>
      )}

      {pending?.kind === 'remove' && pendingEntry ? (
        <ConfirmDialog
          title="彻底删除回收项"
          confirmLabel="彻底删除"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const entry = pendingEntry;
            setPending(null);
            void remove(entry);
          }}
        >
          <p>此操作会永久删除回收站里的副本，无法恢复。</p>
          <p>即将删除：{pendingEntry.relPath}</p>
        </ConfirmDialog>
      ) : null}

      {pending?.kind === 'overwrite' && pendingEntry ? (
        <ConfirmDialog
          title="目标位置已有文件"
          confirmLabel="覆盖并还原"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const entry = pendingEntry;
            setPending(null);
            void restore(entry, true);
          }}
        >
          <p>目标位置已有文件，是否覆盖？</p>
          <p>覆盖后目标位置原有的文件将无法恢复。即将还原：{pendingEntry.relPath}</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
