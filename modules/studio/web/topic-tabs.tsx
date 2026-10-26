import { Link } from "react-router";

export function TopicTabs({ view }: { view: "current" | "history" | "columns" }) {
  return <nav className="studio-tabs" aria-label="选题视图">
    <Link to="/admin/studio/topics" aria-current={view === "current" ? "page" : undefined}>当期</Link>
    <Link to="/admin/studio/topics?view=history" aria-current={view === "history" ? "page" : undefined}>历史</Link>
    <Link to="/admin/studio/topics/columns" aria-current={view === "columns" ? "page" : undefined}>栏目规则</Link>
  </nav>;
}
