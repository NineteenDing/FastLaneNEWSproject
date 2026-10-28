import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import { num } from "../../../apps/web/app/features/admin/format";
import type { FilterPolicy, FilterPreview, TopicColumn } from "../contracts";

const labels = { practical: "可操作价值", interest: "受众兴趣", heat: "传播热度", substance: "实质信息", freshness: "时效", impact: "实际影响", evidence: "证据支撑", distinctiveness: "表达与新增空间" };
const destinations = { selected_candidate: "精选候选", all_candidate: "全部动态候选", excluded: "范围外", pending: "待分析或补正文", private: "仅内部" };
const publicColumns = { practice: "实操与提效", models: "模型与工具", news: "新闻与实际影响", cases: "作品与案例" };

export function FilterSettings({ initial, columns }: { initial: FilterPolicy; columns: TopicColumn[] }) {
  const action = useAdminAction("studio-layout"), [form, setForm] = useState(initial), saved = useRef(initial);
  const [trial, setTrial] = useState<FilterPreview | null>(null), [trialKey, setTrialKey] = useState(""), [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false), request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const key = JSON.stringify(form), busy = loading || action.busy;
  const v2 = form.editorial;
  const publicTotal = v2 ? Object.values(v2.public.weights).reduce((sum, value) => sum + value, 0) : 0;
  const internalTotal = v2 ? Object.values(v2.internal.weights).reduce((sum, value) => sum + value, 0) : 0;
  const legacyTotal = Object.values(form.public.weights).reduce((sum, value) => sum + value, 0)
    + Object.values(form.internal.weights).reduce((sum, value) => sum + value, 0);
  const validWeights = !!v2 && Math.abs(publicTotal - 100) < 1e-6 && Math.abs(internalTotal - 100) < 1e-6 && Math.abs(legacyTotal - 200) < 1e-6;
  function editEditorial(next: NonNullable<FilterPolicy["editorial"]>) { edit({ ...form, editorial: next }); }
  function edit(next: FilterPolicy) { setForm(next); setTrial(null); setTrialKey(""); setMessage("规则尚未保存，请先试算。"); }
  async function preview(page = 1, directionPage = 1) {
    const result = await action.run<FilterPreview>("POST", "/api/admin/studio/filter-settings/preview", { policy: form, page, directionPage }, { revalidate: false });
    if (result) { setTrial(result); setTrialKey(key); setMessage(`试算完成：${result.total}条材料，${result.changedCount}条分数或去向变化。没有调用模型，也没有保存规则。`); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!validWeights || trialKey !== key) { setMessage("请先调整权重合计为100，再完成本版规则试算。"); return; }
    const result = await action.run<{ policy: FilterPolicy }>("PUT", "/api/admin/studio/filter-settings", form, { revalidate: false, success: "筛选规则已保存" });
    if (result) { saved.current = result.policy; setForm(result.policy); setTrial(null); setTrialKey(""); setMessage(`已保存版本${result.policy.version}。当前分数和后续任务使用新规则，冻结选题、日报和稿件保留原版本。`); }
    else setMessage("未保存，输入已保留。若提示版本冲突，请重新载入最新规则后修改。");
  }
  async function refresh() {
    if (JSON.stringify(saved.current) !== key && !window.confirm("载入最新规则会放弃此处未保存的修改。继续？")) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller; setLoading(true);
    try {
      const response = await fetch("/api/admin/studio/filter-settings", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
      if (!response.ok) throw new Error("unavailable");
      const result = await response.json() as { policy: FilterPolicy };
      if (!controller.signal.aborted) { saved.current = result.policy; setForm(result.policy); setTrial(null); setTrialKey(""); setMessage("已载入最新规则。"); }
    } catch { if (!controller.signal.aborted) setMessage("最新规则暂时无法读取，当前输入已保留，请重试。"); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  function number(label: string, value: number, change: (value: number) => void, min = 0, max = 100, step = "0.1") {
    return <label>{label}<input type="number" min={min} max={max} step={step} required value={Number.isNaN(value) ? "" : value}
      onChange={event => change(event.target.value === "" ? NaN : Number(event.target.value))} /></label>;
  }
  function toggle(label: string, checked: boolean, change: () => void) {
    return <div className="studio-actions"><span>{label}</span><button type="button" className="studio-slide-switch" role="switch" aria-label={label} aria-checked={checked} onClick={change}><span aria-hidden="true" /></button></div>;
  }
  function anchorRows(label: string, rows: Array<[number, number]>, change: (rows: Array<[number, number]>) => void, max = 1e12) {
    return <div><h4>{label}</h4>{rows.map(([at, value], index) => <div className="studio-filter-band" key={index}>
      {number("量/小时", at, next => change(rows.map((row, i) => i === index ? [next, row[1]] : row)), 0, max, "1")}
      {number("对应指数", value, next => change(rows.map((row, i) => i === index ? [row[0], next] : row)))}
    </div>)}</div>;
  }
  return <section className="studio-filter-settings" aria-labelledby="filter-settings-heading">
    <h2 id="filter-settings-heading">内容筛选</h2><p className="studio-caption">一份基础分析，两套用途。调数字只在本地重算，不重新分析正文。当前规则版本 {form.version}。</p>
    <form onSubmit={save}><fieldset disabled={busy} className="studio-filter-fields">
      {!v2 && <p className="studio-caption">当前版本缺少 editorial-v2 参数，请载入最新规则后再修改。</p>}
      <div className="studio-filter-policy-grid">
        <section><h3>公开新闻 · editorial-v2</h3><p className="studio-caption">热度、兴趣、影响优先；精选不再要求实用或教程。符合范围但不够精选的新闻仍可进入全部动态。行业参考要求S≥50、I≥50、D≥50、E≥60，并受每日独立事件20%额度限制；试算显示语义资格，实际发布还检查额度。经核实的AI或影视出圈走独立通道，不受普通分数与参考额度限制。</p>
          <div className="studio-filter-numbers">{v2 && (["interest", "impact", "substance", "practical", "freshness", "heat"] as const).map(name => <div key={name}>{number(`${labels[name]}权重`, v2.public.weights[name],
            next => editEditorial({ ...v2, public: { ...v2.public, weights: { ...v2.public.weights, [name]: next } } }))}</div>)}</div>
          <p className="studio-caption">合计 {num(publicTotal, 1)} / 100</p>
          {v2 && <div className="studio-filter-numbers">
            {number("普通公开 S≥", v2.public.all.S, value => editEditorial({ ...v2, public: { ...v2.public, all: { ...v2.public.all, S: value } } }))}
            {number("普通公开 B≥", v2.public.all.B, value => editEditorial({ ...v2, public: { ...v2.public, all: { ...v2.public.all, B: value } } }))}
            {number("普通公开 I≥", v2.public.all.I, value => editEditorial({ ...v2, public: { ...v2.public, all: { ...v2.public.all, I: value } } }))}
            {number("普通公开 D≥", v2.public.all.D, value => editEditorial({ ...v2, public: { ...v2.public, all: { ...v2.public.all, D: value } } }))}
            {number("普通精选 S≥", v2.public.selected.S, value => editEditorial({ ...v2, public: { ...v2.public, selected: { ...v2.public.selected, S: value } } }))}
            {number("普通精选 B≥", v2.public.selected.B, value => editEditorial({ ...v2, public: { ...v2.public, selected: { ...v2.public.selected, B: value } } }))}
            {number("普通精选 I≥", v2.public.selected.I, value => editEditorial({ ...v2, public: { ...v2.public, selected: { ...v2.public.selected, I: value } } }))}
            {number("普通精选 D≥", v2.public.selected.D, value => editEditorial({ ...v2, public: { ...v2.public, selected: { ...v2.public.selected, D: value } } }))}
            {number("缺测补分公开 B≥", v2.public.all.compensatedB, value => editEditorial({ ...v2, public: { ...v2.public, all: { ...v2.public.all, compensatedB: value } } }))}
            {number("缺测补分精选 B≥", v2.public.selected.compensatedB, value => editEditorial({ ...v2, public: { ...v2.public, selected: { ...v2.public.selected, compensatedB: value } } }))}
          </div>}
          {v2 && <div className="studio-filter-numbers">
            {number("通用AI S≥", v2.public.general.S, value => editEditorial({ ...v2, public: { ...v2.public, general: { ...v2.public.general, S: value } } }))}
            {number("通用AI M≥", v2.public.general.M, value => editEditorial({ ...v2, public: { ...v2.public, general: { ...v2.public.general, M: value } } }))}
            {number("通用AI I≥", v2.public.general.I, value => editEditorial({ ...v2, public: { ...v2.public, general: { ...v2.public.general, I: value } } }))}
            {number("通用AI D≥", v2.public.general.D, value => editEditorial({ ...v2, public: { ...v2.public, general: { ...v2.public.general, D: value } } }))}
            {number("通用AI 缺测B≥", v2.public.general.compensatedB, value => editEditorial({ ...v2, public: { ...v2.public, general: { ...v2.public.general, compensatedB: value } } }))}
            {number("重大 M≥", v2.public.major.M, value => editEditorial({ ...v2, public: { ...v2.public, major: { ...v2.public.major, M: value } } }))}
            {number("重大 I≥", v2.public.major.I, value => editEditorial({ ...v2, public: { ...v2.public, major: { ...v2.public.major, I: value } } }))}
            {number("重大 D≥", v2.public.major.D, value => editEditorial({ ...v2, public: { ...v2.public, major: { ...v2.public.major, D: value } } }))}
          </div>}
        </section>
        <section><h3>内部选题 · editorial-v2</h3><p className="studio-caption">方向综合后独立评分。热度与时效由代码计算，事实、收益和行业影响仍需材料支撑。</p>
          <div className="studio-filter-numbers">{v2 && (["heat", "interest", "impact", "evidence", "distinctiveness", "practical", "freshness"] as const).map(name => <div key={name}>{number(`${labels[name]}权重`, v2.internal.weights[name],
            next => editEditorial({ ...v2, internal: { ...v2.internal, weights: { ...v2.internal.weights, [name]: next } } }))}</div>)}</div>
          <p className="studio-caption">合计 {num(internalTotal, 1)} / 100</p>
          {v2 && <div className="studio-filter-numbers">
            {number("方向 I≥", v2.internal.normal.I, value => editEditorial({ ...v2, internal: { ...v2.internal, normal: { ...v2.internal.normal, I: value } } }))}
            {number("方向 E≥", v2.internal.normal.E, value => editEditorial({ ...v2, internal: { ...v2.internal, normal: { ...v2.internal.normal, E: value } } }))}
            {number("方向 S≥", v2.internal.normal.S, value => editEditorial({ ...v2, internal: { ...v2.internal, normal: { ...v2.internal.normal, S: value } } }))}
            {number("方向缺测补分 B≥", v2.internal.normal.compensatedB, value => editEditorial({ ...v2, internal: { ...v2.internal, normal: { ...v2.internal.normal, compensatedB: value } } }))}
          </div>}
          <Link to="/admin/studio/topics/columns">编辑栏目含义和筛选标准</Link>
        </section>
      </div>
      <section><h3>出圈与热度 · editorial-v2</h3><p className="studio-caption">热度是配置观察范围内的确定性指数，不是全网真值。未知热度使用明示占位40；热点与头条只读取新鲜实测值。</p>
        {v2 && <div className="studio-filter-numbers">
          {number("热度半衰期（小时）", v2.heat.halfLifeHours, value => editEditorial({ ...v2, heat: { ...v2.heat, halfLifeHours: value } }), 1, 168)}
          {number("缺测热度占位", v2.heat.decisionPlaceholder, value => editEditorial({ ...v2, heat: { ...v2.heat, decisionPlaceholder: value } }))}
          {number("出圈独立报道主体", v2.breakout.reports, value => editEditorial({ ...v2, breakout: { ...v2.breakout, reports: value } }), 1, 1000, "1")}
          {number("出圈播放量门槛", v2.breakout.views, value => editEditorial({ ...v2, breakout: { ...v2.breakout, views: value } }), 1, 1e12, "1")}
          {number("出圈视频作者至少", v2.breakout.authors, value => editEditorial({ ...v2, breakout: { ...v2.breakout, authors: value } }), 1, 1000, "1")}
          {number("指标新鲜时限（小时）", v2.breakout.freshHours, value => editEditorial({ ...v2, breakout: { ...v2.breakout, freshHours: value } }), 1, 168)}
        </div>}
        <div className="studio-filter-policy-grid">{v2 && anchorRows("独立主体有效贡献锚点", v2.heat.reporterAnchors,
          rows => editEditorial({ ...v2, heat: { ...v2.heat, reporterAnchors: rows } }))}
          {v2 && anchorRows("同平台有效播放锚点", v2.heat.videoAnchors,
          rows => editEditorial({ ...v2, heat: { ...v2.heat, videoAnchors: rows } }), 1e12)}</div>
      </section>
      <section><h3>事件时效与窗口 · editorial-v2</h3><p className="studio-caption">按正文有依据的事件/进展时间计算；原创测评可用首次发布时间，转载与采集时间不刷新旧闻。</p>
        {v2 && <div className="studio-filter-policy-grid">{anchorRows("时效锚点（小时 → 分值）", v2.freshness.anchors,
          rows => editEditorial({ ...v2, freshness: { ...v2.freshness, anchors: rows } }), 8760)}
          <div className="studio-filter-numbers">
            {number("有效旧背景分", v2.freshness.validBackfillValue, value => editEditorial({ ...v2, freshness: { ...v2.freshness, validBackfillValue: value } }))}
            {number("时间未知决策分", v2.freshness.unknownDecision, value => editEditorial({ ...v2, freshness: { ...v2.freshness, unknownDecision: value } }))}
            {number("全部动态窗口（小时）", v2.windows.allHours, value => editEditorial({ ...v2, windows: { ...v2.windows, allHours: value } }), 1, 720, "1")}
            {number("精选窗口（小时）", v2.windows.selectedHours, value => editEditorial({ ...v2, windows: { ...v2.windows, selectedHours: value } }), 1, 720, "1")}
            {number("热点窗口（小时）", v2.windows.hotHours, value => editEditorial({ ...v2, windows: { ...v2.windows, hotHours: value } }), 1, 720, "1")}
            {number("日报主窗口（小时）", v2.windows.dailyHours, value => editEditorial({ ...v2, windows: { ...v2.windows, dailyHours: value } }), 1, 720, "1")}
            {number("测评/案例回看（小时）", v2.windows.lateHours, value => editEditorial({ ...v2, windows: { ...v2.windows, lateHours: value } }), 1, 8760, "1")}
            {number("政策回看（小时）", v2.windows.policyHours, value => editEditorial({ ...v2, windows: { ...v2.windows, policyHours: value } }), 1, 8760, "1")}
          </div></div>}
      </section>
      <section><h3>日报头条 · editorial-v2</h3><p className="studio-caption">头条先选后编排：只按新鲜实测热度；接近时才比较影响、兴趣与操作性。观察不足时按新闻价值兜底并记录原因。</p>
        {v2 && <div className="studio-filter-numbers">
          {number("接近带最大差", v2.daily.headlineBandMax, value => editEditorial({ ...v2, daily: { ...v2.daily, headlineBandMax: value } }))}
          {number("接近带比例", v2.daily.headlineBandRatio, value => editEditorial({ ...v2, daily: { ...v2.daily, headlineBandRatio: value } }), 0, 1, "0.01")}
          {number("可比原始量比例", v2.daily.volumeRatio, value => editEditorial({ ...v2, daily: { ...v2.daily, volumeRatio: value } }), 0, 1, "0.01")}
          {number("观察不足热度阈值", v2.daily.emergencyHeat, value => editEditorial({ ...v2, daily: { ...v2.daily, emergencyHeat: value } }))}
        </div>}
      </section>
      <section><h3>栏目公开归属</h3><p className="studio-caption">自定义栏目可映射至公开四栏；未映射的合格新闻仍可进入全部动态。</p><div className="studio-filter-numbers">
        {columns.filter(column => column.enabled).map(column => <label key={column.id}>{column.name}<select value={form.columnMapping[column.id] ?? ""}
          onChange={event => edit({ ...form, columnMapping: { ...form.columnMapping, [column.id]: event.target.value as FilterPolicy["columnMapping"][string] || null } })}>
          <option value="">不指定公开栏目</option>{Object.entries(publicColumns).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>)}</div></section>
      <div className="studio-actions studio-filter-savebar"><button type="button" onClick={() => void preview()} disabled={!validWeights}>试算最近120小时</button>
        <button className="studio-primary" disabled={!validWeights || trialKey !== key}>保存这版规则</button><button type="button" onClick={() => void refresh()}>载入最新规则</button></div>
    </fieldset></form><p className="studio-caption" role="status">{busy ? "正在处理…" : message || "修改后先试算，再保存。历史结果保留原规则。"}</p>
    {trial && <section className="studio-filter-trial" aria-label="规则试算结果"><h3>最近120小时试算</h3><p className="studio-caption">公开去向仅表示评分候选，实际发布还需通过公开权限检查。现有方向只重算分数与排序，不改标题和引用。</p>
      <h4>材料变化 · {trial.total}条</h4><div className="studio-filter-results"><ul>{trial.rows.map(row => <li key={row.materialId}><Link to={`/admin/studio/intelligence/${encodeURIComponent(row.materialId)}`}>{row.title}</Link>
        <p>公开 {num(row.before.public.total, 2)} → {num(row.after.public.total, 2)} · {destinations[row.before.public.destination]} → {destinations[row.after.public.destination]}</p>
        <p className="studio-caption">内部 {num(row.before.internal.total, 2)} → {num(row.after.internal.total, 2)} · 排名 {row.beforeInternalRank} → {row.afterInternalRank}</p></li>)}</ul>
        {!trial.rows.length && <p className="studio-caption">最近120小时还没有材料。已有结果准备好后可再次试算。</p>}</div>
      <nav className="studio-pagination" aria-label="材料试算分页"><button type="button" disabled={busy || trial.page <= 1} onClick={() => void preview(trial.page - 1, trial.directionPage)}>上一页</button><span>第 {trial.page} 页</span>
        <button type="button" disabled={busy || !trial.hasMore} onClick={() => void preview(trial.page + 1, trial.directionPage)}>下一页</button></nav>
      <h4>已形成方向 · {trial.directionTotal}个</h4><div className="studio-filter-results"><ul>{trial.directions.map(row => <li key={row.id}><strong>{row.title}</strong>
        <p>方向分 {num(row.before.score.total, 2)} → {num(row.after.score.total, 2)} · 排名 {row.beforeRank} → {row.afterRank}</p>
        <p className="studio-caption">{columns.find(column => column.id === row.columnId)?.name ?? row.columnId} · {row.after.score.eligible ? "符合方向门槛" : "暂不符合方向门槛"}</p></li>)}</ul>
        {!trial.directions.length && <p className="studio-caption">当前尚未形成方向；新闻评分试算仍然有效。</p>}</div>
      <nav className="studio-pagination" aria-label="方向试算分页"><button type="button" disabled={busy || trial.directionPage <= 1} onClick={() => void preview(trial.page, trial.directionPage - 1)}>上一页</button><span>第 {trial.directionPage} 页</span>
        <button type="button" disabled={busy || !trial.directionHasMore} onClick={() => void preview(trial.page, trial.directionPage + 1)}>下一页</button></nav>
    </section>}
  </section>;
}
