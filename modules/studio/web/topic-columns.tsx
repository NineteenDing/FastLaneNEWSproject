import { PanelDialog } from "./panel-dialog";
import { RemotePanel } from "./remote-panel";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { SITE } from "@aihot/site";
import { adminGet } from "../../../apps/web/app/lib/admin.server";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import type { TopicColumn, TopicColumns } from "../contracts";
import { TopicTabs } from "./topic-tabs";
import { TopicRuleText } from "./topic-rule-text";

export async function loader({ request, params }: LoaderFunctionArgs) {
  if (params.id && params.version) return { view: "history" as const,
    ...await adminGet<{ audience: string; column: TopicColumn }>(request, `/api/admin/studio/columns/${encodeURIComponent(params.id)}/versions/${encodeURIComponent(params.version)}`) };
  return { view: "columns" as const, ...await adminGet<TopicColumns>(request, "/api/admin/studio/columns") };
}
export const meta = () => [{ title: `选题栏目 · ${SITE.name}` }, { name: "robots", content: "noindex, nofollow" }];
export const headers = () => ({ "Cache-Control": "no-store" });

function ColumnEditor({ column, order, close }: { column?: TopicColumn; order: number; close: () => void }) {
  const action = useAdminAction("studio-layout"), field = useRef<HTMLInputElement>(null), mounted = useRef(true);
  const [failed, setFailed] = useState(false);
  useEffect(() => { mounted.current = true; field.current?.focus(); return () => { mounted.current = false; }; }, []);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    const result = await action.run(column ? "PATCH" : "POST", column ? `/api/admin/studio/columns/${column.id}` : "/api/admin/studio/columns", {
      ...(column ? { version: column.version } : {}),
      ...Object.fromEntries(["name", "questions", "videoForms", "requirements", "exclusions"].map(key => [key, String(data.get(key) ?? "")])),
      sortOrder: Number(data.get("sortOrder")), enabled: column?.isFallback ? true : data.get("enabled") === "on",
    }, { success: "栏目规则已保存，历史版本保留" });
    if (mounted.current) { if (result) close(); else setFailed(true); }
  }
  return <section className="studio-editor" aria-label={column ? `编辑栏目：${column.name}` : "添加栏目"}>
    <h2>{column ? `编辑规则 · ${column.name}` : "添加栏目"}</h2>
    <p className="studio-caption">至少写清优先关注的问题和希望形成的视频。保存为新版本，后续批次使用新规则。</p>
    <form onSubmit={save}>
      <label className="studio-wide">栏目名称<input ref={field} name="name" required maxLength={80} defaultValue={column?.name ?? ""} readOnly={column?.isFallback} /></label>
      <label className="studio-wide">优先关注的问题<textarea name="questions" required maxLength={3000} rows={3} defaultValue={column?.questions ?? ""} placeholder="例如：多人对白时，怎样保持人物声音与口型一致？" /></label>
      <label className="studio-wide">希望形成的视频<textarea name="videoForms" required maxLength={2000} rows={2} defaultValue={column?.videoForms ?? ""} placeholder="例如：操作演示、制作前后对比" /></label>
      <label className="studio-wide">入选必须满足<textarea name="requirements" maxLength={5000} rows={3} defaultValue={column?.requirements ?? "面向AI视频、漫剧、影视创作者；核心事实有来源，说明观看收益、适用条件和限制。"} /></label>
      <label className="studio-wide">通常排除的内容<textarea name="exclusions" maxLength={3000} rows={2} defaultValue={column?.exclusions ?? ""} /></label>
      <label>排序数字（较小的靠前）<input name="sortOrder" type="number" required min={0} max={10000} step={1} defaultValue={column?.sortOrder ?? order} readOnly={column?.isFallback} /></label>
      <label className="studio-column-checkbox"><input name="enabled" type="checkbox" defaultChecked={column?.enabled ?? true} disabled={column?.isFallback} />启用栏目</label>
      {column?.isFallback && <p className="studio-wide studio-caption">“其他”是固定兜底栏目，保持启用并显示在最后。</p>}
      {failed && <p className="studio-wide studio-caption" role="alert">规则尚未保存，请查看错误提示；你的输入仍保留在这里。</p>}
      <div className="studio-wide studio-actions"><button className="studio-primary" disabled={action.busy}>{action.busy ? "正在保存…" : "保存栏目"}</button>
        <button type="button" onClick={close} disabled={action.busy}>取消</button></div>
    </form>
  </section>;
}


function ColumnVersions({ column }: { column: TopicColumn }) {
  const [version, setVersion] = useState(column.version);
  return <section><label>选择规则版本<input aria-label="规则历史版本" type="number" min={1} max={column.version} value={version} onChange={event => { const value=event.target.valueAsNumber; if(Number.isInteger(value)&&value>=1&&value<=column.version)setVersion(value); }} /></label>
    <div className="studio-actions"><button disabled={version<=1} onClick={()=>setVersion(v=>v-1)}>上一版</button><span>版本 {version} / {column.version}</span><button disabled={version>=column.version} onClick={()=>setVersion(v=>v+1)}>下一版</button></div>
    <RemotePanel<{audience:string;column:TopicColumn}> key={version} url={`/api/admin/studio/columns/${column.id}/versions/${version}`}>{data=><section><h3>{data.column.name} · 版本 {data.column.version}</h3><TopicRuleText column={data.column} /></section>}</RemotePanel>
  </section>;
}

export default function TopicColumnPage() {
  const data = useLoaderData<typeof loader>(), [editor, setEditor] = useState<TopicColumn | "new" | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  function close() { setEditor(null); trigger.current?.focus(); }
  function edit(column: TopicColumn | "new", button: HTMLButtonElement) { trigger.current = button; setEditor(column); }
  if (data.view === "history") return <>
    <header className="studio-page-header"><div><h1>栏目规则历史</h1><p>{data.column.name} · 版本 {data.column.version}</p></div><Link className="studio-button" to="/admin/studio/topics/columns">返回栏目</Link></header>
    <p className="studio-notice">固定受众：{data.audience}。这是保存时的规则版本，后续改名或停用不会改写它。</p>
    <article className="studio-evidence"><h2>{data.column.name}</h2><p className="studio-caption">当时状态：{data.column.enabled ? "已启用" : "已停用"} · 每期最多 {data.column.maxDirections} 个方向</p><TopicRuleText column={data.column} />
      {data.column.version > 1 && <Link to={`/admin/studio/topics/columns/${data.column.id}/versions/${data.column.version - 1}`}>查看上一版</Link>}</article>
  </>;
  const order = Math.min(10000, Math.max(0, ...data.rows.filter(column => !column.isFallback).map(column => column.sortOrder)) + 10);
  return <>
    <header className="studio-page-header"><div><h1>选题台</h1><p>围绕创作者的实际制作问题，制定每个栏目的筛选标准。</p></div><button className="studio-primary" onClick={event => edit("new", event.currentTarget)}>添加栏目</button></header>
    <TopicTabs view="columns" />
    <p className="studio-notice">固定受众：{data.audience}。规则默认用于后续两日批次；当前批次需要应用新规则时，可在批次详情建立独立版本，旧选题与稿件保留。</p>
    {editor && <PanelDialog title={editor === "new" ? "新增栏目" : editor.name} onClose={close} panels={[{id:"rules",label:"完整筛选标准",content: editor === "new" ? <p>保存栏目后显示完整标准。</p> : <TopicRuleText column={editor} />},{id:"edit",label:"编辑规则",content:<ColumnEditor column={editor === "new" ? undefined : editor} order={order} close={close} />}, {id:"versions",label:"规则版本",content: editor === "new" ? <p>尚无历史版本。</p> : <ColumnVersions column={editor} />}]} initial={editor === "new" ? "edit" : "rules"} />}
    <div className="studio-column-grid">{data.rows.map(column => <article className="studio-column" key={column.id} data-fallback={column.isFallback || undefined} aria-label={`栏目：${column.name}`}>
      <header><h2>{column.name}</h2><span className="studio-caption">{column.enabled ? "已启用" : "已停用"} · 版本 {column.version}</span></header>
      <p className="studio-column-summary">{column.questions}</p><p className="studio-caption">视频形式：{column.videoForms}</p>
      <p className="studio-caption">每期最多 {column.maxDirections} 个方向，不足时不凑数。</p>

      <footer className="studio-actions"><button onClick={event => edit(column, event.currentTarget)}>查看规则</button></footer>
    </article>)}</div>
  </>;
}

export function ErrorBoundary() {
  return <section className="studio-empty" role="alert"><h1>栏目未能加载</h1><p>请检查登录或网络后重试，已有规则与历史版本不会因此删除。</p>
    <div className="studio-actions"><button onClick={() => window.location.reload()}>重新加载</button><Link to="/admin/studio/topics/columns">返回栏目</Link></div></section>;
}
