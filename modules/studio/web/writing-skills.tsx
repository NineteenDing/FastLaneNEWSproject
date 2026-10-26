import { useEffect, useState, type FormEvent } from "react";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import type { TopicColumn, WritingSkill, WritingSkillVersionPage } from "../contracts";

function SkillHistory({ skill, columns }: { skill: WritingSkill; columns: TopicColumn[] }) {
  const action = useAdminAction("studio-layout");
  const [open, setOpen] = useState(false), [page, setPage] = useState(1), [retry, setRetry] = useState(0);
  const [report, setReport] = useState<WritingSkillVersionPage | null>(null), [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setReport(null); setError("");
    void (async () => {
      try {
        const response = await fetch(`/api/admin/studio/writing-skills/${encodeURIComponent(skill.id)}/versions?page=${page}&limit=10`, {
          credentials: "same-origin", cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) });
        if (!response.ok) throw new Error("unavailable");
        const result = await response.json() as WritingSkillVersionPage;
        if (!controller.signal.aborted) setReport(result);
      } catch { if (!controller.signal.aborted) setError("历史版本暂时无法读取，请重试。尚未保存的设置保持不变。"); }
    })();
    return () => controller.abort();
  }, [open, page, retry, skill.id]);
  async function restore(source: WritingSkill) {
    if (!window.confirm(`恢复为版本 ${source.version} 的完整配置？将恢复规则名称、正文、栏目、顺序及${source.enabled ? "启用" : "停用"}状态，并丢弃此规则尚未保存的编辑。旧稿保持原规则，新稿才使用恢复后的新版本。`)) return;
    await action.run("POST", `/api/admin/studio/writing-skills/${encodeURIComponent(skill.id)}/restore`,
      { version: skill.version, sourceVersion: source.version }, { success: "已恢复为新的规则版本，历史和旧稿保持原样" });
  }
  return <details className="studio-session-help" aria-label={`${skill.name}的历史版本`} onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}>
    <summary>历史版本与回退</summary>
    <p className="studio-caption">回退会新增一个版本，不删除历史；恢复完整配置，只影响后续新稿。</p>
    {open && !report && !error && <p className="studio-caption" role="status">正在读取历史…</p>}
    {error && <p className="studio-notice" role="alert">{error}<button type="button" onClick={() => setRetry(value => value + 1)}>重试读取历史</button></p>}
    {report && <><p className="studio-caption">共 {report.total} 个版本 · 第 {report.page} 页</p>
      {report.currentVersion !== skill.version && <p className="studio-notice" role="alert">此规则已在其他窗口更新，请刷新页面后再回退。</p>}
      <div className="studio-language-samples">{report.rows.map(row => <details key={row.version}>
        <summary><strong>版本 {row.version} · {row.name}</strong><span className="studio-caption">{row.enabled ? "已启用" : "已停用"} · {row.columnIds.length ? row.columnIds.map(id => columns.find(column => column.id === id)?.name ?? id).join(" / ") : "全局"} · 加载顺序 {row.priority}{row.version === report.currentVersion ? " · 当前版本" : ""}</span></summary>
        <p className="studio-language-sample-body">{row.body}</p>
        {row.version !== report.currentVersion && <button type="button" disabled={action.busy || report.currentVersion !== skill.version} onClick={() => void restore(row)}>恢复为版本 {row.version}</button>}
      </details>)}</div>
      <nav className="studio-actions" aria-label="规则历史分页">{page > 1 && <button type="button" onClick={() => setPage(value => value - 1)}>上一页版本</button>}
        {report.hasMore && <button type="button" onClick={() => setPage(value => value + 1)}>下一页版本</button>}</nav></>}
  </details>;
}

function SkillForm({ skill, columns, onCreated }: { skill?: WritingSkill; columns: TopicColumn[]; onCreated?(): void }) {
  const action = useAdminAction("studio-layout");
  const [name, setName] = useState(skill?.name ?? ""), [body, setBody] = useState(skill?.body ?? ""), [enabled, setEnabled] = useState(skill?.enabled ?? true);
  const [priority, setPriority] = useState(skill?.priority ?? 100), [ids, setIds] = useState(skill?.columnIds ?? []), [message, setMessage] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault();
    const result = await action.run(skill ? "PATCH" : "POST", "/api/admin/studio/writing-skills" + (skill ? "/" + skill.id : ""),
      { name, body, enabled, priority, columnIds: ids, ...(skill ? { version: skill.version } : {}) }, { success: "写作规则已保存，只影响后续新稿" });
    if (result) { setMessage("已保存新版本，历史稿件的规则快照保持原样。"); onCreated?.(); }
  }
  return <form className="studio-skill-form" onSubmit={save}>
    <label>规则名称<input value={name} maxLength={100} onChange={event => setName(event.target.value)} required /></label>
    <label>导入 Markdown 文件<input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" onChange={async event => {
      const file = event.target.files?.[0]; if (!file) return;
      if (file.size > 200000) { setMessage("文件过大，请保留五万字以内的写作规则。"); return; }
      try { const text = (await file.text()).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
        if (!text || text.length > 50000) { setMessage("正文应为 1 至 50000 字符，请精简规则后导入。"); return; }
        setBody(text); if (!name) setName(file.name.replace(/\.(md|markdown|txt)$/i, "").slice(0, 100)); setMessage("已读入文本，点击保存后生效。");
      } catch { setMessage("文件未能读取，请改为直接粘贴文本。"); }
    }} /></label>
    <label className="studio-wide">写作规则<textarea aria-label="写作规则" rows={10} value={body} maxLength={50000} onChange={event => setBody(event.target.value)} required /></label>
    <fieldset className="studio-wide"><legend>适用栏目（不选表示全局）</legend><div className="studio-reference-options">{columns.map(column => <label key={column.id}><input type="checkbox" checked={ids.includes(column.id)}
      onChange={event => setIds(current => event.target.checked ? [...current, column.id] : current.filter(id => id !== column.id))} />{column.name}{column.enabled ? "" : "（已停用）"}</label>)}</div></fieldset>
    <label>加载顺序（数字小的在前）<input type="number" min={0} max={1000} value={priority} onChange={event => setPriority(Number(event.target.value))} required /></label>
    <label className="studio-skill-enabled"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />启用此规则</label>
    <div className="studio-actions studio-wide"><button className="studio-primary" disabled={action.busy || !name.trim() || !body.trim()}>{action.busy ? "正在保存…" : skill ? "保存为新版本" : "添加写作规则"}</button></div>
    <p className="studio-caption studio-wide" role="status">{message}</p>
  </form>;
}

export function WritingSkillSettings({ skills, columns }: { skills: WritingSkill[]; columns: TopicColumn[] }) {
  const [adding, setAdding] = useState(false);
  return <section className="studio-session-settings" aria-labelledby="writing-skills-title"><h2 id="writing-skills-title">写作 Skill</h2>
    <p className="studio-notice">默认使用 Humanizer 中文去 AI 味规则。可导入自己的写作规范，按栏目启用；仅加载文本，不执行附件或脚本。事实和来源条件始终优先。</p>
    <div className="studio-actions"><button onClick={() => setAdding(current => !current)}>{adding ? "收起新增" : "添加写作 Skill"}</button></div>
    {adding && <SkillForm columns={columns} onCreated={() => setAdding(false)} />}
    <div className="studio-skill-list">{skills.map(skill => <details key={`${skill.id}:${skill.version}`}><summary><strong>{skill.name}</strong><span className="studio-caption">版本 {skill.version} · {skill.enabled ? "已启用" : "已停用"} · {skill.columnIds.length ? skill.columnIds.map(id => columns.find(column => column.id === id)?.name ?? id).join(" / ") : "全局"}</span></summary><SkillForm skill={skill} columns={columns} /><SkillHistory skill={skill} columns={columns} /></details>)}</div>
  </section>;
}
