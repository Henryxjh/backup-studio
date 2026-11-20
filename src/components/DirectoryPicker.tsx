import { IconDrive, IconFolder } from './Icons';
import { fmtBytes, fmtInt } from '../lib/format';
import type { ScanOutcome } from '../lib/api';

interface Props {
  sourceRoot: string;
  targetRoot: string;
  scan: ScanOutcome | null;
  busy: boolean;
  onSourceChange: (value: string) => void;
  onTargetChange: (value: string) => void;
  onBrowseSource: () => void;
  onBrowseTarget: () => void;
  onCommit: () => void;
}

function Meta({ files, bytes }: { files: number; bytes: number }) {
  return (
    <div className="path-meta">
      <span>
        <span className="num">{fmtInt(files)}</span> 个文件
      </span>
      <span className="meta-sep" aria-hidden="true" />
      <span className="num">{fmtBytes(bytes)}</span>
    </div>
  );
}

export function DirectoryPicker({
  sourceRoot,
  targetRoot,
  scan,
  busy,
  onSourceChange,
  onTargetChange,
  onBrowseSource,
  onBrowseTarget,
  onCommit,
}: Props) {
  const commitOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.currentTarget.blur();
      onCommit();
    }
  };

  const errors = scan?.errors ?? [];
  // 跳过符号链接的数量属于引擎内部事实：引擎上报就显示，没上报就明确标注。
  const symlinkState =
    scan && typeof scan.skippedSymlinks === 'number'
      ? `${fmtInt(scan.skippedSymlinks)} 个`
      : '引擎未上报';

  return (
    <div className="path-grid">
      <div className="path-label">源目录</div>
      <div className="path-field-row">
        <span className="path-icon">
          <IconFolder size={15} />
        </span>
        <input
          className="path-field"
          value={sourceRoot}
          spellCheck={false}
          placeholder="选择需要备份的源目录"
          aria-label="源目录"
          onChange={(e) => onSourceChange(e.currentTarget.value)}
          onBlur={onCommit}
          onKeyDown={commitOnEnter}
        />
        <button className="btn btn-sm" type="button" onClick={onBrowseSource} disabled={busy}>
          浏览
        </button>
      </div>
      {scan ? <Meta files={scan.sourceFiles} bytes={scan.sourceBytes} /> : null}

      <div className="path-label">备份目标目录</div>
      <div className="path-field-row">
        <span className="path-icon">
          <IconDrive size={15} />
        </span>
        <input
          className="path-field"
          value={targetRoot}
          spellCheck={false}
          placeholder="选择备份存放的备份目标目录"
          aria-label="备份目标目录"
          onChange={(e) => onTargetChange(e.currentTarget.value)}
          onBlur={onCommit}
          onKeyDown={commitOnEnter}
        />
        <button className="btn btn-sm" type="button" onClick={onBrowseTarget} disabled={busy}>
          浏览
        </button>
      </div>
      {scan ? <Meta files={scan.targetFiles} bytes={scan.targetBytes} /> : null}

      {scan ? (
        <div className="scan-diagnostics">
          <div className="scan-diagnostics-line">
            <span>扫描错误：{errors.length ? `${fmtInt(errors.length)} 项` : '无'}</span>
            <span className="meta-sep" aria-hidden="true" />
            <span>跳过符号链接：{symlinkState}</span>
          </div>
          {errors.length ? (
            <details>
              <summary>查看扫描错误</summary>
              <ul>
                {errors.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
