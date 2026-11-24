import { useLayoutEffect, useRef, useState } from 'react';
import { IconDrive, IconFolder } from './Icons';
import { fmtBytes, fmtInt } from '../lib/format';
import type { ScanOutcome } from '../lib/api';

export type DirectoryField = 'source' | 'target';

interface Props {
  sourceRoot: string;
  targetRoot: string;
  scan: ScanOutcome | null;
  busy: boolean;
  onBrowseSource: () => void;
  onBrowseTarget: () => void;
  onCommit: (field: DirectoryField, value: string) => void;
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
  onBrowseSource,
  onBrowseTarget,
  onCommit,
}: Props) {
  const [sourceDraft, setSourceDraft] = useState<string>();
  const [targetDraft, setTargetDraft] = useState<string>();
  // 点「浏览」时输入框会先失焦。此时不应提交草稿：提交会立刻进入扫描态并把
  // 浏览按钮置为 disabled，用户点的对话框反而打不开，还会多扫一次。
  const browsingRef = useRef(false);

  // 浏览等外部更新以父组件为准；同步草稿本身不触发提交。
  useLayoutEffect(() => setSourceDraft(undefined), [sourceRoot]);
  useLayoutEffect(() => setTargetDraft(undefined), [targetRoot]);

  const commitDraft = (field: DirectoryField, draft: string | undefined) => {
    if (draft === undefined) return;
    if (browsingRef.current) return;
    if (field === 'source') setSourceDraft(undefined);
    else setTargetDraft(undefined);
    onCommit(field, draft);
  };

  const startBrowse = (browse: () => void) => {
    browsingRef.current = true;
    try {
      browse();
    } finally {
      // 浏览是异步的，对话框关闭后失焦才发生；下一帧再放开，避免误吞正常失焦提交。
      requestAnimationFrame(() => {
        browsingRef.current = false;
      });
    }
  };

  const commitOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.blur();
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
          value={sourceDraft ?? sourceRoot}
          spellCheck={false}
          placeholder="选择需要备份的源目录"
          aria-label="源目录"
          onChange={(e) => setSourceDraft(e.currentTarget.value)}
          onBlur={() => commitDraft('source', sourceDraft)}
          onKeyDown={commitOnEnter}
        />
        <button
          className="btn btn-sm"
          type="button"
          onClick={() => startBrowse(onBrowseSource)}
          disabled={busy}
        >
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
          value={targetDraft ?? targetRoot}
          spellCheck={false}
          placeholder="选择备份存放的备份目标目录"
          aria-label="备份目标目录"
          onChange={(e) => setTargetDraft(e.currentTarget.value)}
          onBlur={() => commitDraft('target', targetDraft)}
          onKeyDown={commitOnEnter}
        />
        <button
          className="btn btn-sm"
          type="button"
          onClick={() => startBrowse(onBrowseTarget)}
          disabled={busy}
        >
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
