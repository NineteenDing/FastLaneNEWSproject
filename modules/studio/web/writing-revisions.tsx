import { useEffect, useRef, useState } from "react";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import type { WritingContent, WritingProject, WritingRevision } from "../contracts";

export function WritingSkillEvidence({ skills, label }: { skills: WritingProject["snapshot"]["skills"]; label: string }) {
  return <details aria-label={label}><summary>{label}（{skills.length}）</summary>{skills.length ? skills.map(skill =>
    <details key={skill.id}><summary>{skill.name} · v{skill.version}</summary><pre className="studio-writing-rules">{skill.body}</pre></details>)
    : <p className="studio-caption">这份记录未采用可配置的写作 Skill；事实与口播基本要求仍保留。</p>}</details>;
}

type Selection = { start: number; end: number; text: string };
export function WritingRevisions({ projectId, version, field, text, prepare, getSelection }: { projectId: string; version: number; field: keyof WritingContent;
  text: string; prepare(): Promise<number | null>; getSelection(): Selection | null }) {
  const endpoint = `/api/admin/studio/drafts/${projectId}/revisions`, action = useAdminAction("studio-layout");
  const [rows, setRows] = useState<WritingRevision[]>([]), [enabled, setEnabled] = useState(false), [message, setMessage] = useState("");
  const [instruction, setInstruction] = useState("更自然、更精炼，保留事实、归因和适用条件"), [selection, setSelection] = useState<Selection | null>(null), [busy, setBusy] = useState(false);
  const [useLatestSkills, setUseLatestSkills] = useState(false);
  const mounted = useRef(true), reading = useRef(false);
  const running = rows.some(row => row.state === "queued" || row.state === "running");
  async function load() {
    if (reading.current) return; reading.current = true;
    try {
      const response = await fetch(endpoint, { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error();
      const value: { rows: WritingRevision[]; modelEnabled: boolean } = await response.json();
      if (mounted.current) { setRows(value.rows); setEnabled(value.modelEnabled); }
    } catch { if (mounted.current) setMessage("改稿状态暂时无法读取，请刷新重试。"); }
    finally { reading.current = false; }
  }
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, [endpoint]);
  useEffect(() => { if (!running) return; const timer = setInterval(() => { if (!document.hidden) void load(); }, 5000); return () => clearInterval(timer); }, [running, endpoint]);
  useEffect(() => { setSelection(null); }, [field, text]);
  async function submit() {
    setBusy(true);
    try {
      const saved = await prepare(); if (saved === null || !mounted.current) { setMessage("请先保存并处理当前稿件冲突。"); return; }
      const result = await action.run("POST", endpoint, { requestId: crypto.randomUUID(), version: saved, field, instruction, ...(selection ? { selection } : {}),
        ...(useLatestSkills ? { useLatestSkills: true } : {}) }, { revalidate: false });
      if (result && mounted.current) { setMessage("已提交，完成后显示对比，不会直接替换正文。"); await load(); }
    } finally { if (mounted.current) setBusy(false); }
  }
  return <section aria-label="AI主动改稿"><h2>AI 改稿</h2>
    <p className="studio-caption">修改当前视图：{({ spoken: "纯口播", production: "制作方案", notes: "素材与备注" })[field]}。沿用本稿事实与表达参考，先对比后采纳。</p>
    <div className="studio-actions"><button type="button" onClick={() => { const selected = getSelection(); setSelection(selected); setMessage(selected ? "已选中段落，仅修改这一处。" : "请在编辑器选中一段原文；格式跨段时可切到Markdown后选择。"); }}>使用选中段落</button>
      <button type="button" onClick={() => setSelection(null)}>修改当前整篇</button></div>
    {selection && <p className="studio-caption">选中：{selection.text.slice(0, 120)}{selection.text.length > 120 ? "…" : ""}</p>}
    <label>改稿要求<textarea rows={3} value={instruction} maxLength={3000} onChange={event => setInstruction(event.target.value)} /></label>
    <label className="studio-writing-rule-choice"><input type="checkbox" checked={useLatestSkills} disabled={busy || action.busy} onChange={event => setUseLatestSkills(event.target.checked)} />采用当前启用的最新写作 Skill</label>
    <p className="studio-caption">{useLatestSkills ? "提交时冻结全局与本稿栏目当前启用的规则；只修改所选视图或段落。采纳前原稿保持不变。" : "默认沿用本稿已记录的规则。更新设置不会自动改写旧稿。"}</p>
    <div className="studio-actions"><button type="button" className="studio-primary" disabled={busy || action.busy || running || !enabled || !text.trim() || !instruction.trim()} onClick={() => void submit()}>{busy ? "正在提交…" : selection ? "生成局部修改建议" : "生成整稿修改建议"}</button>
      <button type="button" onClick={() => void load()}>刷新改稿状态</button></div><p role="status" className="studio-caption">{message}{!enabled ? " 模型调用尚未启用。" : ""}</p>
    {!!rows.length && <p className="studio-caption">最近20份修改建议；已采纳内容同时保留在修改历史中。</p>}
    {rows.map(row => <details key={row.id}><summary>版本{row.baseVersion} · {({ spoken: "口播", production: "制作方案", notes: "备注" })[row.field]} · {row.applied ? "已采纳" : ({ queued: "等待改稿", running: "正在改稿", completed: "待比较", failed: "未完成" })[row.state]}</summary>
      <p className="studio-caption">要求：{row.instruction}</p>{row.error && <p role="alert">{row.error}</p>}
      {row.rules && <WritingSkillEvidence skills={row.rules.skills} label="本次改稿冻结的最新规则" />}
      {row.result && <><p>{row.result.reason}</p><div className="studio-writing-revision-compare"><div><h3>修改前</h3><pre className="studio-writing-comparison">{row.result.before}</pre></div><div><h3>修改建议</h3><pre className="studio-writing-comparison">{row.result.after}</pre></div></div>
        {row.result.issues.map((issue, i) => <p key={i}>{issue.problem}：{issue.suggestion}</p>)}
        {!row.applied && <button type="button" disabled={action.busy || row.baseVersion !== version || !row.result.checked} onClick={async () => {
          const saved = await prepare(); if (saved !== row.baseVersion) { setMessage("正文已改变，这份建议不能覆盖新版本；可复制其中合适的句子或重新申请。"); return; }
          if (await action.run("POST", `${endpoint}/${row.id}/apply`, { version: saved }, { success: "已保存为新版本，原稿仍在修改历史中" })) await load();
        }}>采纳并保存为新版本</button>}
        {row.baseVersion !== version && !row.applied && <p className="studio-caption">正文已更新，这份旧建议仅供对比。</p>}
        {!row.result.checked && <p className="studio-caption">自查仍有重要问题，请保留原稿，调整要求后重新改写。</p>}</>}
      {row.state === "failed" && row.baseVersion === version && <button type="button" disabled={action.busy || !enabled} onClick={() => action.run("POST", `${endpoint}/${row.id}/retry`, { version }, { revalidate: false }).then(load)}>重试这次改稿</button>}
    </details>)}
  </section>;
}
