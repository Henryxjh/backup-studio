import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getApi, type BackupAPI } from './lib/api';
import { createMockApi } from './lib/mock';
import { DirectoryPicker } from './components/DirectoryPicker';
import { PlanPanel } from './components/PlanPanel';
import { MediaDiagnostics } from './components/MediaDiagnostics';
import { AutoSyncPanel } from './components/AutoSync';
import { ProgressPanel } from './components/ProgressPanel';
import { EventFeed } from './components/EventFeed';
import { Splitter } from './components/Splitter';
import { IconAlert, IconCheck, IconLayers, IconMoon, IconRefresh, IconSun } from './components/Icons';
import { useSpringValue } from './hooks/useSpringValue';
import { POP_SPRING } from './lib/spring';
import { fmtBytes, fmtInt } from './lib/format';
import type { AppState, BackupPhase, ScanResult, SyncMode } from '../shared/types';

type StepState = 'idle' | 'active' | 'done';

function Step({ label, state }: { label: string; state: StepState }) {
  return (
    <span className="step" data-state={state}>
      <span className="step-dot" />
      {label}
    </span>
  );
}

const PHASE_LABEL: Record<BackupPhase, string> = {
  idle: '待命',
  scanning: '扫描中',
  planning: '生成计划',
  ready: '计划就绪',
  running: '备份进行中',
  paused: '已暂停',
  completed: '备份完成',
  failed: '备份失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

export default function App() {
  const api = useMemo<BackupAPI>(() => getApi() ?? createMockApi(), []);
  const workspaceRef = useRef<HTMLDivElement>(null);

  const [sourceRoot, setSourceRoot] = useState('');
  const [targetRoot, setTargetRoot] = useState('');
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [syncMode, setSyncMode] = useState<SyncMode>('mirror');
  const [state, setState] = useState<AppState | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [allowMassDelete, setAllowMassDelete] = useState(false);

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('backup-studio-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });

  const { value: checkValue, animate: animateCheck } = useSpringValue(POP_SPRING);
  const [showCheck, setShowCheck] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('backup-studio-theme', theme);
    void api.setTheme(theme);
  }, [theme, api]);

  // 订阅引擎事件：所有状态都来自真实事件，不做前端计时器伪造
  useEffect(() => {
    const offState = api.onState((next) => setState(next));
    const offPlan = api.onPlan((payload) =>
      setState((prev) =>
        prev
          ? {
              ...prev,
              actions: payload.actions,
              summary: payload.summary,
              requiresConfirmation: payload.requiresConfirmation,
              confirmReason: payload.confirmReason,
            }
          : prev,
      ),
    );
    const offProgress = api.onProgress((payload) =>
      setState((prev) =>
        prev
          ? {
              ...prev,
              summary: {
                ...prev.summary,
                copiedBytes: payload.copiedBytes,
                throughput: payload.throughput,
                etaMs: payload.etaMs,
                activeFile: payload.activeFile,
              },
            }
          : prev,
      ),
    );
    const offAction = api.onAction((next) =>
      setState((prev) =>
        prev
          ? { ...prev, actions: prev.actions.map((a) => (a.id === next.id ? next : a)) }
          : prev,
      ),
    );
    const offLog = api.onLog((entry) =>
      setState((prev) =>
        prev ? { ...prev, logs: [...prev.logs, entry].slice(-400) } : prev,
      ),
    );

    void api.getState().then(setState);

    return () => {
      offState();
      offPlan();
      offProgress();
      offAction();
      offLog();
    };
  }, [api]);

  const phase = state?.phase ?? 'idle';
  const media = state?.media ?? 'online';
  const summary = state?.summary;

  // 完成态：对勾欠阻尼微弹，2.5 秒后自动淡出恢复
  useEffect(() => {
    if (phase !== 'completed') return;
    setShowCheck(true);
    animateCheck(0, 1, () => {
      window.setTimeout(() => {
        animateCheck(1, 0, () => setShowCheck(false));
      }, 2500);
    });
  }, [phase, animateCheck]);

  const runScanAndPlan = useCallback(
    async (src: string, dst: string, mode: SyncMode) => {
      if (!src || !dst) return;
      setBusy(true);
      try {
        const result = await api.scan(src, dst);
        setScan(result);
        await api.plan(src, dst, mode);
        setAllowMassDelete(false);
        setConfirming(false);
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  const handleBrowseSource = useCallback(async () => {
    const picked = await api.pickDirectory('选择需要备份的源目录');
    if (!picked) return;
    setSourceRoot(picked);
    await runScanAndPlan(picked, targetRoot, syncMode);
  }, [api, targetRoot, syncMode, runScanAndPlan]);

  const handleBrowseTarget = useCallback(async () => {
    const picked = await api.pickDirectory('选择备份存放的目标目录');
    if (!picked) return;
    setTargetRoot(picked);
    await runScanAndPlan(sourceRoot, picked, syncMode);
  }, [api, sourceRoot, syncMode, runScanAndPlan]);

  const handleCommit = useCallback(() => {
    void runScanAndPlan(sourceRoot, targetRoot, syncMode);
  }, [runScanAndPlan, sourceRoot, targetRoot, syncMode]);

  const handleSyncModeChange = useCallback(
    (mode: SyncMode) => {
      setSyncMode(mode);
      void runScanAndPlan(sourceRoot, targetRoot, mode);
    },
    [runScanAndPlan, sourceRoot, targetRoot],
  );

  const handleStart = useCallback(
    async (confirmedOverride?: boolean) => {
      const confirmed = confirmedOverride ?? allowMassDelete;
      if (state?.requiresConfirmation && !confirmed) {
        setConfirming(true);
        return;
      }
      setBusy(true);
      try {
        await api.start({
          sourceRoot,
          targetRoot,
          syncMode,
          allowMassDelete: confirmed,
          resume: true,
        });
      } catch (err) {
        console.error('启动备份失败', err);
      } finally {
        setBusy(false);
      }
    },
    [api, sourceRoot, targetRoot, syncMode, allowMassDelete, state?.requiresConfirmation],
  );

  const running = phase === 'running' || phase === 'paused';
  const canStart = Boolean(sourceRoot && targetRoot) && !running && phase !== 'scanning' && phase !== 'planning';

  /**
   * 恢复中断的备份。
   *
   * 恢复不是「继续」——必须先做只读检测，再重新扫描生成新计划，
   * 旧计划里的删除动作一律作废。这一步由主进程强制执行。
   */
  const handleRecover = useCallback(async () => {
    setBusy(true);
    try {
      if (targetRoot) {
        await api.assess(targetRoot);
      }
      await api.recover(true);
    } catch (err) {
      // 恢复失败时保留证据，由主进程写入日志
      console.error('恢复备份失败', err);
    } finally {
      setBusy(false);
    }
  }, [api, targetRoot]);

  const step1: StepState = sourceRoot && targetRoot ? 'done' : 'active';
  const step2: StepState = summary && summary.totalFiles > 0 ? 'done' : sourceRoot && targetRoot ? 'active' : 'idle';
  const step3: StepState =
    phase === 'completed' ? 'done' : running ? 'active' : 'idle';

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark">
            <IconLayers size={11} />
          </span>
          Backup Studio
        </div>

        <nav className="steps">
          <Step label="目录" state={step1} />
          <span className="step-sep" aria-hidden="true" />
          <Step label="计划" state={step2} />
          <span className="step-sep" aria-hidden="true" />
          <Step label="执行" state={step3} />
        </nav>

        <div style={{ flex: '1 1 auto' }} />

        <button
          className="btn btn-icon no-drag"
          type="button"
          title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
          aria-label="切换主题"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? <IconSun size={15} /> : <IconMoon size={15} />}
        </button>
      </header>

      <div className="workspace" ref={workspaceRef}>
        <section className="pane pane-left">
          <div className="pane-body">
            <div className="section">
              <div className="section-title">备份目录</div>
              <DirectoryPicker
                sourceRoot={sourceRoot}
                targetRoot={targetRoot}
                scan={scan}
                busy={busy}
                onSourceChange={setSourceRoot}
                onTargetChange={setTargetRoot}
                onBrowseSource={handleBrowseSource}
                onBrowseTarget={handleBrowseTarget}
                onCommit={handleCommit}
              />
            </div>

            {api ? (
              <div className="section">
                <AutoSyncPanel api={api.autoSync} sourceRoot={sourceRoot} targetRoot={targetRoot} />
              </div>
            ) : null}

            <PlanPanel
              actions={state?.actions ?? []}
              copy={summary?.copy ?? 0}
              update={summary?.update ?? 0}
              rename={summary?.rename ?? 0}
              deleteCount={summary?.delete ?? 0}
              skip={summary?.skip ?? 0}
              totalFiles={summary?.totalFiles ?? 0}
              bytes={summary?.bytes ?? 0}
              syncMode={syncMode}
              onSyncModeChange={handleSyncModeChange}
            />

            {confirming && state?.confirmReason ? (
              <div className="banner" data-tone="danger">
                <IconAlert size={13} className="icon-inline" />
                <span>{state.confirmReason}</span>
                <span style={{ flex: '1 1 auto' }} />
                <button className="btn btn-sm" type="button" onClick={() => setConfirming(false)}>
                  取消
                </button>
                <button
                  className="btn btn-sm btn-primary"
                  type="button"
                  onClick={() => {
                    setAllowMassDelete(true);
                    setConfirming(false);
                    void handleStart(true);
                  }}
                >
                  确认并执行
                </button>
              </div>
            ) : null}

            <div className="action-bar">
              <div className="status-line">
                <span className="status-line-text">
                  {running
                    ? `${PHASE_LABEL[phase]}，已传输 ${fmtBytes(summary?.copiedBytes ?? 0)}`
                    : summary
                      ? `已就绪，将写入 ${fmtInt(summary.copy + summary.update + summary.rename)} 个文件，传输 ${fmtBytes(summary.bytes)}`
                      : '请选择源目录与目标目录'}
                </span>
              </div>
              <div className="action-bar-group">
                <button
                  className="btn btn-icon"
                  type="button"
                  title="重新扫描"
                  aria-label="重新扫描"
                  disabled={busy || !sourceRoot || !targetRoot}
                  onClick={handleCommit}
                >
                  <IconRefresh size={15} />
                </button>
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={!canStart || busy}
                  onClick={() => void handleStart()}
                >
                  {showCheck ? (
                    <span
                      className="btn-check"
                      style={{ transform: `scale(${0.5 + checkValue * 0.5})`, opacity: checkValue }}
                    >
                      <IconCheck size={14} />
                    </span>
                  ) : busy ? (
                    <span className="spinner" />
                  ) : null}
                  {phase === 'completed' ? '备份完成' : '开始备份'}
                </button>
              </div>
            </div>
          </div>
        </section>

        <Splitter containerRef={workspaceRef} collapsed={collapsed} onCollapsedChange={setCollapsed} />

        <section className="pane pane-right">
          <div className="pane-body">
            <div className="section">
              <div className="section-title">执行进度</div>
              <ProgressPanel
                phase={phase}
                media={media}
                totalFiles={summary?.totalFiles ?? 0}
                copy={summary?.copy ?? 0}
                update={summary?.update ?? 0}
                rename={summary?.rename ?? 0}
                deleteCount={summary?.delete ?? 0}
                bytes={summary?.bytes ?? 0}
                copiedBytes={summary?.copiedBytes ?? 0}
                elapsedMs={summary?.elapsedMs ?? 0}
                throughput={summary?.throughput ?? 0}
                etaMs={summary?.etaMs ?? 0}
                activeFile={summary?.activeFile}
                assessment={state?.assessment ?? null}
                quarantine={state?.quarantine ?? null}
                onPause={() => void api.pause()}
                onResume={() => void api.resume()}
                onCancel={() => void api.cancel()}
                onRecover={() => void handleRecover()}
                onReleaseQuarantine={() => void api.releaseQuarantine()}
              />
              <MediaDiagnostics key={targetRoot} api={api} root={targetRoot} disabled={phase === 'running' || phase === 'paused'} />
            </div>

            <div className="section" style={{ flex: '1 1 auto', minHeight: 0 }}>
              <div className="section-title">执行事件</div>
              <EventFeed logs={state?.logs ?? []} />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
