import { useState, type FormEvent } from 'react';
import type { AutoPair, AutoPairInput } from '../../../shared/aut-types';

interface Props {
  /** 编辑模式传入既有配对；缺省即为新增配对。 */
  initial?: AutoPair;
  busy: boolean;
  pickDirectory?: (title: string) => Promise<string | null>;
  onSubmit: (input: AutoPairInput) => void;
  onCancel?: () => void;
}

const DEFAULT_EXCLUDES = '';

/**
 * 配对表单。
 *
 * 一次配置清楚六件事：源目录、备份目标目录、排除规则、删除同步、
 * 保留天数、容量上限。其余字段是引擎契约里的高级项，折叠在「高级选项」里。
 */
export function PairForm({ initial, busy, pickDirectory, onSubmit, onCancel }: Props) {
  const [sourceRoot, setSourceRoot] = useState(initial?.sourceRoot ?? '');
  const [targetRoot, setTargetRoot] = useState(initial?.targetRoot ?? '');
  const [excludes, setExcludes] = useState(initial?.excludes.join('\n') ?? DEFAULT_EXCLUDES);
  const [syncDeletes, setSyncDeletes] = useState(initial?.syncDeletes ?? false);
  const [externalChanges, setExternalChanges] = useState<'pause' | 'overwrite'>(
    initial?.externalChanges ?? 'pause',
  );
  const [pollOnly, setPollOnly] = useState(initial?.pollOnly ?? false);
  const [pollSeconds, setPollSeconds] = useState((initial?.pollMs ?? 30000) / 1000);
  const [retentionDays, setRetentionDays] = useState(initial?.retentionDays ?? 7);
  const [capacityGiB, setCapacityGiB] = useState((initial?.recycleMaxBytes ?? 10 * 1024 ** 3) / 1024 ** 3);
  const [allowSnapshotFiles, setAllowSnapshotFiles] = useState(initial?.allowSnapshotFiles ?? false);
  const [historyGiB, setHistoryGiB] = useState(
    (initial?.historyMaxBytes ?? 50 * 1024 ** 3) / 1024 ** 3,
  );
  const [historyVersions, setHistoryVersions] = useState(initial?.historyMaxVersionsPerPath ?? 20);

  const browse = async (title: string, apply: (value: string) => void) => {
    if (!pickDirectory) return;
    const picked = await pickDirectory(title);
    if (picked) apply(picked);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit({
      sourceRoot: sourceRoot.trim(),
      targetRoot: targetRoot.trim(),
      excludes: excludes
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
      syncDeletes,
      externalChanges,
      pollOnly,
      pollMs: Math.round(pollSeconds * 1000),
      retentionDays,
      recycleMaxBytes: Math.round(capacityGiB * 1024 ** 3),
      allowSnapshotFiles,
      historyMaxBytes: Math.round(historyGiB * 1024 ** 3),
      historyMaxVersionsPerPath: historyVersions,
    });
  };

  return (
    <form className="aut-form" onSubmit={submit}>
      <div className="aut-fields">
        <label className="aut-field">
          <span>源目录</span>
          <div className="aut-field-row">
            <input
              value={sourceRoot}
              required
              spellCheck={false}
              placeholder="需要备份的源目录"
              onChange={(event) => setSourceRoot(event.currentTarget.value)}
            />
            {pickDirectory ? (
              <button type="button" className="btn btn-sm" onClick={() => void browse('选择源目录', setSourceRoot)}>
                浏览
              </button>
            ) : null}
          </div>
        </label>
        <label className="aut-field">
          <span>备份目标目录</span>
          <div className="aut-field-row">
            <input
              value={targetRoot}
              required
              spellCheck={false}
              placeholder="备份写到的目标目录"
              onChange={(event) => setTargetRoot(event.currentTarget.value)}
            />
            {pickDirectory ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void browse('选择备份目标目录', setTargetRoot)}
              >
                浏览
              </button>
            ) : null}
          </div>
        </label>
      </div>

      <label className="aut-field">
        <span>排除规则（每行一条，可用 * 通配）</span>
        <textarea rows={3} value={excludes} onChange={(event) => setExcludes(event.currentTarget.value)} />
      </label>

      <div className="aut-fields">
        <label className="aut-field">
          <span>保留天数</span>
          <input
            type="number"
            min={7}
            max={3650}
            required
            value={retentionDays}
            onChange={(event) => setRetentionDays(Number(event.currentTarget.value))}
          />
        </label>
        <label className="aut-field">
          <span>回收站容量上限（GiB）</span>
          <input
            type="number"
            min={0.000000001}
            step="any"
            required
            value={capacityGiB}
            onChange={(event) => setCapacityGiB(Number(event.currentTarget.value))}
          />
        </label>
      </div>

      <label className="aut-check">
        <input type="checkbox" checked={syncDeletes} onChange={(event) => setSyncDeletes(event.currentTarget.checked)} />
        <span>启用删除同步（目标端多余文件移入回收站，保留期内可撤回）</span>
      </label>

      <details className="aut-advanced">
        <summary>高级选项</summary>
        <label className="aut-check">
          <input type="checkbox" checked={pollOnly} onChange={(event) => setPollOnly(event.currentTarget.checked)} />
          <span>仅轮询（网络盘或云盘，不监听文件系统事件）</span>
        </label>
        <label className="aut-check">
          <input
            type="checkbox"
            checked={allowSnapshotFiles}
            onChange={(event) => setAllowSnapshotFiles(event.currentTarget.checked)}
          />
          <span>包含离线数据库或虚拟机快照文件</span>
        </label>
        <label className="aut-field">
          <span>目标端文件被外部修改时</span>
          <select
            value={externalChanges}
            onChange={(event) => setExternalChanges(event.currentTarget.value as 'pause' | 'overwrite')}
          >
            <option value="pause">暂停并等待人工确认</option>
            <option value="overwrite">保留旧版后再覆盖</option>
          </select>
        </label>
        <div className="aut-fields">
          <label className="aut-field">
            <span>轮询间隔（秒）</span>
            <input
              type="number"
              min={5}
              max={300}
              step="0.001"
              required
              value={pollSeconds}
              onChange={(event) => setPollSeconds(Number(event.currentTarget.value))}
            />
          </label>
          <label className="aut-field">
            <span>历史容量上限（GiB）</span>
            <input
              type="number"
              min={0.000000001}
              step="any"
              required
              value={historyGiB}
              onChange={(event) => setHistoryGiB(Number(event.currentTarget.value))}
            />
          </label>
          <label className="aut-field">
            <span>单路径保留版本数</span>
            <input
              type="number"
              min={1}
              max={1000}
              required
              value={historyVersions}
              onChange={(event) => setHistoryVersions(Number(event.currentTarget.value))}
            />
          </label>
        </div>
      </details>

      <div className="action-bar-group">
        {onCancel ? (
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            取消
          </button>
        ) : null}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {initial ? '保存配对设置' : '新增配对'}
        </button>
      </div>
    </form>
  );
}
