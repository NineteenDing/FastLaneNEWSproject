import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { SITE } from "@aihot/site";
import { adminGet } from "../../../apps/web/app/lib/admin.server";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import type { FilterPolicy, PlatformSession, TopicPlan, WritingSkill, TopicColumns, ModelBudgetSettings, ModelConnection, ModelOperations, ModelUsage, HistorySettings, CollectionOperations } from "../contracts";
import { FilterSettings } from "./filter-settings";
import { TopicPlanSettings } from "./topic-plan";
import { WritingSkillSettings } from "./writing-skills";
import { ModelConnectionSettings } from "./model-connection";
import { LanguageSampleSettings } from "./language-samples";
import { StyleLearningSettings } from "./style-learning";
import { HistorySettingsForm } from "./history-settings";
import { CollectionTaskControl } from "./collection-operations";
import { StudioBackupSettings } from "./studio-backup";
import { TrendSettingsPanel } from "./discovery";
import { loadTopicProcessing } from "./topic-processing.server";
import { TopicProcessingSettings } from "./topic-processing";
import { PlatformLogin } from "./platform-login";
import { VisitorDashboard, type VisitorStats } from "./visitor-stats";
import type { AdminFeedback } from "@aihot/contracts/admin";
import type { SiteManagement } from "../site-management-contracts";
import type { FilmBoardsPage } from "../film-boards-contracts";
import type { DailyEditionPage } from "../contracts";
import { SiteManagementSettings } from "./site-management";

const sections = [
  ["models", "模型与费用"], ["collection", "采集任务"], ["platforms", "平台登录"], ["trends", "热榜采集"],
  ["topics", "选题与栏目"], ["filters", "内容筛选"], ["processing", "处理状态"], ["skills", "写作规则"], ["learning", "语言库与学习"], ["site", "站点管理"], ["backup", "备份与存储"], ["visitors", "访问统计"],
] as const;

const names = { xhs: "小红书", douyin: "抖音", kuaishou: "快手", bilibili: "B站", weibo: "微博", tieba: "百度贴吧", zhihu: "知乎" };
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const section = params.section ?? "models";
  if (!sections.some(([id]) => id === section)) throw new Response("设置页面不存在", { status: 404 });
  const [sessions, plan, skills, columns, connection, operations, usage, history, budget, collection, filtering, basicConnection] = await Promise.all([adminGet<{ rows: PlatformSession[] }>(request, "/api/admin/studio/platform-sessions"),
    adminGet<TopicPlan>(request, "/api/admin/studio/topic-plan"), adminGet<{ rows: WritingSkill[] }>(request, "/api/admin/studio/writing-skills"), adminGet<TopicColumns>(request, "/api/admin/studio/columns"),
    adminGet<ModelConnection>(request, "/api/admin/studio/model-connection"), adminGet<ModelOperations>(request, "/api/admin/studio/model-operations"), adminGet<ModelUsage>(request, "/api/admin/studio/model-usage"),
    adminGet<HistorySettings>(request, "/api/admin/studio/history-settings"), adminGet<ModelBudgetSettings>(request, "/api/admin/studio/model-budget"),
    adminGet<CollectionOperations>(request, "/api/admin/studio/collection-operations"), adminGet<{ policy: FilterPolicy }>(request, "/api/admin/studio/filter-settings"), adminGet<ModelConnection>(request, "/api/admin/studio/model-basic-connection")]);
  const processing = section === "processing" ? await loadTopicProcessing(request) : null;
  const query = new URL(request.url).searchParams;
  const visitors = section === "visitors" ? await adminGet<VisitorStats>(request, `/api/admin/studio/visitors?${new URLSearchParams([...query].filter(([key]) => ["from", "to"].includes(key)))}`) : null;
  const site = section === "site" ? await Promise.all([adminGet<SiteManagement>(request, "/api/admin/studio/site-management"), adminGet<FilmBoardsPage>(request, "/api/admin/studio/film-boards"), adminGet<DailyEditionPage>(request, "/api/admin/studio/daily-editions"), adminGet<AdminFeedback>(request, `/api/admin/feedback?${new URLSearchParams({ page: query.get("page") ?? "1", ...(query.get("status") ? { status: query.get("status")! } : {}), q: query.get("q") ?? "" })}`)]) : null;
  return { ...sessions, section, plan, skills: skills.rows, columns: columns.rows, connection, basicConnection, operations, usage, history, budget, collection, processing, filtering, visitors, site: site ? { site: site[0], films: site[1], daily: site[2], feedback: site[3] } : null };
};
export const meta = () => [{ title: `设置 · ${SITE.name}` }, { name: "robots", content: "noindex, nofollow" }];
export const headers = () => ({ "Cache-Control": "no-store" });

function SessionRow({ session }: { session: PlatformSession }) {
  const action = useAdminAction("studio-layout"), [cookie, setCookie] = useState(""), [ready, setReady] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; setReady(true); return () => { mounted.current = false; }; }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    const result = await action.run("PUT", `/api/admin/studio/platform-sessions/${session.platform}`, { version: session.version, cookie }, { success: "登录信息已保存，是否有效以实际采集为准" });
    if (result && mounted.current) setCookie("");
  }
  async function clear() {
    if (!window.confirm(`清除${names[session.platform]}的已保存登录信息？已收录内容仍会保留。`)) return;
    const result = await action.run("PUT", `/api/admin/studio/platform-sessions/${session.platform}`, { version: session.version, cookie: "" }, { success: "已清除登录信息，收录内容保留" });
    if (result && mounted.current) setCookie("");
  }
  const id = `platform-cookie-${session.platform}`;
  return <section className="studio-session-row" aria-label={`${names[session.platform]}登录设置`}>
    <div><h3>{names[session.platform]}</h3>
      <p className="studio-caption">{session.state === "saved" ? "已保存 · 尚未验证" : session.state === "unreadable" ? "信息无法解密，请重新保存" : "尚未保存登录信息"}</p>
      <PlatformLogin session={session} name={names[session.platform]} />
      {!session.adapterAvailable && <p className="studio-caption">可先保存，平台采集仍在接入。</p>}
      {session.updatedAt && <p className="studio-caption">更新于 {new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Hong_Kong", dateStyle: "short", timeStyle: "short" }).format(new Date(session.updatedAt))}</p>}
    </div>
    <form onSubmit={save}><label htmlFor={id}>登录信息（Cookie）</label>
      <input id={id} type="password" autoComplete="off" spellCheck={false} maxLength={16000} value={cookie} onChange={event => setCookie(event.target.value)} disabled={!ready || action.busy}
        placeholder={session.state === "saved" ? "填写新信息以替换，原值不会回显" : "粘贴已登录请求中的 Cookie 值"} />
      <div className="studio-actions"><button className="studio-primary" disabled={!ready || action.busy || !cookie.trim()}>{action.busy ? "正在保存…" : "保存登录信息"}</button>
        {session.state !== "missing" && <button type="button" disabled={!ready || action.busy} onClick={clear}>清除登录信息</button>}</div>
    </form>
  </section>;
}

export default function Settings() {
  const { rows, section, plan, skills, columns, connection, basicConnection, operations, usage, history, budget, collection, processing, filtering, visitors, site } = useLoaderData<typeof loader>();
  return <>
    <header className="studio-page-header"><div><h1>设置</h1><p>{sections.find(([id]) => id === section)?.[1]}</p></div><Link className="studio-button" to="/admin/studio/creators">返回博主关注</Link></header>
    <div className="studio-settings-grid"><nav className="studio-settings-nav" aria-label="设置分类">
      {sections.map(([id, name]) => <Link key={id} to={`/admin/studio/settings/${id}`} aria-current={section === id ? "page" : undefined}>{name}</Link>)}
    </nav><div className="studio-settings-content">
    <div hidden={section !== "models"}><ModelConnectionSettings key={connection.version} connection={connection} basicConnection={basicConnection} operations={operations} usage={usage} budget={budget} /></div>
    <div hidden={section !== "collection"}><CollectionTaskControl operations={collection} /></div>
    <div hidden={section !== "filters"}><FilterSettings initial={filtering.policy} columns={columns} /></div>
    {section === "trends" && <TrendSettingsPanel />}
    {section === "processing" && processing && <TopicProcessingSettings data={processing} />}
    {section === "visitors" && visitors && <VisitorDashboard key={`${visitors.from}:${visitors.to}`} data={visitors} />}
    {section === "site" && site && <SiteManagementSettings data={site} />}
    <div hidden={section !== "topics"}><TopicPlanSettings plan={plan} /><HistorySettingsForm settings={history} />
      <Link className="studio-button" to="/admin/studio/topics/columns">管理栏目和筛选标准</Link></div>
    <div hidden={section !== "backup"}><StudioBackupSettings active={section === "backup"} /></div>
    <div hidden={section !== "skills"}><WritingSkillSettings skills={skills} columns={columns} /></div>
    <div hidden={section !== "learning"}><LanguageSampleSettings columns={columns} active={section === "learning"}><StyleLearningSettings columns={columns} active={section === "learning"} /></LanguageSampleSettings></div>
    <section hidden={section !== "platforms"} className="studio-session-settings" aria-labelledby="platform-session-title">
      <h2 id="platform-session-title">平台登录</h2>
      <p className="studio-notice">点击“登录平台”，在窗口中自行登录，成功后自动加密保存会话并接续已开启的采集。各平台互相隔离，采集关闭时不会擅自打开；也可手动粘贴 Cookie。实际有效性以采集结果为准。</p>
      <details className="studio-session-help"><summary>如何取得登录信息</summary><p>在自己的浏览器登录对应平台，打开开发者工具的“网络”面板，查看平台页面请求中的 Cookie。只复制值，粘贴到对应平台；不要包含“Cookie:”或其他请求头。登录过期后重新保存即可。</p></details>
      {rows.map(session => <SessionRow key={session.platform} session={session} />)}
    </section>
    </div></div>
  </>;
}
