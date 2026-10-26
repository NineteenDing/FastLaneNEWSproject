import { useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog } from "./dialog";

/** Keep each form mounted while changing sections, so unsaved inputs are retained. */
export function PanelDialog({ title, onClose, panels, initial }: {
  title: string; onClose(): void; panels: Array<{ id: string; label: string; content: ReactNode }>; initial?: string;
}) {
  const [chosen, choose] = useState(initial ?? panels[0]?.id);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const unfold = () => root.current?.querySelectorAll("details:not([open])").forEach(item => { (item as HTMLDetailsElement).open = true; });
    unfold(); const observer = new MutationObserver(unfold);
    if (root.current) observer.observe(root.current, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  const active = panels.some(panel => panel.id === chosen) ? chosen : panels[0]?.id;
  return <Dialog title={title} onClose={onClose} wide>
    <div className="studio-panel-dialog" ref={root} onClickCapture={event => { const target = event.target as HTMLElement; if (target.closest("summary") && !target.closest("a,button,input,select,textarea")) event.preventDefault(); }}>
      <nav aria-label={`${title}分类`} className="studio-panel-nav">{panels.map(panel => <button key={panel.id} type="button"
        aria-current={active === panel.id ? "page" : undefined} onClick={() => choose(panel.id)}>{panel.label}</button>)}</nav>
      <div className="studio-panel-contents">{panels.map(panel => <section key={panel.id} hidden={active !== panel.id}
        aria-label={panel.label} className="studio-panel-section">{panel.content}</section>)}</div>
    </div>
  </Dialog>;
}
