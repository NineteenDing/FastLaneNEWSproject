import { useState } from "react";
import type { CreatorContent } from "../contracts";
import { creatorMetricNames, creatorMetrics } from "./creator-metrics";

const clock = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Hong_Kong", dateStyle: "short", timeStyle: "medium" });
const amount = new Intl.NumberFormat("zh-CN");
const axis = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });
type Metric = ReturnType<typeof creatorMetricNames>[number][0];
const valid = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** One publication's actual snapshots, never a cross-platform heat score or an interpolated count. */
export function MetricHistory({ observations, kind, snapshot = false }: {
  observations: CreatorContent["observations"]; kind?: CreatorContent["kind"]; snapshot?: boolean;
}) {
  const [chosen, choose] = useState<Metric>("views");
  const rows = observations.filter(row => Number.isFinite(Date.parse(row.observedAt)))
    .toSorted((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt)).slice(-100);
  const names = creatorMetricNames(kind)
    .filter(([key]) => rows.some(row => valid(row.metrics[key])));
  const [metric, label] = names.find(([key]) => key === chosen) ?? names[0] ?? ["views", "播放"];
  const seen = rows.filter(row => valid(row.metrics[metric]));
  const first = rows[0], last = rows.at(-1);
  const start = first ? Date.parse(first.observedAt) : 0, end = last ? Date.parse(last.observedAt) : 0;
  const top = Math.max(1, ...seen.map(row => row.metrics[metric]!));
  const x = (row: typeof rows[number]) => 2 + (Date.parse(row.observedAt) - start) / (end - start || 1) * 96;
  const y = (row: typeof rows[number]) => 96 - row.metrics[metric]! / top * 92;
  let connected = false;
  const path = rows.map(row => {
    if (!valid(row.metrics[metric])) { connected = false; return ""; }
    const command = `${connected ? "L" : "M"}${x(row)},${y(row)}`; connected = true; return command;
  }).join(" ");
  const drawable = seen.length >= 2 && new Set(seen.map(row => Date.parse(row.observedAt))).size >= 2;
  return <div className="studio-metric-history" role="region" aria-label="作品热度变化">
    <p className="studio-caption">{snapshot ? "冻结时保存的观察" : "实际采集的观察"} · 本视图仅显示最近 100 次 · 香港时间。仅看同一作品，不跨平台比较，不推算完播率。</p>
    {names.length > 0 && <label className="studio-metric-control">查看指标 <select aria-label="热度指标" value={metric} onChange={event => choose(event.target.value as Metric)}>
      {names.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
    </select></label>}
    {drawable ? <figure>
      <figcaption>{label}变化 · {seen.length} 次有效观察</figcaption>
      <div className="studio-metric-plot">
        <div className="studio-metric-axis" aria-hidden="true"><span>{axis.format(top)}</span><span>{axis.format(top / 2)}</span><span>0</span></div>
        <div className="studio-metric-canvas" role="img" aria-label={`${label}随观察时间变化，精确数值见下方记录`}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {[4, 50, 96].map(position => <line key={position} className="studio-metric-grid" x1="0" x2="100" y1={position} y2={position} vectorEffect="non-scaling-stroke" />)}
          <path d={path} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        </svg>
        {seen.map((row, index) => <span key={index} className="studio-metric-point" style={{ left: `${x(row)}%`, top: `${y(row)}%` }} aria-hidden="true"
          title={`${clock.format(new Date(row.observedAt))}：${label} ${amount.format(row.metrics[metric]!)}`} />)}
        </div>
      </div>
      <div className="studio-metric-dates"><time dateTime={first!.observedAt}>{clock.format(new Date(first!.observedAt))}</time><time dateTime={last!.observedAt}>{clock.format(new Date(last!.observedAt))}</time></div>
      <p className="studio-caption">点是采集时的数值，连线仅辅助阅读，不代表期间持续测量；缺失值处断开，不补零。数值下降可能来自平台修正。</p>
    </figure> : <p className="studio-caption">{!rows.length ? "暂无热度观察记录。" : !seen.length ? "平台尚未提供可绘制的互动指标。" : "该指标尚不足两个不同时间的有效观察，暂不绘制变化图。"}</p>}
    {rows.length > 0 && <section><h3>精确记录（{rows.length} 次）</h3>
      <ul>{rows.map((row, index) => <li key={index}><time dateTime={row.observedAt}>{clock.format(new Date(row.observedAt))}</time>：{creatorMetrics(row.metrics, kind)}</li>)}</ul>
    </section>}
  </div>;
}
