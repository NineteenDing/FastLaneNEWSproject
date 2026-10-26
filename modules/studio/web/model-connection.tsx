import { useState, type FormEvent } from "react";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import type { ModelBudgetSettings, ModelConnection, ModelOperations, ModelUsage } from "../contracts";
import { STUDIO_MODEL } from "../contracts";
import { ModelUsageSettings } from "./model-usage";

function ModelTaskControl({ operations }: { operations: ModelOperations }) {
  const action = useAdminAction("studio-layout");
  async function change() {
    const enabled = !operations.enabled;
    if (enabled && !window.confirm("启用模型任务后，已排队的分析、选题、审核和写稿会继续处理，并可能产生模型费用。继续启用？")) return;
    await action.run("PUT", "/api/admin/studio/model-operations", { version: operations.version, enabled },
      { success: enabled ? "模型任务已启用，等待后台处理" : "模型任务已暂停，待办与已有内容保留" });
  }
  return <div>
    <div className="studio-actions"><span className="studio-caption">模型任务：{operations.enabled ? "已启用" : operations.runtimeAllowed ? "已暂停" : "启动配置未允许"}</span>
      <button type="button" onClick={change} disabled={action.busy || !operations.runtimeAllowed}>
        {action.busy ? "正在更新…" : operations.enabled ? "暂停模型任务" : "启用模型任务"}</button></div>
    <p className="studio-caption">{operations.runtimeAllowed ? "暂停后不再领取新任务，当前单次请求可完成；恢复后接着处理待办。后台需处于运行状态。"
      : "请先在本机运行配置中允许模型调用并启动后台任务，再重启服务。保存下方连接不会自动启用。"}</p>
  </div>;
}

export function ModelConnectionSettings({ connection, operations, usage, budget }: { connection: ModelConnection; operations: ModelOperations; usage: ModelUsage; budget: ModelBudgetSettings }) {
  const action = useAdminAction("studio-layout");
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl), [apiKey, setApiKey] = useState("");
  const [analysisInput, setAnalysisInput] = useState(connection.analysisPrice?.inputPerMillion.toString() ?? "");
  const [analysisOutput, setAnalysisOutput] = useState(connection.analysisPrice?.outputPerMillion.toString() ?? "");
  const [visionEnabled, setVisionEnabled] = useState(!!connection.visionModel);
  const price = (input: string, output: string) => input.trim() || output.trim() ? { inputPerMillion: Number(input), outputPerMillion: Number(output) } : null;
  async function save(event: FormEvent) {
    event.preventDefault();
    const result = await action.run("PUT", "/api/admin/studio/model-connection", { version: connection.version, baseUrl, analysisModel: STUDIO_MODEL, qualityModel: STUDIO_MODEL,
      ...(apiKey ? { apiKey } : {}), analysisPrice: price(analysisInput, analysisOutput),
      visionModel: visionEnabled ? STUDIO_MODEL : null },
      { success: "模型连接已保存，调用开关保持不变" });
    if (result) setApiKey("");
  }
  async function clear() {
    if (!window.confirm("清除保存的API Key？模型名称、已有选题和稿件会保留。")) return;
    const result = await action.run("PUT", "/api/admin/studio/model-connection", { version: connection.version, baseUrl: connection.baseUrl,
      analysisModel: connection.analysisModel, qualityModel: connection.qualityModel, apiKey: "", analysisPrice: connection.analysisPrice, qualityPrice: connection.qualityPrice },
      { success: "API Key已清除，已有内容保留" });
    if (result) setApiKey("");
  }
  return <section className="studio-session-settings" aria-labelledby="model-connection-title">
    <h2 id="model-connection-title">模型服务</h2>
    <p className="studio-notice">材料分析、选题、审核、口播与风格学习统一使用 DeepSeek Flash，共用一个服务地址、Key和费率。</p>
    <ModelTaskControl operations={operations} />
    <ModelUsageSettings usage={usage} budget={budget} />
    <p className="studio-caption">保存连接不会启用任务，也不会发送测试请求。</p>
    <p className="studio-caption">{connection.state === "saved" ? "API Key已保存，仅供服务器使用；连接是否可用以任务实际结果为准。" : connection.state === "unreadable" ? "API Key无法解密，请重新填写后保存。" : "尚未保存API Key。"}</p>
    <form className="studio-model-form" onSubmit={save}>
      <div className="studio-wide"><label>API基础地址<input type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} maxLength={2048} required disabled={action.busy} aria-describedby="model-url-help" /></label>
        <p id="model-url-help" className="studio-caption">填写HTTPS地址，例如 https://api.deepseek.com/v1。不要填写 /chat/completions。</p></div>
      <label className="studio-wide">API Key<input type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={event => setApiKey(event.target.value)} maxLength={4096}
        required={connection.state !== "saved"} disabled={action.busy} placeholder={connection.state === "saved" ? "留空保留现有Key，填写新值可替换" : "填写服务商提供的API Key"} /></label>
      <label className="studio-wide">Flash模型<input value={STUDIO_MODEL} readOnly aria-describedby="flash-model-help" /></label>
      <p id="flash-model-help" className="studio-caption studio-wide">兼容服务也需要提供 deepseek-flash；系统不会自动切换到Pro或其他模型。</p>
      <section className="studio-settings-panel studio-wide" aria-label="兼容服务与费用估算"><h3>兼容服务与费用估算</h3>
        <p className="studio-caption">官方Flash默认按输入2元、输出8元／百万tokens的高峰单价估算，不抵扣缓存优惠。兼容服务请填写自己的Flash单价；这里只估算费用，实际扣费以服务商账单为准。</p>
        <p className="studio-caption">更换服务商时需要重新填写Key。以下单位均为人民币元／百万tokens。</p>
        <div className="studio-model-form">
          <label>Flash输入单价<input type="number" min={0} max={1_000_000} step="any" value={analysisInput} onChange={event => setAnalysisInput(event.target.value)} required={!!analysisOutput} disabled={action.busy} /></label>
          <label>Flash输出单价<input type="number" min={0} max={1_000_000} step="any" value={analysisOutput} onChange={event => setAnalysisOutput(event.target.value)} required={!!analysisInput} disabled={action.busy} /></label>
        </div>
      </section>
      <section className="studio-settings-panel studio-wide" aria-label="参考视频深度分析（可选）"><h3>参考视频深度分析（可选）</h3>
        <div className="studio-actions"><span id="flash-vision-label">允许Flash图片分析</span><button type="button" className="studio-slide-switch" role="switch" aria-labelledby="flash-vision-label" aria-checked={visionEnabled} disabled={action.busy} onClick={() => setVisionEnabled(value => !value)}><span aria-hidden="true" /></button></div>
        <p className="studio-caption">图片也使用同一个Flash模型与费率。请确认服务商支持图片输入；关闭时普通文本写稿照常使用，修改后保存生效。</p>
        <p className="studio-caption">保存不发送图片。仅在采纳选题时明确开启才准备分析；最多2条视频、每条3帧，估算超过2元不调用。相同参考和配置复用已完成结果，实际扣费以服务商为准。</p>
      </section>
      <div className="studio-actions studio-wide"><button className="studio-primary" disabled={action.busy}>{action.busy ? "正在保存…" : "保存模型连接"}</button>
        {connection.state !== "missing" && <button type="button" disabled={action.busy} onClick={clear}>清除API Key</button>}</div>
    </form>
  </section>;
}
