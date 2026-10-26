import { Link } from "react-router";

export function FollowingTabs({ active }: { active: "news" | "creators" | "trends" }) {
  return <nav className="studio-tabs" aria-label="关注类型">
    <Link to="/admin/studio/following" aria-current={active === "news" ? "page" : undefined}>新闻源</Link>
    <Link to="/admin/studio/creators" aria-current={active === "creators" ? "page" : undefined}>博主</Link>
    <Link to="/admin/studio/trends" aria-current={active === "trends" ? "page" : undefined}>热榜</Link>
  </nav>;
}
