import type { DupSuppression } from '../../../shared/dup-types';
import { IconX } from '../Icons';
import { fmtInt } from '../../lib/format';

interface Props {
  items: DupSuppression[];
  busy: boolean;
  onClose: () => void;
  /** 撤销单条（传入 sha256）或全部（不传） */
  onRevoke: (sha256?: string) => void;
}

function timeText(ts: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

/**
 * 抑制清单（FR-13）。
 *
 * 这是抑制项**唯一**的撤销入口：检测页顶部工具栏常驻「抑制清单 (N)」，
 * 主界面不重复放置该入口，避免出现第二套抑制语义。
 */
export function SuppressPanel({ items, busy, onClose, onRevoke }: Props) {
  return (
    <div className="dup-drawer" role="dialog" aria-modal="false" aria-label="抑制清单">
      <div className="dup-drawer-card">
        <header className="dup-drawer-head">
          <div>
            <h2>抑制清单 ({fmtInt(items.length)})</h2>
            <p className="dup-hint">
              标记为「下次不提醒」的内容哈希会记在这里，撤销后下次检测重新提示。
            </p>
          </div>
          <div className="dup-drawer-actions">
            <button
              className="btn btn-sm"
              type="button"
              disabled={busy || !items.length}
              onClick={() => onRevoke()}
              aria-label="撤销全部抑制项"
            >
              全部撤销
            </button>
            <button className="btn btn-sm btn-icon" type="button" onClick={onClose} aria-label="关闭抑制清单">
              <IconX size={14} />
            </button>
          </div>
        </header>

        {items.length === 0 ? (
          <p className="dup-hint">
            暂无抑制项：对结果点击「下次不提醒」后，被抑制的内容哈希会出现在这里，随时可撤销。
          </p>
        ) : (
          <ul className="dup-suppress-list">
            {items.map((item) => (
              <li key={`${item.scopeMode}:${item.sha256}`} className="dup-suppress-row">
                <span className="dup-suppress-main">
                  <span className="dup-suppress-fingerprint">{item.fingerprint}</span>
                  <span className="dup-suppress-name">
                    {item.sampleFileNames.length ? item.sampleFileNames.join('、') : item.samplePaths[0] ?? '—'}
                  </span>
                  <span className="dup-suppress-meta">
                    作用域：{item.scopeMode === 'global' ? '全局' : '当前根'} | 抑制时间：
                    {timeText(item.createdAt)} | 累计命中 {fmtInt(item.hitCount)} 次
                  </span>
                </span>
                <button
                  className="btn btn-sm"
                  type="button"
                  disabled={busy}
                  onClick={() => onRevoke(item.sha256)}
                  aria-label={`撤销抑制项 ${item.fingerprint}`}
                >
                  撤销
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
