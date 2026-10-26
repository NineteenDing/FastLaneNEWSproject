import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useRevalidator, useLoaderData, type LoaderFunctionArgs, type MetaFunction } from "react-router";
import { SITE } from "@aihot/site";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import { toast } from "../../../apps/web/app/features/admin/toast";
import { adminGet } from "../../../apps/web/app/lib/admin.server";
import type { NewsSourceSettings } from "../contracts";

export async function loader({ request, params }: LoaderFunctionArgs) {
  return { settings: params.id ? await adminGet<NewsSourceSettings>(request,
    `/api/admin/studio/news-sources/${encodeURIComponent(params.id)}/configuration`) : null };
}
export const meta: MetaFunction<typeof loader> = ({ loaderData }) => [{ title: `${loaderData?.settings ? "采集设置" : "添加新闻源"} · ${SITE.name}` }, { name: "robots", content: "noindex, nofollow" }];
export const headers = () => ({ "Cache-Control": "no-store" });

export default function NewsSourcePage() {
  const { settings } = useLoaderData<typeof loader>();
  return <NewsSourceEditor key={settings ? `${settings.id}:${settings.version}` : "new"} settings={settings} />;
}

export function NewsSourceEditor({ settings, onSaved }: { settings: NewsSourceSettings | null; onSaved?: () => void }) {
  const action = useAdminAction("studio-layout");
  const navigate = useNavigate(), revalidator = useRevalidator();
  const mounted = useRef(true);
  const [kind, setKind] = useState(settings?.kind ?? "rss");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(String(data.get("config") || "{}"));
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error();
    } catch { setError("高级提取规则须为有效的 JSON 对象；不需要时填写 {}。"); return; }
    setError(null);
    const result = await action.run<{ created: boolean; id: string; archived: boolean }>(settings ? "PUT" : "POST",
      settings ? `/api/admin/studio/news-sources/${encodeURIComponent(settings.id)}/configuration` : "/api/admin/studio/news-sources", {
      name: String(data.get("name") ?? ""), kind, url: String(data.get("url") ?? ""),
      intervalMinutes: Number(data.get("interval")), config, ...(settings ? { version: settings.version } : {}),
    }, { revalidate: false });
    if (!result || !mounted.current) return;
    toast(settings ? "采集设置已保存，当前暂停" : result.created ? "新闻源已保存，当前暂停" : "已存在相同来源，已定位原记录", "ok");
    if (onSaved) { void revalidator.revalidate(); onSaved(); return; }
    navigate(`/admin/studio/following?${new URLSearchParams({ q: result.id, archived: String(result.archived) })}`);
  }
  return <>
    <header className="studio-page-header"><div><h1>{settings ? "采集设置" : "添加新闻源"}</h1><p>填写订阅地址或网页，先试读，再决定是否启用采集。</p></div>
      <Link className="studio-button" to="/admin/studio/following">返回关注管理</Link></header>
    <section className="studio-editor" aria-label="新闻源信息">
      <p className="studio-caption">{settings ? "保存时重新试读并暂停采集，现有资料和材料保留。其他窗口已更新时会提示冲突，保留你的输入。"
        : "试读不收录材料。保存后先暂停；暂时无法访问也会保留来源，显示实际试读状态。重复地址会定位到原记录。"}</p>
      <form onSubmit={save}>
        <label className="studio-wide">来源名称<input name="name" required maxLength={200} autoFocus defaultValue={settings?.name ?? ""} disabled={action.busy} /></label>
        <label>来源类型<select value={kind} onChange={event => setKind(event.target.value as "rss" | "web_list")} disabled={action.busy}>
          <option value="rss">RSS / RSSHub</option><option value="web_list">网页新闻源</option></select></label>
        <label>采集间隔（分钟）<input name="interval" type="number" required min={1} max={1440} defaultValue={settings?.intervalMinutes ?? 30} disabled={action.busy} /></label>
        <label className="studio-wide">采集地址<input name="url" type="url" required maxLength={2000} defaultValue={settings?.url ?? ""} placeholder="https://example.com/feed.xml" disabled={action.busy} /></label>
        {kind === "web_list" && <p className="studio-caption studio-wide">网页需要适用的提取规则；没有规则时显示“需配置”，不会把导航链接当作新闻。</p>}
        <section className="studio-wide"><h3>高级提取规则（JSON，可选）</h3>
          <label>提取规则<textarea name="config" rows={7} defaultValue={JSON.stringify(settings?.config ?? {}, null, 2)} spellCheck={false} disabled={action.busy}
            placeholder={'{"itemSelector":"article","linkSelector":"a","titleSelector":"h2"}'} /></label>
        </section>
        {error && <p className="studio-wide" role="alert">{error}</p>}
        <div className="studio-wide studio-actions"><button className="studio-primary" disabled={action.busy}>
          {action.busy ? "正在验证并保存…" : "验证并保存"}</button></div>
      </form>
    </section>
  </>;
}
