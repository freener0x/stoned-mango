// A modal dialog on the native <dialog> element (focus trapping and Escape for free).

import { useEffect, useRef, type ReactNode } from 'react';

interface Props {
  open: boolean;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  onClose(): void;
  /** Escape and the close button do nothing (while something must finish). */
  busy?: boolean;
}

export function Dialog({ open, title, children, actions, onClose, busy }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="dialog" aria-label={title}
      onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}>
      <div className="dialog-head">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="Close" onClick={onClose} disabled={busy}>×</button>
      </div>
      <div className="dialog-body">{children}</div>
      {actions && <div className="dialog-actions">{actions}</div>}
    </dialog>
  );
}
