import { useEffect, useRef, useState } from "react";
import type { RuntimeComponents } from "../contracts";

const names = { files_present: "文件就位 · 待实测", missing: "文件缺失", configured: "已配置 · 待实测", invalid: "配置无效", not_configured: "尚未配置" };
export function RuntimeComponentCheck() {
  const [result, setResult] = useState<RuntimeComponents | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  async function check() {
    active.current?.abort(); const controller = new AbortController(); active.current = controller; setLoading(true); setError("");
    try {
      const response = await fetch("/api/admin/studio/runtime-components", { cache: "no-store", credentials: "same-origin", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) });
      if (!response.ok) throw new Error("unavailable");
      const value = await response.json() as RuntimeComponents;
      if (!controller.signal.aborted) setResult(value);
    } catch { if (!controller.signal.aborted) setError("组件文件暂时无法检查，原结果保留，请重试。"); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  return <section className="studio-settings-panel studio-runtime-check" aria-label="采集与转写组件"><h3>采集与转写组件</h3>
    <p className="studio-caption">只检查服务器上的本地文件，不加载模型、不启动浏览器、不访问平台。文件就位不代表依赖版本、平台登录或转写质量已验证。</p>
    <button type="button" disabled={loading} onClick={() => void check()}>{loading ? "正在检查…" : result ? "重新检查组件文件" : "检查组件文件"}</button>
    {error && <p className="studio-notice" role="alert">{error}</p>}
    {result && <><p className="studio-caption">检查时间：{new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Hong_Kong", dateStyle: "short", timeStyle: "short" }).format(new Date(result.checkedAt))}</p>
      <dl className="studio-component-list">{result.rows.map(row => <div key={row.id}><dt>{row.name}<span className="studio-caption">{names[row.state]}</span></dt><dd>{row.detail}</dd></div>)}</dl></>}
  </section>;
}
