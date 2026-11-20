import { useEffect, useMemo, useState } from 'react';
import type { AutoChangeKind, AutoHistory, AutoSyncApi } from '../../../shared/aut-types';
import { fmtBytes } from '../../lib/format';

interface Props {
  api: AutoSyncApi;
  pairId: string;
  busy: boolean;
  /** 撤回由上层统一确认（说明只恢复到备份目录）。 */
  onRestoreVersion: (versionId: string, relPath: string) => void;
}

const CHANGE_LABEL: Record<AutoChangeKind, string> = {
  add: '新增',
  modify: '修改',
  delete: '删除',
  restore: '恢复',
  replace: '替换',
};

const time = (n: number) => new Date(n).toLocaleString('zh-CN', { hour12: false });

/**
 * 版本历史视图。
 *
 * 左边是提交（像 git 的 log），右边是该提交的变更路径；
 * 选中路径后列出这条路径的历史版本，可从任一版本撤回。
 */
export function PairHistory({ api, pairId, busy, onRestoreVersion }: Props) {
  const [history, setHistory] = useState<AutoHistory>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [commitId, setCommitId] = useState('');
  const [relPath, setRelPath] = useState('');

  useEffect(() => {
    let stopped = false;
    setLoading(true);
    setError('');
    setCommitId('');
    setRelPath('');
    void api
      .history(pairId)
      .then((value) => {
        if (stopped) return;
        setHistory(value);
      })
      .catch((err: unknown) => {
        if (stopped) return;
        setHistory(undefined);
        setError(err instanceof Error ? err.message : '读取历史记录失败');
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, [api, pairId]);

  const commits = history?.commits ?? [];
  const commit = useMemo(
    () => commits.find((item) => item.id === commitId) ?? commits[0],
    [commits, commitId],
  );
  const versions = useMemo(
    () =>
      relPath
        ? (history?.versions ?? [])
            .filter((item) => item.relPath === relPath)
            .slice()
            .sort((a, b) => b.at - a.at)
        : [],
    [history, relPath],
  );

  if (loading) return <p className="aut-hint">正在读取历史记录…</p>;
  if (error) return <p className="aut-hint" data-tone="danger">读取历史记录失败：{error}</p>;
  if (!commits.length) return <p className="aut-hint">该配对还没有历史提交。</p>;

  return (
    <div className="aut-history">
      <div className="aut-history-commits">
        <div className="aut-subtitle">提交记录</div>
        <ul className="aut-list">
          {commits.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="aut-commit"
                data-active={item.id === commit?.id}
                onClick={() => {
                  setCommitId(item.id);
                  setRelPath('');
                }}
              >
                <time>{time(item.at)}</time>
                <span className="aut-commit-meta">{item.changes.length} 个变更条目</span>
                <span className="aut-commit-paths">
                  {item.changes.slice(0, 2).map((change) => change.relPath).join('、')}
                  {item.changes.length > 2 ? ` 等 ${item.changes.length} 个路径` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="aut-history-detail">
        <div className="aut-subtitle">变更路径</div>
        {!commit ? <p className="aut-hint">没有可显示的提交。</p> : null}
        {commit ? (
          <ul className="aut-list">
            {commit.changes.map((change) => (
              <li key={`${change.relPath}:${change.kind}`}>
                <button
                  type="button"
                  className="aut-change"
                  data-active={change.relPath === relPath}
                  onClick={() => setRelPath(change.relPath)}
                >
                  <span className="aut-change-kind">{CHANGE_LABEL[change.kind]}</span>
                  <span className="aut-change-path">{change.relPath}</span>
                  {change.size !== undefined ? (
                    <span className="aut-change-size">{fmtBytes(change.size)}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="aut-subtitle">该路径的版本</div>
        {!relPath ? (
          <p className="aut-hint">选择上面一个路径，查看它的历史版本。</p>
        ) : versions.length === 0 ? (
          <p className="aut-hint">该路径没有可撤回的历史版本。</p>
        ) : (
          <ul className="aut-list">
            {versions.map((version) => (
              <li key={version.id} className="aut-version">
                <span className="aut-version-time">{time(version.at)}</span>
                <span className="aut-version-size">{fmtBytes(version.size)}</span>
                <span className="aut-version-hash" title={version.hash}>
                  {version.hash.slice(0, 8)}
                </span>
                <span className="aut-version-kind">{CHANGE_LABEL[version.kind]}</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => onRestoreVersion(version.id, version.relPath)}
                >
                  撤回此版本
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
