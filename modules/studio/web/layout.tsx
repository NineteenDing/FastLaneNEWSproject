import { Link, Outlet, useLoaderData, useLocation, useNavigation, type LoaderFunctionArgs } from "react-router";
import type { AdminMe } from "@aihot/contracts/admin";
import { SITE } from "@aihot/site";
import { Wordmark } from "@aihot/site/brand/Logo.tsx";
import { ThemeSwitch } from "../../../apps/web/app/components/shell/ThemeSwitch";
import { adminGet } from "../../../apps/web/app/lib/admin.server";
import { Toaster } from "../../../apps/web/app/features/admin/toast";
import "./studio.css";

export async function loader({ request }: LoaderFunctionArgs) {
  const [me, examples] = await Promise.all([adminGet<AdminMe>(request, "/api/admin/me"), adminGet<{ active: boolean }>(request, "/api/admin/studio/acceptance-examples")]);
  return { me, examples };
}
export const shouldRevalidate = () => true;
export const headers = () => ({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });

export default function StudioLayout() {
  const { me, examples } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const pathname = useLocation().pathname, settings = pathname.startsWith("/admin/studio/settings");
  const intelligence = pathname.startsWith("/admin/studio/intelligence");
  const topics = pathname.startsWith("/admin/studio/topics");
  const writing = pathname.startsWith("/admin/studio/writing");
  return <div className="studio">
    <a className="studio-skip" href="#studio-main">跳到正文</a>
    <aside className="studio-sidebar fl-rail">
      <Link to="/" className="studio-brand" aria-label={`${SITE.name} 首页`}><Wordmark size={24} /></Link>
      <p className="studio-caption">情报 · 选题 · 口播</p>
      <nav aria-label="工作台导航">
        <span className="studio-nav-label">信息收集</span>
        <Link to="/admin/studio/following" aria-current={settings || intelligence || topics || writing ? undefined : "page"}>关注管理</Link>
        <Link to="/admin/studio/intelligence" aria-current={intelligence ? "page" : undefined}>情报库</Link>
        <span className="studio-nav-label">内容创作</span>
        <Link to="/admin/studio/topics" aria-current={topics ? "page" : undefined}>选题台</Link>
        <Link to="/admin/studio/writing" aria-current={writing ? "page" : undefined}>写稿台</Link>
        <span className="studio-nav-label">系统管理</span>
        <Link to="/admin/studio/settings/visitors" aria-current={pathname.endsWith("/visitors") ? "page" : undefined}>访问统计</Link>
        <Link to="/admin/studio/settings" aria-current={settings && !pathname.endsWith("/visitors") ? "page" : undefined}>设置</Link>
      </nav>
      <div className="studio-appearance"><ThemeSwitch /></div>
      <div className="studio-account"><span>{me.name}</span>
        <form method="post" action="/api/auth/logout"><button type="submit">退出登录</button></form>
      </div>
    </aside>
    <main id="studio-main" className={`studio-main${examples.active ? " studio-has-examples" : ""}`} aria-busy={navigation.state !== "idle"}>
      {examples.active && <div className="studio-example-banner" role="note"><span>验收示例已载入 · [示例]内容为虚构，未进行真实采集或模型审核；示例稿可编辑。</span></div>}
      <Outlet />
    </main>
    <Toaster />
  </div>;
}
