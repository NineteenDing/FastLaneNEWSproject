import { BatchTimeline } from "./batch-timeline";
import { WritingSearch } from "./writing-search";
import { useState } from "react";
import { Form, Link } from "react-router";
import type { TopicBatchPage, TopicColumn, WritingContent, WritingProject, WritingProjectPage, WritingVersion } from "../contracts";
import { WritingEditor } from "./writing-editor";
import { WritingSkillEvidence } from "./writing-revisions";

const date = (value: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Hong_Kong", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
export function WritingLibrary({ list, mode, state, batchId, columnId, columns, batches, q = "" }: { list: WritingProjectPage; mode: "current" | "history"; state: "all" | "draft" | "final"; batchId: string | null; columnId: string; columns: TopicColumn[]; batches?: TopicBatchPage | null; q?: string }) {
  const groups = new Map<string, WritingProject[]>();
  for (const project of list.rows) groups.set(project.batchId, [...(groups.get(project.batchId) ?? []), project]);
  const query = (page = 1, nextState = state) => `?${new URLSearchParams({ view: mode, state: nextState, page: String(page), ...(batchId ? { batchId } : mode === "history" ? { allBatches: "true" } : {}), ...(columnId ? { columnId } : {}), ...(q ? {q} : {}) })}`;
  return <div className="studio-screen-list"><header className="studio-page-header"><div><h1>写稿台</h1><p>从选题建立稿件，各自生成、修改和确认。</p></div><Link className="studio-button" to="/admin/studio/topics">前往选题台</Link></header>
    <nav className="studio-tabs" aria-label="稿件视图"><Link to="/admin/studio/writing" aria-current={mode === "current" ? "page" : undefined}>当期稿件</Link><Link to="?view=history" aria-current={mode === "history" ? "page" : undefined}>历史稿件</Link></nav>
    <div className={mode === "history" ? "studio-writing-history-layout" : "studio-fixed-panel"}>
    {mode === "history" && batches && <BatchTimeline initial={batches} selected={batchId} draftsOnly href={id => `?view=history&state=all&batchId=${id}`} />}
    <div className="studio-fixed-panel">
    {mode === "history" && <div className="studio-actions studio-writing-history-modes"><Link to={query(1, "final")} aria-current={state === "final" ? "page" : undefined}>已确认定稿</Link><Link to={query(1, "draft")} aria-current={state === "draft" ? "page" : undefined}>未完成草稿</Link><Link to={query(1, "all")} aria-current={state === "all" ? "page" : undefined}>全部稿件</Link></div>}
    <Form method="get" className="studio-filters studio-writing-library-filters"><input type="hidden" name="view" value={mode} /><input type="hidden" name="state" value={state} />{batchId && <input type="hidden" name="batchId" value={batchId} />}
      <WritingSearch key={q} initial={q} /><label>栏目<select name="columnId" defaultValue={columnId} key={columnId} title={columns.find(column => column.id === columnId)?.name ?? "全部栏目"}><option value="">全部栏目</option>{columns.map(column => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label><button>筛选</button></Form>
    {columnId && <p className="studio-caption studio-selected-column">当前栏目：{columns.find(column => column.id === columnId)?.name}</p>}
    {batchId && <div className="studio-actions" role="status"><span className="studio-caption">正在查看单个选题批次 · 共 {list.total} 篇稿件</span><Link to="?view=history&state=all&allBatches=true">查看全部批次</Link></div>}
    <div className="studio-page-content">{list.rows.length ? <div className="studio-writing-batches">{[...groups].map(([id, projects]) => <section key={id} aria-labelledby={`draft-batch-${id}`}>
      <header className="studio-writing-batch-header"><div><h2 id={`draft-batch-${id}`}>{date(projects[0]!.snapshot.batch.startsAt)} — {date(projects[0]!.snapshot.batch.endsAt)}</h2><p className="studio-caption">选题收录窗口 · 本页 {projects.length} 篇稿件</p></div><div className="studio-actions">
        {!batchId && <Link to={`?view=history&state=${state}&batchId=${id}`}>只看这一批</Link>}<Link to={`/admin/studio/topics/batches/${id}`}>查看选题与审核</Link></div></header>
      <ul className="studio-writing-list">{projects.map(project => { const confirmed = state === "final" && project.confirmedVersion;
        const href = `/admin/studio/writing/${project.id}${confirmed ? `?version=${project.confirmedVersion}` : ""}`;
        return <li key={project.id}><div><h3><Link to={href}>{confirmed ? project.confirmedTitle ?? project.title : project.title}</Link></h3>
          <p className="studio-caption">{[...new Set(project.snapshot.directions.map(direction => project.snapshot.columns.find(column => column.id === direction.columnId)?.name))].join(" / ")} · {confirmed || project.state === "final" ? "已确认定稿" : "草稿"} · 版本 {confirmed ? project.confirmedVersion : project.version}</p>
          <p className="studio-caption">最近保存 {date(project.updatedAt)} · {project.snapshot.directions.length} 个方向{confirmed && project.state === "draft" ? " · 当前另有未完成修改" : ""}</p></div><div className="studio-actions">
          <Link className="studio-button" to={href}>{confirmed ? "查看定稿" : "继续编辑"}</Link>{confirmed && <Link to={`/admin/studio/writing/${project.id}`}>继续修改</Link>}<a href={href} target="_blank" rel="noopener noreferrer">独立打开</a></div></li>;
      })}</ul></section>)}</div> : <section className="studio-empty"><h2>{list.total ? "这一页没有稿件" : batchId ? "这一批次还没有稿件" : state === "final" ? "还没有确认定稿" : mode === "current" ? "本期还没有稿件" : "没有符合条件的稿件"}</h2>
        <p className="studio-caption">每次采纳都建立独立稿件；历史中的未完成草稿仍可继续写。</p>{list.total ? <Link to={query(1)}>返回第一页</Link> : <Link to="/admin/studio/topics?view=history">查看历史选题</Link>}</section>}
    </div><nav className="studio-pagination studio-fixed-footer" aria-label="稿件分页">{list.page > 1 && <Link to={query(list.page - 1)}>上一页</Link>}<span>第 {list.page} 页 · 共 {list.total} 篇</span>{list.hasMore && <Link to={query(list.page + 1)}>下一页</Link>}</nav></div></div>
  </div>;
}

export function SavedWritingVersion({ project, version }: { project: WritingProject; version: WritingVersion }) {
  const [field, setField] = useState<keyof WritingContent>("spoken");
  const fields = { spoken: "纯口播", production: "制作方案", notes: "素材与备注" };
  return <><header className="studio-page-header"><div><h1>{version.source === "final" ? "已确认定稿" : "已保存版本"}</h1><p>版本 {version.version} · {date(version.createdAt)}</p></div><div className="studio-actions"><Link to="/admin/studio/writing?view=history">返回历史稿件</Link><Link to={`/admin/studio/writing/${project.id}`}>继续编辑当前稿</Link></div></header>
    <section className="studio-writing-saved"><h2>{version.title}</h2><p className="studio-caption">当前正在查看保存时的内容，后续修改不会盖掉这一版。</p>
      <div className="studio-writing-view" role="tablist" aria-label="保存稿件内容">{Object.entries(fields).map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={key === field} onClick={() => setField(key as keyof WritingContent)}>{label}</button>)}</div>
      <WritingEditor key={field} value={version.content[field]} label={`${fields[field]}历史预览`} onChange={() => {}} readOnly />
      <details><summary>保存时的标题和写作规则</summary>{version.titleOptions?.map(title => <p key={title}>{title}</p>)}{version.skills && <WritingSkillEvidence skills={version.skills} label="此版本写作规则" />}</details>
    </section></>;
}
