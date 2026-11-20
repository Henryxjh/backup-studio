import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron';
import path from 'node:path';
import { BackupService } from './engine/service';
import { AutoSync } from './engine/aut';
import { createWritePermit } from './engine/aut/bridge';
import type { SyncMode } from '../shared/types';
import type { AutoPairInput } from '../shared/aut-types';

let mainWindow: BrowserWindow | null = null;
let service: BackupService | null = null;
let autoSync: AutoSync | null = null;

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

  ipcMain.handle('aut:status', async () => aut.status());
  ipcMain.handle('aut:configure', async (_event, input: AutoPairInput) => aut.configure(input));
  ipcMain.handle('aut:set-enabled', async (_event, enabled: boolean) => aut.setEnabled(enabled));
  ipcMain.handle('aut:resume', async () => aut.resume());
  ipcMain.handle('aut:restore', async (_event, id: string) => aut.restore(id));
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

  registerIpc();
  registerAutoIpc();
  createWindow();
  void autoSync.start();

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
