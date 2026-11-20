import { useEffect, useId, useRef, type ReactNode } from 'react';

interface Props {
  title: string;
  confirmLabel?: string;
  cancelLabel?: string;
  children: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * 确认层。
 *
 * 破坏性或恢复类动作一律先过这里，把「会发生什么」写在确认按钮之前，
 * 避免用户凭按钮颜色猜后果。
 */
export function ConfirmDialog({
  title,
  confirmLabel = '确认',
  cancelLabel = '取消',
  children,
  onCancel,
  onConfirm,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="confirm-dialog"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id={titleId}>{title}</h2>
      <div id={bodyId} className="confirm-body">
        {children}
      </div>
      <div className="action-bar-group">
        <button type="button" className="btn" autoFocus onClick={onCancel}>
          {cancelLabel}
        </button>
        <button type="button" className="btn btn-primary" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
