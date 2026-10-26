import { useEffect, useRef, useState } from "react";
import { Link, useLoaderData, useRevalidator, useRouteLoaderData, useRouteError, useNavigate, type LoaderFunctionArgs } from "react-router";
import { SITE } from "@aihot/site";
import type { AdminMe } from "@aihot/contracts/admin";
import { adminGet } from "../../../apps/web/app/lib/admin.server";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import type { TopicBatchPage, WritingProject, WritingProjectPage, WritingGeneration, WritingContent, WritingVersion, WritingImage, TopicColumns, TopicPresentation } from "../contracts";
import { WritingEditor } from "./writing-editor";
import { LanguageSampleEntries } from "./language-samples";
import { HistoryChanges } from "./topic-history";
import { externalUrl } from "./external-url";
import { WritingRevisions, WritingSkillEvidence } from "./writing-revisions";
import { CreatorExpressionEvidence } from "./creator-expressions";
import { ReferenceAnalysisEvidence } from "./reference-analysis-evidence";
import { WritingBrief, WritingReferences } from "./writing-references";
import { SavedWritingVersion, WritingLibrary } from "./writing-library";
import { Dialog } from "./dialog";

type Versions = { rows: Omit<WritingVersion, "content" | "instructions">[]; total: number; page: number; hasMore: boolean };
type LocalValue = Pick<WritingProject, "title" | "instructions" | "content" | "titleOptions">;
type RecoveryCopy = { key: string; value: LocalValue; baseVersion: number; storedAt?: string };
const fields: Record<keyof WritingContent, string> = { spoken: "纯口播", production: "制作方案", notes: "素材与备注" };
const date = (value: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Hong_Kong", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const localValue = (project: WritingProject): LocalValue => ({ title: project.title, titleOptions: project.titleOptions ?? [], instructions: project.instructions, content: project.content });
const same = (first: LocalValue, second: LocalValue) => JSON.stringify(first) === JSON.stringify(second);
export async function loader({ request, params }: LoaderFunctionArgs) {
  if (params.id) {
    const endpoint = `/api/admin/studio/drafts/${encodeURIComponent(params.id)}`;
    const historyQuery = new URLSearchParams({ page: new URL(request.url).searchParams.get("historyPage") ?? "1" });
    const [project, generation, versions, images] = await Promise.all([adminGet<WritingProject>(request, endpoint), adminGet<WritingGeneration>(request, endpoint + "/generation"), adminGet<Versions>(request, endpoint + `/versions?${historyQuery}`), adminGet<{ rows: WritingImage[] }>(request, endpoint + "/images")]);
    const selectedVersion = new URL(request.url).searchParams.get("version");
    if (selectedVersion) return { view: "saved" as const, project, version: await adminGet<WritingVersion>(request, `${endpoint}/versions/${encodeURIComponent(selectedVersion)}`) };
    const siblings = await adminGet<WritingProjectPage>(request, `/api/admin/studio/drafts?${new URLSearchParams({ periodStart: project.snapshot.batch.startsAt, page: new URL(request.url).searchParams.get("draftPage") ?? "1" })}`);
    return { view: "editor" as const, project, generation, versions, images: images.rows, siblings };
  }
  const search = new URL(request.url).searchParams, page = search.get("page") ?? "1", q = search.get("q")?.trim().slice(0,200) ?? "";
  const mode = search.get("view") === "history" || search.get("batchId") ? "history" as const : "current" as const;
  const state = search.get("state") === "draft" ? "draft" as const : search.get("state") === "final" ? "final" as const : "all" as const;
  const columnId = search.get("columnId") ?? "";
  const [columns, presentation, batches] = await Promise.all([adminGet<TopicColumns>(request, "/api/admin/studio/columns"), mode === "current" ? adminGet<TopicPresentation>(request, "/api/admin/studio/topic-batches/presentation") : null, mode === "history" ? adminGet<TopicBatchPage>(request, "/api/admin/studio/topic-batches?limit=30") : null]);
  const batchId = q || search.get("allBatches") === "true" ? null : search.get("batchId") || batches?.rows.find(batch => batch.draftCount > 0)?.id || null;
  const periodStart = !q && presentation ? (presentation.batch ?? presentation.collection).startsAt : null;
  const query = new URLSearchParams({ page, state: q ? "all" : state, ...(q ? {q} : batchId ? {batchId} : {}), ...(columnId ? {columnId} : {}), ...(periodStart ? {periodStart} : {}) });
  return { view: "list" as const, batchId, mode, state, columnId, q, batches, columns: columns.rows, list: await adminGet<WritingProjectPage>(request, "/api/admin/studio/drafts?" + query) };
}
export const meta = () => [{ title: `写稿台 · ${SITE.name}` }, { name: "robots", content: "noindex, nofollow" }];
export const headers = () => ({ "Cache-Control": "no-store" });

function DraftEditor({ project, generation, versions, images, siblings }: { project: WritingProject; generation: WritingGeneration; versions: Versions; images: WritingImage[]; siblings: WritingProjectPage }) {
  const endpoint = `/api/admin/studio/drafts/${project.id}`, key = `fastlanenews:writing:${project.id}`;
  const { me } = useRouteLoaderData("studio-layout") as { me: AdminMe };
  const action = useAdminAction("studio-layout"), revalidator = useRevalidator(), navigate = useNavigate();
  const [value, setValue] = useState<LocalValue>(() => localValue(project)), [baseVersion, setBaseVersion] = useState(project.version);
  const [field, setField] = useState<keyof WritingContent>("spoken"), [markdown, setMarkdown] = useState(false);
  const [tool, setTool] = useState<"revision" | "generation" | "evidence" | "history" | "export" | null>(null);
  const revisionSelection = useRef<{ field: keyof WritingContent; text: string; selection: { start: number; end: number; text: string } | null } | null>(null);
  const [editing, setEditing] = useState(false), saving = useRef<Promise<number | null> | null>(null);
  const [status, setStatus] = useState("已保存"), [blocked, setBlocked] = useState(false), [ready, setReady] = useState(false);
  const [recoveries, setRecoveries] = useState<RecoveryCopy[]>([]), [preview, setPreview] = useState<WritingVersion | null>(null);
  const recovery = recoveries[0] ?? null, ownRecoveryKey = useRef<string | null>(null);
  const [imageStatus, setImageStatus] = useState(""), [uploading, setUploading] = useState(false), uploadPending = useRef(false);
  const [exporting, setExporting] = useState(false), [exportStatus, setExportStatus] = useState(""), exportPending = useRef(false);
  const [copyingDraft, setCopyingDraft] = useState(false), [copiedDraft, setCopiedDraft] = useState<{ id: string; version: number } | null>(null);
  const copyingPending = useRef(false), copyRequest = useRef<{ requestId: string; version: number } | null>(null);
  const latest = useRef(value), saved = useRef(value), version = useRef(project.version), pending = useRef(false), mounted = useRef(true), editor = useRef<HTMLDivElement>(null);
  latest.current = value;
  const dirty = !same(value, saved.current), running = ["queued", "running"].includes(generation.state);
  useEffect(() => {
    mounted.current = true;
    ownRecoveryKey.current = `${key}:${crypto.randomUUID()}`;
    try {
      const copies: RecoveryCopy[] = [];
      for (const storedKey of Object.keys(localStorage).filter(candidate => candidate === key || candidate.startsWith(key + ":"))) {
        try {
          const item = JSON.parse(localStorage.getItem(storedKey) ?? "null");
          if (item?.value && typeof item.value.title === "string" && typeof item.value.instructions === "string" && Object.keys(fields).every(name => typeof item.value.content?.[name] === "string") && Number.isInteger(item.baseVersion)
            && !same(item.value, saved.current)) copies.push({ ...item, value: { ...item.value, titleOptions: item.value.titleOptions ?? project.titleOptions ?? [] }, key: storedKey });
        } catch { /* One malformed copy must not hide other windows' recoverable text. */ }
      }
      setRecoveries(copies.sort((a, b) => (b.storedAt ?? "").localeCompare(a.storedAt ?? "")));
    } catch { setStatus("浏览器恢复副本不可用，请保持页面打开并手动保存"); }
    setReady(true); return () => { mounted.current = false; };
  }, [key]);
  useEffect(() => {
    if (!ready || !ownRecoveryKey.current) return;
    try { if (dirty) localStorage.setItem(ownRecoveryKey.current, JSON.stringify({ value, baseVersion, storedAt: new Date().toISOString() })); else localStorage.removeItem(ownRecoveryKey.current); }
    catch { setStatus("本机恢复副本未能保存，请立即手动保存服务器版本"); }
  }, [value, baseVersion, ready, dirty, key]);
  useEffect(() => {
    if (project.version === version.current) return;
    if (!same(latest.current, saved.current)) { setBlocked(true); setStatus("服务器已有新版本，本地编辑已保留，请对比后处理冲突"); return; }
    const current = localValue(project); saved.current = current; version.current = project.version;
    setBaseVersion(project.version); setValue(current); setStatus("已同步服务器新版本");
  }, [project]);
  useEffect(() => {
    if (!dirty) return;
    const before = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", before); return () => window.removeEventListener("beforeunload", before);
  }, [dirty]);
  async function save(mode: "manual" | "auto"): Promise<number | null> {
    while (saving.current) if (await saving.current === null) return null;
    const request = saveOnce(mode); saving.current = request;
    try { return await request; } finally { if (saving.current === request) saving.current = null; }
  }
  async function saveOnce(mode: "manual" | "auto"): Promise<number | null> {
    if (pending.current || blocked || recovery) return null;
    if (same(latest.current, saved.current)) return version.current;
    const submitted = latest.current; pending.current = true; setStatus("正在保存…");
    try {
      const response = await fetch(endpoint, { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": me.csrf },
        body: JSON.stringify({ ...submitted, version: version.current, mode }) });
      const result = await response.json();
      if (!response.ok) { if (mounted.current) { setBlocked(true); setStatus(result.detail ?? "保存失败，本地内容保留；请检查网络后重试"); } return null; }
      if (!mounted.current) return null;
      saved.current = submitted; version.current = result.version; setBaseVersion(result.version);
      setStatus(same(latest.current, submitted) ? `已保存 · ${date(result.updatedAt)}` : "新修改待保存");
      return result.version;
    } catch { if (mounted.current) { setBlocked(true); setStatus("网络异常，服务器保存未确认，本地内容保留"); } return null; }
    finally { pending.current = false; }
  }
  useEffect(() => {
    if (!dirty || blocked || recovery || !ready) return;
    const timer = window.setTimeout(() => { void save("auto"); }, 2000); return () => window.clearTimeout(timer);
  }, [value, blocked, recovery, ready, baseVersion]);
  useEffect(() => {
    if (!ready || blocked || recovery) return;
    const timer = window.setInterval(() => { void save("auto"); }, 30_000); return () => window.clearInterval(timer);
  }, [ready, blocked, recovery]);
  function leaveEditor() { if (!uploadPending.current) { setEditing(false); setMarkdown(false); void save("auto"); } }
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") revalidator.revalidate(); }, 5000);
    return () => window.clearInterval(timer);
  }, [running, revalidator]);
  async function generate() {
    const current = await save("manual"); if (current === null || !same(latest.current, saved.current)) return;
    await action.run("POST", endpoint + "/generation", { version: current, retryFailed: true });
  }
  async function finalize() {
    const current = await save("manual"); if (current === null || !same(latest.current, saved.current)) return;
    await action.run("POST", endpoint + "/finalize", { version: current }, { success: "定稿已保存，后续修改保留本次快照" });
  }
  async function duplicate() {
    if (copyingPending.current) return;
    copyingPending.current = true; setCopyingDraft(true);
    try {
      const current = await save("manual");
      if (current === null || !mounted.current || !same(latest.current, saved.current)) return;
      if (copyRequest.current?.version !== current) copyRequest.current = { requestId: crypto.randomUUID(), version: current };
      const result = await action.run<{ id: string }>("POST", endpoint + "/copy", copyRequest.current,
        { revalidate: false, success: "已创建独立草稿，原稿保持保存状态" });
      if (result && mounted.current) { setCopiedDraft({ id: result.id, version: current }); copyRequest.current = null; }
    } finally { copyingPending.current = false; if (mounted.current) setCopyingDraft(false); }
  }
  async function selectVersion(selected: number) {
    try { const response = await fetch(endpoint + `/versions/${selected}`, { cache: "no-store" }); if (!response.ok) throw new Error(); setPreview(await response.json()); setTool("history"); }
    catch { setStatus("历史版本未能加载，请重试"); }
  }
  async function copy() {
    const element = editor.current?.querySelector<HTMLElement>(".tiptap"), text = markdown ? value.content[field] : element?.innerText ?? value.content[field];
    try {
      if (!markdown && element && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write)
        await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([element.innerHTML], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })]);
      else await navigator.clipboard.writeText(text);
      setStatus(markdown ? "已复制 Markdown" : "已复制当前稿件内容");
    } catch { setStatus("浏览器未允许复制，请选中正文手动复制；远程访问需 HTTPS"); }
  }
  async function upload(file: File): Promise<WritingImage | null> {
    if (uploadPending.current) { setImageStatus("正在处理上一张图片，请稍候。"); return null; }
    if (file.size > 5 * 1024 ** 2 || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) { setImageStatus("请选择5MiB以内的静态PNG、JPEG、WebP或GIF图片。"); return null; }
    uploadPending.current = true; setUploading(true); setImageStatus("正在上传并保存图片…");
    try {
      const bodyBase64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1] ?? ""); reader.onerror = reject; reader.readAsDataURL(file); });
      const response = await fetch(endpoint + "/images", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": me.csrf },
        body: JSON.stringify({ name: file.name.slice(0, 180) || "粘贴图片.png", contentType: file.type, bodyBase64 }) });
      const result = await response.json(); if (!mounted.current) return null;
      if (!response.ok) { setImageStatus(result.detail ?? "图片未能保存，请稍后重试。"); return null; }
      setImageStatus("图片已保存到本稿素材。"); revalidator.revalidate(); return result;
    } catch { if (mounted.current) setImageStatus("图片上传未确认，请检查网络后重试；原稿不变。"); return null; }
    finally { uploadPending.current = false; if (mounted.current) setUploading(false); }
  }
  function insertImage(image: WritingImage) {
    const alt = image.name.replace(/[\[\]\\]/g, "\\$&");
    setValue(current => ({ ...current, content: { ...current.content, notes: `${current.content.notes}\n\n![${alt}](${image.url})`.trim() } }));
    setField("notes"); setImageStatus("图片已插入素材与备注，不进入纯口播。");
  }
  function exportMarkdown() {
    const blob = new Blob([`# ${value.title}\n\n${value.content[field]}\n`], { type: "text/markdown;charset=utf-8" }), url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = `${value.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 80)}-${fields[field]}-草稿.md`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus("已导出当前视图的 Markdown 草稿；此操作不会确认定稿");
  }
  async function exportZip(mode: "draft" | "final", format: "zip" | "html" = "zip") {
    if (exportPending.current || uploadPending.current) return;
    const current = await save("manual"); if (current === null || !same(latest.current, saved.current)) return;
    exportPending.current = true; setExporting(true); setExportStatus("正在核对当前版本与图片，准备下载…");
    try {
      const response = await fetch(endpoint + "/export", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": me.csrf }, body: JSON.stringify({ version: current, mode, format }) });
      if (!response.ok) { const problem = await response.json(); if (mounted.current) setExportStatus(problem.detail ?? "导出未完成，请检查已保存版本与图片后重试。"); return; }
      const blob = await response.blob(); if (!mounted.current) return;
      const exportedVersion = response.headers.get("x-studio-writing-version") ?? String(current), url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? `FastLaneNEWS-${project.id}-v${exportedVersion}.${format}`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      setExportStatus(`已下载${mode === "final" ? "定稿" : "草稿"}版本 ${exportedVersion}，${format === "html" ? "打开HTML即可离线查看正文与图片" : "解压后可查看正文与图片"}。${same(latest.current, saved.current) ? "" : "下载开始后新增的修改尚未包含，请另行保存。"}`);
      revalidator.revalidate();
    } catch { if (mounted.current) setExportStatus("下载未完成，请检查网络后重试；稿件和原图仍保留。"); }
    finally { exportPending.current = false; if (mounted.current) setExporting(false); }
  }
  function captureRevisionSelection() {
    const area = editor.current?.querySelector<HTMLTextAreaElement>("textarea");
    let selection: { start: number; end: number; text: string } | null = null;
    if (area && area.selectionEnd > area.selectionStart) selection = { start: area.selectionStart, end: area.selectionEnd, text: value.content[field].slice(area.selectionStart, area.selectionEnd) };
    else {
      const selected = window.getSelection(), root = editor.current?.querySelector(".tiptap"), text = selected?.toString() ?? "";
      if (text && root && selected?.anchorNode && selected.focusNode && root.contains(selected.anchorNode) && root.contains(selected.focusNode)) {
        const start = value.content[field].indexOf(text);
        if (start >= 0 && value.content[field].indexOf(text, start + 1) < 0) selection = { start, end: start + text.length, text };
      }
    }
    revisionSelection.current = { field, text: value.content[field], selection };
  }
  return <div className="studio-writing-screen">
    <header className="studio-page-header"><div><h1>编辑稿件</h1><p>每篇独立保存，生成与修改只作用于本稿。</p></div><div className="studio-actions"><Link className="studio-button" to="/admin/studio/writing">全部稿件</Link><a className="studio-button" href={`/admin/studio/writing/${project.id}`} target="_blank" rel="noopener noreferrer">独立打开</a></div></header>
    <div className="studio-writing-savebar"><span role="status">{status} · 版本 {baseVersion}{dirty ? " · 有未保存修改" : ""}</span><div className="studio-actions" aria-label="稿件操作">
      <button type="button" onClick={() => setTool("history")}>修改历史</button>
      <button type="button" onClick={() => setTool("evidence")}>写作依据</button>
      <button type="button" onPointerDown={captureRevisionSelection} onClick={() => setTool("revision")}>AI 改稿</button>
      <button type="button" onClick={() => setTool("generation")}>生成口播稿{running ? " · 处理中" : generation.state === "proposal" ? " · 待采纳" : ""}</button>
      <button type="button" onClick={() => setTool("export")}>复制与导出</button>
      <button onClick={() => void save("manual")} disabled={blocked || !!recovery}>保存</button>
      <button onClick={duplicate} disabled={!ready || copyingDraft || uploading || exporting || blocked || !!recovery || action.busy}>{copyingDraft ? "正在复制…" : copiedDraft ? "再复制为新稿" : "复制为新稿"}</button>
      <button className="studio-primary" onClick={finalize} disabled={blocked || !!recovery || action.busy || !value.content.spoken.trim()}>确认定稿</button></div></div>
    {copiedDraft && <p className="studio-caption" role="status">已从本稿版本 {copiedDraft.version} 创建独立草稿。<a href={`/admin/studio/writing/${copiedDraft.id}`} target="_blank" rel="noopener noreferrer">打开副本</a></p>}
    {project.snapshot.copiedFrom && <p className="studio-caption">复制自<Link to={`/admin/studio/writing/${project.snapshot.copiedFrom.projectId}`}>原稿</Link>版本 {project.snapshot.copiedFrom.version}。材料和规则沿用该版本的快照；本稿独立保存、确认和导出。</p>}
    {recovery && <section className="studio-writing-warning" role="alert"><h2>发现本机未同步稿件</h2><p>共 {recoveries.length} 份窗口副本。恢复后可继续编辑；服务器版本已变时需先对比，不能直接覆盖。</p>
      <label>选择恢复副本<select value={recovery.key} onChange={event => setRecoveries(current => [...current.filter(item => item.key === event.target.value), ...current.filter(item => item.key !== event.target.value)])}>
        {recoveries.map((item, index) => <option key={item.key} value={item.key}>{index + 1} · 基于版本 {item.baseVersion} · {item.storedAt ? date(item.storedAt) : item.value.title} · {item.value.content.spoken.slice(0, 36)}</option>)}</select></label>
      <div className="studio-actions"><button onClick={() => {
        if (ownRecoveryKey.current) try { localStorage.setItem(ownRecoveryKey.current, JSON.stringify({ value: recovery.value, baseVersion: recovery.baseVersion, storedAt: new Date().toISOString() })); }
        catch { setStatus("恢复内容已打开，请立即手动保存服务器版本"); }
        setValue(recovery.value); if (recovery.baseVersion !== version.current) { setBlocked(true); setStatus("恢复稿基于旧版本，请与服务器对比后合并"); } setRecoveries([]);
      }}>恢复本机内容</button>
      <button onClick={() => setRecoveries([])}>本次使用服务器版本</button><button onClick={() => {
        try { localStorage.removeItem(recovery.key); setRecoveries(current => current.filter(item => item.key !== recovery.key)); }
        catch { setStatus("副本未能清除，请检查浏览器存储权限"); }
      }}>丢弃所选副本</button></div></section>}
    {blocked && <section className="studio-writing-warning" role="alert"><h2>本地内容已保留</h2><p>先复制需要保留的文字，再打开服务器当前版本对比。网络中断可原版本重试，版本冲突仍会被拒绝。</p>
      <div className="studio-actions"><button onClick={() => { setBlocked(false); setStatus("等待重新保存"); }}>重试保存</button><button onClick={() => void selectVersion(project.version)}>对比服务器版本</button><button onClick={() => revalidator.revalidate()}>刷新服务器状态</button></div></section>}
    <div className={`studio-writing-workspace${siblings.total > 1 ? " studio-writing-with-nav" : ""}`}>
    {siblings.total > 1 && <nav className="studio-writing-drafts" aria-label="本期稿件"><h2>本期稿件</h2><p className="studio-caption">共 {siblings.total} 篇 · 各自独立保存</p><ul>{siblings.rows.map(item => <li key={item.id}>
      <Link to={`/admin/studio/writing/${item.id}`} aria-current={item.id === project.id ? "page" : undefined} onClick={event => {
        if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); void save("manual").then(current => { if (current !== null && same(latest.current, saved.current)) navigate(`/admin/studio/writing/${item.id}`); });
      }}><strong>{item.id === project.id ? value.title : item.title}</strong><span className="studio-caption">{[...new Set(item.snapshot.directions.map(direction => item.snapshot.columns.find(column => column.id === direction.columnId)?.name))].join(" / ")}</span></Link></li>)}</ul>
      <div className="studio-actions">{siblings.page > 1 && <Link to={`?draftPage=${siblings.page - 1}`} preventScrollReset>上一页</Link>}{siblings.hasMore && <Link to={`?draftPage=${siblings.page + 1}`} preventScrollReset>下一页</Link>}</div></nav>}
    <div className="studio-writing-grid"><section className="studio-writing-main" aria-label="独立稿件正文">
      <label className="studio-writing-title">稿件标题<input value={value.title} maxLength={240} onChange={event => setValue(current => ({ ...current, title: event.target.value }))} /></label>
      {!!value.titleOptions?.length && <div className="studio-writing-titles" role="group" aria-label="备用标题"><p className="studio-caption">备用标题 · 点击可替换正式标题</p>{value.titleOptions.map(title => <span key={title}>
        <button type="button" aria-pressed={title === value.title} onClick={() => setValue(current => ({ ...current, title }))}>{title}</button><button type="button" aria-label={`删除备用标题：${title}`} onClick={() => setValue(current => ({ ...current, titleOptions: current.titleOptions?.filter(item => item !== title) }))}>删除</button></span>)}</div>}
      <div className="studio-writing-view"><div role="tablist" aria-label="稿件内容">{Object.entries(fields).map(([key, name]) => <button key={key} role="tab" aria-selected={field === key} onClick={() => setField(key as keyof WritingContent)}>{name}</button>)}</div>
        <div className="studio-actions" data-writing-editor-controls=""><button type="button" onClick={() => { if (editing) leaveEditor(); else setEditing(true); }}>{editing ? "完成编辑" : "编辑正文"}</button><label><input type="checkbox" checked={markdown} onChange={event => { setMarkdown(event.target.checked); setEditing(true); }} />Markdown</label></div></div>
      <div ref={editor} className="studio-writing-body" onBlurCapture={() => captureRevisionSelection()}>{markdown ? <textarea aria-label={`${fields[field]} Markdown`} className="studio-writing-markdown" value={value.content[field]} maxLength={200000}
        onBlur={event => { if ((event.relatedTarget as Element | null)?.closest("[data-writing-editor-controls]")) void save("auto"); else leaveEditor(); }} onChange={event => setValue(current => ({ ...current, content: { ...current.content, [field]: event.target.value } }))} />
        : <WritingEditor key={`${project.id}:${field}`} label={`${fields[field]}正文`} value={value.content[field]}
          readOnly={!editing} onActivate={() => setEditing(true)} onLeave={leaveEditor} images={images} onManagedImage={image => { if (field === "spoken") { insertImage(image); return false; } return true; }}
          onChange={text => setValue(current => ({ ...current, content: { ...current.content, [field]: text } }))} onImageWarning={setImageStatus}
          onPasteImage={async file => { const image = await upload(file); if (!image) return null; if (field === "spoken") { insertImage(image); return null; } return image.url; }} />}</div>
      <p className="studio-caption studio-writing-edit-hint">点击正文即可编辑，离开后自动保存。</p>
      <section className="studio-writing-assets" aria-label="图片素材"><h2>图片素材</h2><label>上传支撑图片<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={uploading} onChange={async event => {
        const input = event.currentTarget, file = input.files?.[0]; if (file) { const image = await upload(file); if (image) insertImage(image); } input.value = "";
      }} /></label><p className="studio-caption" role="status">{imageStatus || "可直接粘贴图片。5MiB以内、最多2000万像素，仅支持静态图片；保存后可移除素材列表中的条目，历史引用仍会保留。"}</p>
        <p className="studio-caption">可把图片拖到制作方案或素材备注；纯口播保持文字。移出列表不会删除历史版本中的图片。</p>
        {images.length ? <ul className="studio-writing-images">{images.map(image => {
          const news = image.source.kind === "news" ? image.source : null;
          const article = news ? externalUrl(news.articleUrl ?? project.snapshot.materials.find(material => material.id === news.materialId)?.url ?? null) : null;
          const original = news ? externalUrl(news.originalUrl) : null;
          return <li key={image.assetId}><img src={image.url} alt={image.name} loading="lazy" draggable onDragStart={event => { event.dataTransfer.setData("application/x-fastlanenews-image", image.assetId); event.dataTransfer.effectAllowed = "copy"; }} /><span>{image.name}</span>
          {news && <><p className="studio-caption">新闻配图{news.revision ? ` · 文章版本 ${news.revision}` : ""} · 授权未知</p><div className="studio-actions">
            {article && <a href={article} target="_blank" rel="noreferrer">来源文章</a>}{original && <a href={original} target="_blank" rel="noreferrer">图片原链接</a>}
          </div></>}<div className="studio-actions">
          <button onClick={() => insertImage(image)}>插入素材备注</button><button disabled={action.busy || dirty || blocked || uploading} onClick={() => action.run("DELETE", endpoint + `/images/${image.assetId}`, { version: version.current })}>移出素材列表</button>
        </div></li>; })}</ul> : <p className="studio-caption">素材列表为空。可上传或粘贴图片；新闻配图采用选题冻结时已保存的图片。</p>}
      </section>
    </section><aside className="studio-writing-support" aria-label="本稿引用新闻与视频">
      <WritingReferences key={project.id} project={project} />
    </aside></div></div>
    <Dialog title="AI 改稿" open={tool === "revision"} onClose={() => setTool(null)} wide><div className="studio-writing-tools">      <WritingRevisions key={project.id} projectId={project.id} version={baseVersion} field={field} text={value.content[field]} prepare={async () => {
        const current = await save("manual"); return current !== null && same(latest.current, saved.current) ? current : null;
      }} getSelection={() => {
        const selected = revisionSelection.current;
        return selected?.field === field && selected.text === value.content[field] ? selected.selection : null;
      }} />
</div></Dialog>
    <Dialog title="生成口播与制作方案" open={tool === "generation"} onClose={() => setTool(null)} wide><div className="studio-writing-tools">      <section><h2>生成口播与制作方案</h2><p className="studio-caption">{running ? "后台正在处理，关闭页面也会继续。" : generation.state === "failed" ? "生成未完成，可检查材料或模型后重试。" : generation.state === "proposal" ? "有待采纳 AI 稿，手动内容已保留。" : generation.state === "completed" ? "已保存生成结果。" : "按本稿标题、材料与写作规则起草，再中文润色和事实对照。"}</p>
        <label>本次要求<textarea rows={3} value={value.instructions} maxLength={5000} onChange={event => setValue(current => ({ ...current, instructions: event.target.value }))} /></label>
        <div className="studio-actions"><button className="studio-primary" onClick={generate} disabled={action.busy || blocked || !!recovery || running || !generation.modelEnabled}>{generation.state === "failed" ? "重试生成" : "生成口播与方案"}</button><button onClick={() => revalidator.revalidate()}>刷新进度</button></div>
        {!generation.modelEnabled && <p className="studio-caption">模型调用尚未启用，仍可手动编辑保存。</p>}{generation.error && <p role="alert">{generation.error}</p>}
        {generation.result && <><p className="studio-caption">模型自查：{generation.quality === "checked" ? "未发现重要问题，仍需试读确认" : "仍有问题需要核对"}。口播估时约 {generation.result.duration.seconds} 秒。</p>
          <details><summary>查看估时依据与检查意见</summary><p className="studio-caption">{generation.result.duration.basis}</p>{generation.result.issues.map((issue, i) => <p key={i}>{issue.problem}：{issue.suggestion}</p>)}</details></>}
        {generation.state === "proposal" && generation.result && <details><summary>对比待采纳 AI 稿</summary>{generation.result.title && <h3>{generation.result.title}</h3>}<div className="studio-writing-comparison">{generation.result.content.spoken}</div><button disabled={dirty || blocked || action.busy}
          onClick={() => action.run("POST", endpoint + `/generation/${generation.id}/apply`, { version: version.current })}>将 AI 稿保存为本稿新版本</button><p className="studio-caption">请先保存本地修改；此前手改版本会保留。</p></details>}
      </section>
</div></Dialog>
    <Dialog title="写作依据与版本" open={tool === "evidence"} onClose={() => setTool(null)} wide><div className="studio-writing-tools">      <section><WritingBrief project={project} /><Link to={`/admin/studio/topics/batches/${project.batchId}`}>查看原批次与审核</Link>
        <HistoryChanges changes={project.historyChanges} />
        <WritingSkillEvidence skills={project.snapshot.skills} label="本稿写作规则" />
        <ReferenceAnalysisEvidence project={project} />
        <p className="studio-caption">当前版本沿用的规则。局部改稿只作用于选中部分，手动保存不会重新润色全文。</p>
        {!!project.snapshot.expressionLibraries?.length && <details aria-label="本稿博主表达模式"><summary>本稿博主表达模式（{project.snapshot.expressionLibraries.length} 位）</summary>
          <p className="studio-caption">采纳时冻结的版本。后续学习、更正或取消关注不会改写本稿，以下旧作品只作表达参考。</p>
          {project.snapshot.expressionLibraries.map(library => <CreatorExpressionEvidence key={library.id} library={library} />)}
        </details>}
        <details aria-label="本稿栏目定稿样本"><summary>本稿栏目定稿样本（{project.snapshot.languageSamples?.length ?? "未记录"}）</summary>
          <p className="studio-caption">仅作表达参考，不是本期事实依据。样本保存后更正，不会改变这里的冻结版本。</p>
          {project.snapshot.languageSamples?.length ? <LanguageSampleEntries samples={project.snapshot.languageSamples} columns={project.snapshot.columns} />
            : <p className="studio-caption">{project.snapshot.languageSamples ? "本稿未选用栏目定稿样本，可依据本期材料独立写作。" : "本稿创建时未记录栏目定稿样本，不追补或改写历史。"}</p>}
        </details>
      </section>
</div></Dialog>
    <Dialog title="修改历史" open={tool === "history"} onClose={() => setTool(null)} wide><div className="studio-writing-tools">      <section><p className="studio-caption">共 {versions.total} 版 · 第 {versions.page} 页。已保存定稿保留在历史中。</p><ul>{versions.rows.map(item => <li key={item.version}><button onClick={() => void selectVersion(item.version)}>版本 {item.version} · {item.source === "final" ? "已确认定稿" : item.source === "model" ? "AI 生成" : item.source === "restore" ? "历史恢复" : "草稿保存"}</button><span className="studio-caption">{date(item.createdAt)}</span></li>)}</ul>
        <nav className="studio-actions" aria-label="修改历史分页">{versions.page > 1 && <Link to={`?historyPage=${versions.page - 1}`} preventScrollReset>较新版本</Link>}{versions.hasMore && <Link to={`?historyPage=${versions.page + 1}`} preventScrollReset>更早版本</Link>}</nav></section>
    {preview && <section className="studio-writing-history" aria-label="历史版本对比"><header><h2>版本 {preview.version}：{preview.title}</h2><button onClick={() => setPreview(null)}>收起对比</button></header><p className="studio-caption">{date(preview.createdAt)} · 当前编辑内容保持不变</p>
      <div className="studio-writing-comparison">{preview.content.spoken}</div>
      {preview.skills && <WritingSkillEvidence skills={preview.skills} label="此版本写作规则" />}
      <button disabled={dirty || blocked || action.busy} onClick={async () => { const result = await action.run("POST", endpoint + "/restore", { version: version.current, restoreVersion: preview.version }); if (result) setPreview(null); }}>恢复为新的草稿版本</button><p className="studio-caption">先保存当前修改；恢复同时沿用该版本的写作规则，不会删除原有定稿。</p></section>}
</div></Dialog>
    <Dialog title="复制与导出" open={tool === "export"} onClose={() => setTool(null)}><div className="studio-writing-tools">      <div className="studio-actions studio-writing-output"><button onClick={copy}>复制{markdown ? " Markdown" : "富文本"}</button><button onClick={exportMarkdown}>导出当前 Markdown</button>
        <button disabled={exporting || uploading || blocked || !!recovery || action.busy} onClick={() => exportZip("draft")}>{exporting ? "正在打包…" : "下载 ZIP 草稿"}</button>
        <button disabled={exporting || uploading || blocked || !!recovery || action.busy || !value.content.spoken.trim()} onClick={() => exportZip("final")}>定稿并下载 ZIP</button>
        <button disabled={exporting || uploading || blocked || !!recovery || action.busy} onClick={() => exportZip("draft", "html")}>离线 HTML 草稿</button>
        <button disabled={exporting || uploading || blocked || !!recovery || action.busy || !value.content.spoken.trim()} onClick={() => exportZip("final", "html")}>定稿并下载 HTML</button></div>
      <p className="studio-caption" role="status">{exportStatus}</p>
      <p className="studio-caption">ZIP 解压后离线查看；单文件HTML内嵌图片，最多32MiB。单独 Markdown 保留本机图片地址。定稿下载会先确认保存；草稿下载不作为确认样本。</p>
</div></Dialog>
  </div>;
}

export default function Writing() {
  const data = useLoaderData<typeof loader>();
  if (data.view === "saved") return <SavedWritingVersion project={data.project} version={data.version} />;
  if (data.view === "editor") return <DraftEditor key={data.project.id} project={data.project} generation={data.generation} versions={data.versions} images={data.images} siblings={data.siblings} />;
  return <WritingLibrary list={data.list} mode={data.mode} state={data.state} batchId={data.batchId} columnId={data.columnId} columns={data.columns} batches={data.batches} q={data.q} />;
}
export function ErrorBoundary() {
  useRouteError();
  return <section className="studio-empty" role="alert"><h1>稿件未能加载</h1><p>检查登录、链接或网络后重试，已保存稿件不会因此删除。</p><div className="studio-actions"><button onClick={() => window.location.reload()}>重新加载</button><Link to="/admin/studio/writing">返回写稿台</Link></div></section>;
}
