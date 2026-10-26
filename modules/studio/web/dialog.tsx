import { useEffect, useId, useRef, type ReactNode } from "react";

/** Native modal focus containment, Escape and focus restoration also apply to nested readers. */
export function Dialog({ title, onClose, children, wide = false, open = true }: { title: string; onClose(): void; children: ReactNode; wide?: boolean; open?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null), id = useId();
  useEffect(() => { const dialog = ref.current!; if (open) dialog.showModal(); return () => dialog.close(); }, [open]);
  return <dialog ref={ref} aria-labelledby={id} className={`studio-content-dialog${wide ? " studio-content-dialog-wide" : ""}`} onCancel={onClose}>
    <header className="studio-dialog-header"><h2 id={id}>{title}</h2><button type="button" onClick={onClose} autoFocus>关闭</button></header>
    <div className="studio-dialog-body">{children}</div>
  </dialog>;
}
