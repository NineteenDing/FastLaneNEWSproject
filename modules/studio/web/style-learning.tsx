import { useEffect, useRef, useState } from "react";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import type { StyleLearningRun, StyleLearningSettings as LearningSettings, TopicColumn } from "../contracts";
import { LanguageSampleEntries } from "./language-samples";

const clock = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Hong_Kong", dateStyle: "medium", timeStyle: "short" });
const states = { queued: "等待执行", running: "正在学习", candidate: "候选已生成", activated: "已启用新规则", retained: "保留原规则", failed: "学习未完成" };
const criteria = { facts: "事实", attribution: "归因", conditions: "适用条件", experience: "真实体验", title: "标题兑现", readability: "朗读", templates: "模板句", duration: "时长" };
type Report = { status: { columnId: string; modelEnabled: boolean; run: StyleLearningRun | null; page: number; total: number; hasMore: boolean }; settings: LearningSettings };

function LearningEvidence({ run, tab }: { run: StyleLearningRun; tab: string }) {
  const candidate = run.result?.candidate;
  return <div className="studio-learning-evidence">
    {tab === "candidate" && (candidate ? <section><h4>候选规则与样本依据</h4><p>{candidate.summary}</p>
      <div className="studio-language-samples">{candidate.rules.map(rule => <section key={rule.key}>
        <h4>{rule.body}</h4>{rule.evidence.map((evidence, index) => <blockquote className="studio-language-sample-body" key={index}>
          <p>{evidence.quote}</p><a href={`/admin/studio/writing/${encodeURIComponent(evidence.projectId)}`} target="_blank" rel="noopener noreferrer">来源稿 · 确认版本 {evidence.version}</a>
        </blockquote>)}
      </section>)}</div>
    </section> : <p>当前没有候选规则。</p>)}
    <section hidden={tab !== "samples"}><h4>本次样本与冻结规则</h4>
      <h4>提取规则的 3 份确认稿</h4><LanguageSampleEntries samples={run.input.training} columns={[run.input.column]} />
      {!!run.input.editExamples?.length && <section><h4>用户修改对照（{run.input.editExamples.length}）</h4>
        <p className="studio-caption">对照训练组的实际 AI 原稿和确认稿，学习保留下来的表达修改；事实更正不当成永久风格。未确认草稿及保留组不进入这里。</p>
        {run.input.editExamples.map(example => {
          const sample = run.input.training.find(item => item.projectId === example.projectId && item.version === example.finalVersion);
          return <section key={example.projectId}><h4>{sample?.title ?? "确认稿"} · AI 版本 {example.baselineVersion} → 确认版本 {example.finalVersion}</h4>
            <h4>当时的 AI 原稿</h4><p className="studio-language-sample-body">{example.beforeSpoken}</p>
            <h4>用户确认的口播</h4><p className="studio-language-sample-body">{sample?.spoken ?? "对应确认稿不可用，不用当前正文替代。"}</p>
            <a href={`/admin/studio/writing/${encodeURIComponent(example.projectId)}`} target="_blank" rel="noopener noreferrer">查看稿件与历史</a>
          </section>;
        })}
      </section>}
      <h4>用于对照的 2 份保留稿</h4><LanguageSampleEntries samples={run.input.heldOut.map(item => item.sample)} columns={[run.input.column]} />
      <p className="studio-caption">保留稿正文仅用于独立评价，不进入试写。冻结栏目：{run.input.column.name} · 版本 {run.input.column.version}。</p>
      <div className="studio-language-samples">{run.input.skills.map(skill => <section key={skill.id}><h4>{skill.name} · 版本 {skill.version}</h4><p className="studio-language-sample-body">{skill.body}</p></section>)}</div>
    </section>
    {tab === "checks" && !!run.result?.evaluations?.length && <section><h4>查看试写与逐项对照</h4>
      <p className="studio-caption">以下为模型检查，不是用户试读，也不证明成稿质量已经提高。</p>
      {run.result.evaluations.map((evaluation, index) => <section key={evaluation.projectId} aria-label={`保留稿 ${index + 1} · 确认版本 ${evaluation.version}`}>
        <h4>保留稿 {index + 1} · 确认版本 {evaluation.version}</h4>
        <section><h4>基础规则试写</h4><p className="studio-language-sample-body">{evaluation.baseline}</p></section>
        <section><h4>候选规则试写</h4><p className="studio-language-sample-body">{evaluation.trial}</p></section>
        <div className="studio-language-samples">{evaluation.checks.map(check => <section key={check.criterion}>
          <h4>{criteria[check.criterion]} · {check.candidatePass ? "候选满足检查" : "候选未满足检查"}</h4>
          <p>{check.reason}</p><p className="studio-caption">基础稿：{check.baselinePass ? "满足" : "未满足"} · 候选稿：{check.candidatePass ? "满足" : "未满足"}</p>
          <p className="studio-language-sample-body">基础稿引句：{check.baselineQuote}</p>
          <p className="studio-language-sample-body">候选稿引句：{check.candidateQuote}</p>
          <p className="studio-language-sample-body">{check.materialId ? "事实材料" : "确认稿"}依据：{check.sourceQuote}</p>
        </section>)}</div>
      </section>)}
    </section>}
  </div>;
}

function ColumnLearning({ id, active, onDirtyChange }: { id: string; active: boolean; onDirtyChange(value: boolean): void }) {
  const action = useAdminAction("studio-layout"), mounted = useRef(true);
  const [report, setReport] = useState<Report | null>(null), [retry, setRetry] = useState(0), [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1), [section, setSection] = useState("results");
  const [evidenceTab, setEvidenceTab] = useState("candidate");
  const lastRead = useRef<{ page: number; retry: number } | null>(null);
  const [error, setError] = useState(""), [message, setMessage] = useState(""), [lockedKeys, setLockedKeys] = useState<string[]>([]), [stale, setStale] = useState(false);
  const endpoint = `/api/admin/studio/columns/${encodeURIComponent(id)}/learning`;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!active || lastRead.current?.page === page && lastRead.current?.retry === retry) return;
    const controller = new AbortController(); setLoading(true); setError(""); setMessage("");
    void (async () => {
      try {
        const options = { credentials: "same-origin" as const, cache: "no-store" as const,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) };
        const responses = await Promise.all([fetch(endpoint + `?page=${page}`, options), fetch(endpoint + "/config", options)]);
        if (responses.some(response => !response.ok)) throw new Error("unavailable");
        const [status, settings] = await Promise.all(responses.map(response => response.json())) as [Report["status"], LearningSettings];
        if (!controller.signal.aborted) { lastRead.current = { page, retry }; setReport({ status, settings }); setLockedKeys(settings.config.lockedRules.map(rule => rule.key)); setStale(false); }
      } catch { if (!controller.signal.aborted) setError("学习记录暂时无法读取，请重试。其他设置保持不变。"); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [active, endpoint, retry, page]);
  const savedKeys = report?.settings.config.lockedRules.map(rule => rule.key) ?? [];
  const dirty = lockedKeys.length !== savedKeys.length || lockedKeys.some(key => !savedKeys.includes(key));
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  const disabled = action.busy || loading || !!error || stale;
  function refresh() {
    if (dirty && !window.confirm("刷新将丢弃尚未保存的规则锁定修改，继续？")) return;
    setRetry(value => value + 1);
  }
  async function saveLocks() {
    if (!report || report.settings.skillVersion === null) return;
    const result = await action.run<LearningSettings>("PUT", endpoint + "/config", { version: report.settings.config.version,
      skillVersion: report.settings.skillVersion, lockedKeys }, { revalidate: false });
    if (!mounted.current) return;
    if (result) { setReport({ ...report, settings: result }); setMessage("锁定已保存，后续学习保留这些规则。旧稿不变。"); }
    else { setStale(true); setMessage("锁定未保存。请刷新核对当前规则版本后重试。"); }
  }
  async function retryRun() {
    const discardWarning = dirty ? "同时会丢弃尚未保存的规则锁定修改。" : "";
    if (!window.confirm("重试会继续本次冻结材料的学习，已成功步骤会复用，未完成步骤可能产生模型费用。" + discardWarning + "继续？")) return;
    const result = await action.run<{ queued: boolean }>("POST", endpoint, { retryFailed: true }, { revalidate: false });
    if (!mounted.current) return;
    if (result) setRetry(value => value + 1);
  }
  const run = report?.status.run;
  return <div className="studio-learning-details">
    <div className="studio-actions studio-learning-toolbar"><button type="button" disabled={loading || action.busy} onClick={refresh}>刷新学习记录</button><span className="studio-caption" role="status">{loading ? "读取中…" : ""}</span></div>
    <div className="studio-learning-workspace"><nav aria-label="栏目学习分类"><button aria-current={section==="results"?"page":undefined} onClick={()=>setSection("results")}>学习结果与依据</button>
      {section === "results" && <div className="studio-learning-subnav" role="group" aria-label="学习依据分类">{[["candidate","候选规则"],["samples","样本与原规则"],["checks","试写对照"]].map(([key,label])=><button key={key} aria-current={evidenceTab===key?"page":undefined} onClick={()=>setEvidenceTab(key!)}>{label}</button>)}</div>}
      <button aria-current={section==="locks"?"page":undefined} onClick={()=>setSection("locks")}>当前规则锁定</button></nav>
    <div className="studio-scroll-region" aria-live="polite">{error && <p className="studio-notice" role="alert">{error}<button type="button" onClick={refresh}>重试读取学习</button></p>}
      {report && <>
        {!report.status.modelEnabled && <p className="studio-caption">模型任务已暂停或未获启动许可；记录仍可查看，锁定规则仍可保存。</p>}
        <section hidden={section !== "results"}>{run ? <>
          <p><strong>{states[run.state]}</strong> · 已保存 {run.completedSteps} / 7 个步骤</p>
          <p className="studio-caption">更新于 {clock.format(new Date(run.updatedAt))} · 香港时间</p>
          {run.result?.reason && <p>{run.result.reason}</p>}{run.error && <p className="studio-notice">{run.error}</p>}
          {run.state === "failed" && page === 1 && <button type="button" disabled={disabled || !report.status.modelEnabled} onClick={() => void retryRun()}>重试本次学习</button>}
          {run.state === "retained" && <p>候选规则未通过对照，继续使用原规则。可在试写对照中查看原因；不会改动旧稿。</p>}
          <LearningEvidence run={run} tab={evidenceTab} />
        </> : <p>尚无学习记录。每周日凌晨 4 点检查，积累 5 份新的完整确认稿后才会提出候选；需要后台运行及模型许可。</p>}</section>
        {report.settings.skillVersion !== null && <div hidden={section !== "locks"} className="studio-learning-locks">
          <h4>当前规则锁定</h4><p className="studio-caption">规则版本 {report.settings.skillVersion}。选中的条目不会被后续自动学习替换；完整规则的历史与回退在上方“写作 Skill”。</p>
          {report.settings.rules.length ? <fieldset disabled={disabled}><legend>保留的表达规则</legend>{report.settings.rules.map(rule => <label key={rule.key}>
            <input type="checkbox" checked={lockedKeys.includes(rule.key)} onChange={event => setLockedKeys(current => event.target.checked ? [...current, rule.key] : current.filter(key => key !== rule.key))} />
            <span>{rule.body}</span></label>)}</fieldset> : <p className="studio-caption">当前规则已手工修改或回退，暂不能按条新增锁定。已有锁定仍保留，可清除后重新学习。</p>}
          {!!savedKeys.length && !report.settings.rules.length && <button type="button" disabled={disabled} onClick={() => setLockedKeys([])}>清除已有锁定</button>}
          <div className="studio-actions"><button type="button" className="studio-primary" disabled={disabled || !dirty} onClick={() => void saveLocks()}>{action.busy ? "正在保存…" : "保存锁定规则"}</button></div>
        </div>}
      </>}
      {message && <p className="studio-caption" role="status">{message}</p>}
    </div></div>
    <nav className="studio-pagination" aria-label="规则学习记录分页"><button disabled={disabled || page <= 1} onClick={() => { if (!dirty || window.confirm("翻页会丢弃尚未保存的锁定修改，继续？")) setPage(value => value - 1); }}>上一页</button><span>第 {page} 页 · 共 {report?.status.total ?? 0} 次</span><button disabled={disabled || !report?.status.hasMore} onClick={() => { if (!dirty || window.confirm("翻页会丢弃尚未保存的锁定修改，继续？")) setPage(value => value + 1); }}>下一页</button></nav>
  </div>;
}

export function StyleLearningSettings({ columns, active = true }: { columns: TopicColumn[]; active?: boolean }) {
  const [id, setId] = useState(columns.find(column => column.enabled)?.id ?? columns[0]?.id ?? "");
  const [dirty, setDirty] = useState(false);
  return <section className="studio-session-settings studio-learning-panel" aria-label="栏目规则学习">
    <h2>栏目规则学习</h2>
    <p className="studio-caption">通过保留稿对照才追加规则，只影响后续新稿。模型检查仍需用实际改稿和试读验证。</p>
    <label>学习栏目<select aria-label="学习栏目" value={id} onChange={event => {
      if (dirty && !window.confirm("切换栏目将丢弃尚未保存的规则锁定修改，继续？")) return;
      setDirty(false); setId(event.target.value);
    }}>{columns.map(column =>
      <option key={column.id} value={column.id}>{column.name}{column.enabled ? "" : "（已停用）"}</option>)}</select></label>
    {id && <ColumnLearning key={id} id={id} active={active} onDirtyChange={setDirty} />}
  </section>;
}
