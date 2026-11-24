export function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('zh-CN');
}

export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const decimals = index === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[index]}`;
}

export function fmtThroughput(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0 B/s';
  return `${fmtBytes(bytesPerSecond)}/s`;
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '00:00';
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (hours > 0) return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return `${pad(minutes)}:${pad(seconds)}`;
}

export function fmtClock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return '0%';
  const clamped = Math.max(0, Math.min(1, ratio));
  const percent = clamped * 100;
  if (percent >= 99.95 && percent < 100) return '99%';
  if (percent >= 10) return `${percent.toFixed(0)}%`;
  if (percent >= 1) return `${percent.toFixed(1)}%`;
  return '0%';
}

/**
 * 规范化目录路径的显示形式：除根目录外移除末尾分隔符。
 *
 * 只处理尾部分隔符，不做 realpath、不解析符号链接、不解析 `..`、不归一大小写——
 * 那些属于引擎 `path-identity.ts` 的职责。
 *
 * 保留的根目录语义：Linux `/`、Windows 盘符根 `C:\`（含 `C:/`）、
 * Windows UNC 设备路径 `\\?\C:\`。POSIX 下反斜杠是合法文件名字符，故不当作分隔符。
 */
export function normalizeDirectoryRoot(path: string, isWindows: boolean): string {
  if (isWindows && /^(?:[\\/]{2}[?.][\\/])?[A-Za-z]:[\\/]+$/.test(path)) return path;
  // 全是分隔符时保留原值，否则根目录会被削成空串。
  return path.replace(isWindows ? /[\\/]+$/ : /\/+$/, '') || path;
}
