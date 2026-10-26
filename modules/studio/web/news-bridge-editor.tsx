import { useEffect, useRef, type FormEvent } from "react";
import { Link, useLoaderData, useNavigate, useRevalidator, type LoaderFunctionArgs, type MetaFunction } from "react-router";
import { SITE } from "@aihot/site";
import { adminGet } from "../../../apps/web/app/lib/admin.server";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import { toast } from "../../../apps/web/app/features/admin/toast";
import type { NewsBridgeSettings } from "../contracts";

export async function loader({ request, params }: LoaderFunctionArgs) {
  return adminGet<NewsBridgeSettings>(request, `/api/admin/studio/news-sources/${encodeURIComponent(params.id!)}/bridge`);
}
export const meta: MetaFunction = () => [{ title: `桥接设置 · ${SITE.name}` }, { name: "robots", content: "noindex, nofollow" }];
export const headers = () => ({ "Cache-Control": "no-store" });
export default function BridgePage() {
  const settings = useLoaderData<typeof loader>();
  return <BridgeEditor key={`${settings.id}:${settings.version}`} settings={settings} />;
}

export function BridgeEditor({ settings, onSaved }: { settings: NewsBridgeSettings; onSaved?: () => void }) {
  const action = useAdminAction("studio-layout");
  const navigate = useNavigate(), revalidator = useRevalidator();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const result = await action.run("PUT", `/api/admin/studio/news-sources/${encodeURIComponent(settings.id)}/bridge`, {
      version: settings.version, name: String(data.get("name") ?? ""), route: String(data.get("route") ?? ""),
      itemLimit: Number(data.get("limit")), aiFilter: data.get("aiFilter") === "true",
    }, { revalidate: false });
    if (!result || !mounted.current) return;
    toast("桥接参数已保存，当前暂停", "ok");
    if (onSaved) { void revalidator.revalidate(); onSaved(); return; }
    navigate(`/admin/studio/following?${new URLSearchParams({ q: settings.id })}`);
  }
  return <>
    <header className="studio-page-header"><div><h1>桥接设置</h1><p>管理这个来源的 RSSHub 接入参数。</p></div>
      <Link className="studio-button" to="/admin/studio/following">返回关注管理</Link></header>
    <section className="studio-editor" aria-label="RSSHub 桥接信息">
      <h2>{settings.name}</h2>
      <p className="studio-notice">{settings.runtimeState === "configured" ? "RSSHub 地址已配置，连接状态待验证" : settings.runtimeState === "invalid" ? "RSSHub 地址配置无效" : "RSSHub 运行服务尚未配置"}</p>
      <p className="studio-caption">保存后先暂停来源。配置本机 RSSHub、启用来源并运行采集后台后，系统会按间隔读取；已有材料和资料保留。</p>
      <form onSubmit={save}>
        <label className="studio-wide">来源名称<input name="name" required maxLength={200} autoFocus defaultValue={settings.name} disabled={action.busy} /></label>
        <label className="studio-wide">RSSHub 路由<input name="route" required maxLength={1000} defaultValue={settings.route ?? ""} placeholder="/qwen/blog" disabled={action.busy} aria-describedby="bridge-route-hint" /></label>
        <p id="bridge-route-hint" className="studio-caption studio-wide">只填以 / 开头的路由，不填服务器地址、查询参数或密钥。{settings.origin === "legacy" ? "已带入原系统路由，可按需修改。" : settings.origin === "missing" ? "该来源没有原路由，请手动填写。" : "这里显示你保存的路由。"}</p>
        <label>每次处理上限<input name="limit" type="number" required min={1} max={50} defaultValue={settings.itemLimit} disabled={action.busy} /></label>
        <label>AI 关键词预筛<select name="aiFilter" defaultValue={String(settings.aiFilter)} disabled={action.busy}>
          <option value="true">启用</option><option value="false">关闭</option></select></label>
        <p className="studio-caption studio-wide">只读取当前订阅窗口，处理上限不代表完整覆盖；关键词预筛不代替选题判断，排除项另有记录。</p>
        <div className="studio-actions studio-wide"><button className="studio-primary" disabled={action.busy}>{action.busy ? "正在保存…" : "保存并暂停"}</button></div>
      </form>
    </section>
  </>;
}
