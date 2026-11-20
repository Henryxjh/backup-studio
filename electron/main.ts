import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron';
import path from 'node:path';
import { BackupService } from './engine/service';
import { AutoSync } from './engine/aut';
import { createWritePermit } from './engine/aut/bridge';
import { DuplicateFinder } from './engine/dup';
import type { SyncMode } from '../shared/types';
import type { AutoPairInput } from '../shared/aut-types';
import type { DupActRequest, DupItemAction } from '../shared/dup-types';

let mainWindow: BrowserWindow | null = null;
let service: BackupService | null = null;
let autoSync: AutoSync | null = null;
let duplicateFinder: DuplicateFinder | null = null;

const THEME_COLORS = {
  dark: { background: '#0b0b0a', overlay: '#151515', symbol: '#a9a9a4' },
  light: { background: '#f5f5f3', overlay: '#fcfcfb', symbol: '#4a4a46' },
};

function isSafeExternalUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function themeKey(): 'dark' | 'light' {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function createWindow(): void {
  const palette = THEME_COLORS[themeKey()];

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: palette.background,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: palette.overlay,
      symbolColor: palette.symbol,
      height: 44,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // 窗口关闭即停止自动同步，但保留用户开关意图；重开窗口时重新对账。
    void autoSync?.suspend();
  });

  // 重开窗口时恢复自动备份的监听与对账（不改变已保存的开关）。
  void autoSync?.start();

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  void mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
}

function broadcast(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function registerIpc(): void {
  const svc = service;
  if (!svc) throw new Error('备份服务尚未初始化');

  ipcMain.handle('dialog:pick-directory', async (_event, title: string) => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: title || '选择目录',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '选择',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('backup:scan', async (_event, sourceRoot: string, targetRoot: string) =>
    svc.scan(sourceRoot, targetRoot),
  );

  ipcMain.handle(
    'backup:plan',
    async (_event, sourceRoot: string, targetRoot: string, syncMode: SyncMode) =>
      svc.plan(sourceRoot, targetRoot, syncMode),
  );

  ipcMain.handle('backup:start', async (_event, options) => {
    await svc.start(options);
    return svc.getState();
  });

  ipcMain.handle('backup:pause', async () => {
    svc.pause();
    return svc.getState();
  });

  ipcMain.handle('backup:resume', async () => {
    await svc.resume();
    return svc.getState();
  });

  ipcMain.handle('backup:cancel', async () => {
    svc.cancel();
    return svc.getState();
  });

  ipcMain.handle('backup:get-state', async () => svc.getState());

  ipcMain.handle('backup:cleanup-meta', async () => {
    await svc.cleanupMeta();
    return svc.getState();
  });

  ipcMain.handle('backup:assess', async (_event, targetRoot: string) => {
    const assessment = await svc.assessTarget(targetRoot);
    return { assessment, state: svc.getState() };
  });

  ipcMain.handle('backup:health', (_event, root: string) => svc.health(root));
  ipcMain.handle('backup:reenumerate', (_event, root: string) => svc.reenumerate(root));
  ipcMain.handle('backup:repair-dry-run', (_event, root: string, request: import('../shared/types').RepairRequest) => svc.repairDryRun(root, request));
  ipcMain.handle('backup:partition-evidence', (_event, root: string) => svc.exportPartitionEvidence(root));
  ipcMain.handle('backup:capabilities', async () => (await import('./engine/capability')).capabilityMatrix);

  ipcMain.handle('backup:recover', async (_event, confirmed: boolean) => {
    await svc.recover({ confirmed });
    return svc.getState();
  });

  ipcMain.handle('backup:quarantine', async (_event, reason: string) => {
    await svc.quarantine(svc.getState().targetRoot, reason);
    return svc.getState();
  });

  ipcMain.handle('backup:release-quarantine', async () => {
    await svc.releaseQuarantine();
    return svc.getState();
  });

  // 既有通道：**行为保持不变**，供备份主线定位文件使用。
  // 重复文件检测页走的是下面那条受校验的 `dup:reveal`（FR-14、FR-20）。
  ipcMain.handle('app:reveal', async (_event, targetPath: string) => {
    if (targetPath) shell.showItemInFolder(targetPath);
  });

  ipcMain.handle('app:theme', async (_event, mode: 'light' | 'dark' | 'system') => {
    nativeTheme.themeSource = mode;
    const palette = THEME_COLORS[themeKey()];
    mainWindow?.setBackgroundColor(palette.background);
    mainWindow?.setTitleBarOverlay({
      color: palette.overlay,
      symbolColor: palette.symbol,
      height: 44,
    });
    return themeKey();
  });

  ipcMain.handle('app:open-external', async (_event, url: string) => {
    if (!isSafeExternalUrl(url)) {
      throw new Error('仅允许打开 http/https 外部链接');
    }
    await shell.openExternal(url);
  });
}

function registerAutoIpc(): void {
  const aut = autoSync;
  if (!aut) throw new Error('自动备份尚未初始化');

  // 参数白名单：只接受配对/条目 ID 与布尔开关，其余一律拒绝。
  const pairId = (value: unknown): string => {
    if (typeof value !== 'string' || !/^[a-f0-9-]{8,64}$/i.test(value)) throw new Error('配对 ID 无效');
    return value;
  };
  const itemId = (value: unknown): string => {
    if (typeof value !== 'string' || !/^[a-f0-9-]{8,64}$/i.test(value)) throw new Error('条目 ID 无效');
    return value;
  };
  const flag = (value: unknown): boolean => {
    if (typeof value !== 'boolean') throw new Error('开关参数无效');
    return value;
  };

  ipcMain.handle('aut:status', async () => aut.status());
  ipcMain.handle('aut:add-pair', async (_event, input: AutoPairInput) => aut.addPair(input));
  ipcMain.handle('aut:update-pair', async (_event, id: string, input: Partial<AutoPairInput>) => aut.updatePair(pairId(id), input));
  ipcMain.handle('aut:remove-pair', async (_event, id: string) => aut.removePair(pairId(id)));
  ipcMain.handle('aut:set-enabled', async (_event, id: string, enabled: boolean) => aut.setEnabled(pairId(id), flag(enabled)));
  ipcMain.handle('aut:resume', async (_event, id: string) => aut.resume(pairId(id)));
  ipcMain.handle('aut:restore', async (_event, id: string, recycleId: string) => aut.restore(pairId(id), itemId(recycleId)));
  ipcMain.handle('aut:restore-version', async (_event, id: string, versionId: string) => aut.restoreVersion(pairId(id), itemId(versionId)));
  ipcMain.handle('aut:history', async (_event, id: string) => aut.history(pairId(id)));
}

function registerDupIpc(): void {
  const dup = duplicateFinder;
  if (!dup) throw new Error('重复文件查找器尚未初始化');

  // 主进程是唯一写入点：渲染层只能通过这些受校验的通道请求动作（FR-20）
  ipcMain.handle('dup:status', async () => dup.status());
  ipcMain.handle('dup:scan', async (_event, root: string, options?: { minSizeBytes?: number }) =>
    dup.scan(root, options),
  );
  ipcMain.handle('dup:cancel', async () => dup.cancel());
  ipcMain.handle('dup:markAction', async (_event, root: string, itemIds: string[], action: DupItemAction) =>
    dup.markAction(root, itemIds, action),
  );
  ipcMain.handle('dup:keepGroup', async (_event, root: string, groupId: string, keeperId: string) =>
    dup.keepGroup(root, groupId, keeperId),
  );
  ipcMain.handle('dup:act', async (_event, root: string, request: DupActRequest) => dup.act(root, request));
  ipcMain.handle('dup:suppress', async (_event, root: string, sha256: string, scopeMode: 'root' | 'global', samplePaths: string[]) =>
    dup.suppress(root, sha256, scopeMode, samplePaths),
  );
  ipcMain.handle('dup:suppressions', async (_event, root: string) => dup.listSuppressions(root));
  ipcMain.handle('dup:revokeSuppression', async (_event, sha256?: string) => dup.revokeSuppression(sha256));
  ipcMain.handle('dup:export', async (_event, format: 'json' | 'csv') => dup.exportReport(format));
  ipcMain.handle('dup:restoreQuarantine', async (_event, id: string) => dup.restoreQuarantine(id));

  // 受校验的「定位文件」：路径必须落在本次扫描根之内，且确实是本次扫描结果中的条目。
  // 文件已不存在或不可访问时给出明确提示，不静默失败（FR-14、FR-20）。
  ipcMain.handle('dup:reveal', async (_event, root: string, absPath: string) => dup.reveal(root, absPath));
}

void app.whenReady().then(() => {
  service = new BackupService(app.getPath('userData'));
  service.on('state', (state) => broadcast('backup:state', state));
  service.on('plan', (plan) => broadcast('backup:plan', plan));
  service.on('progress', (progress) => broadcast('backup:progress', progress));
  service.on('action', (action) => broadcast('backup:action', action));
  service.on('log', (entry) => broadcast('backup:log', entry));
  service.on('media', (media) => broadcast('backup:media', media));

  // 自动备份的写入许可由容灾模块裁决，不自行判定。
  autoSync = new AutoSync(path.join(app.getPath('userData'), 'aut'), createWritePermit(service));

  // 重复文件查找器：只读扫描用户指定目录；删除只进系统回收站，不可用时降级本机隔离区。
  // 抑制清单写本机 userData，且会改变「写什么」，因此必须与备份计划同源：
  // 把名单来源注入给备份服务，并在抑制项变更时让旧计划失效。
  duplicateFinder = new DuplicateFinder(path.join(app.getPath('userData'), 'duplicate-finder'), {
    // 系统回收站落地；抛错视为回收站不可用 → 引擎降级到本机隔离区（FR-08）
    trash: async (absPath) => {
      await shell.trashItem(absPath);
    },
    // 写入闸门：与备份引擎同一套裁决，介质异常一律拒绝删除（FR-10）
    gate: async (root) => {
      const verdict = await service!.writeGate(root);
      return { allowed: verdict.allowed, reason: verdict.reason };
    },
    // 备份任务或自动同步正在运行时，删除动作整体禁用（FR-10）
    isBusy: () => Boolean(service?.isBusy()) || Boolean(autoSync?.isRunning()),
    // 系统文件管理器定位；引擎先做路径边界校验，通过后才调用（FR-14、FR-20）
    revealFile: (absPath) => {
      shell.showItemInFolder(absPath);
    },
    onSuppressionsChanged: (_root, reason) => service?.invalidatePlan(reason),
  });
  const finder = duplicateFinder;
  service.setExclusionProvider((sourceRoot) => finder.exclusionPaths(sourceRoot));

  registerIpc();
  registerAutoIpc();
  registerDupIpc();
  createWindow();
  void autoSync.start();
  // 崩溃或关窗后引擎是全新实例：读一次活动账本，界面才有续传入口。
  void service.loadRecoverableJob();

  nativeTheme.on('updated', () => {
    const palette = THEME_COLORS[themeKey()];
    mainWindow?.setTitleBarOverlay({
      color: palette.overlay,
      symbolColor: palette.symbol,
      height: 44,
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
