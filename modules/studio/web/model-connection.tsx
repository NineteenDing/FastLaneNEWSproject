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

function ConnectionForm({ connection, basic = false }: { connection: ModelConnection; basic?: boolean }) {
  const endpoint = basic ? "/api/admin/studio/model-basic-connection" : "/api/admin/studio/model-connection";
  const prefix = basic ? "basic" : "creative";
  const [modelName, setModelName] = useState(connection.analysisModel);
  const action = useAdminAction("studio-layout");
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl), [apiKey, setApiKey] = useState("");
  const [analysisInput, setAnalysisInput] = useState(connection.analysisPrice?.inputPerMillion.toString() ?? "");
  const [analysisOutput, setAnalysisOutput] = useState(connection.analysisPrice?.outputPerMillion.toString() ?? "");
  const [visionEnabled, setVisionEnabled] = useState(!!connection.visionModel);
  const price = (input: string, output: string) => input.trim() || output.trim() ? { inputPerMillion: Number(input), outputPerMillion: Number(output) } : null;
  async function save(event: FormEvent) {
    event.preventDefault();
    const result = await action.run("PUT", endpoint, { version: connection.version, baseUrl, analysisModel: basic ? modelName : STUDIO_MODEL, qualityModel: basic ? modelName : STUDIO_MODEL,
      ...(apiKey ? { apiKey } : {}), analysisPrice: price(analysisInput, analysisOutput),
      visionModel: basic && visionEnabled ? modelName : null },
      { success: "模型连接已保存，调用开关保持不变" });
    if (result) setApiKey("");
  }
  async function clear() {
    if (!window.confirm("清除保存的API Key？模型名称、已有选题和稿件会保留。")) return;
    const result = await action.run("PUT", endpoint, { version: connection.version, baseUrl: connection.baseUrl,
      analysisModel: connection.analysisModel, qualityModel: connection.qualityModel, apiKey: "", analysisPrice: connection.analysisPrice, qualityPrice: connection.qualityPrice },
      { success: "API Key已清除，已有内容保留" });
    if (result) setApiKey("");
  }
  return <section className="studio-session-settings" aria-labelledby={`${prefix}-connection-title`}>
    <h2 id={`${prefix}-connection-title`}>{basic ? "基础处理 API" : "创作决策 API · DeepSeek"}</h2>
    <p className="studio-notice">{basic ? "初筛、事实与摘要、分类、新闻及榜单翻译、日报文字编排。可单独设置兼容API的模型、地址、Key和单价。" : "正式选题综合、候选方向、二审与裁决、口播稿及风格学习，保留现有DeepSeek连接。"}</p>
    {basic && connection.version === 0 && <p className="studio-caption">基础API尚未配置：为保持新闻处理连续，暂用现有创作API；保存后切换，清除已配置Key会暂停基础调用，不自动付费回退。</p>}
    <p className="studio-caption">保存连接不会启用任务，也不会发送测试请求。</p>
    <p className="studio-caption">{connection.environmentConfigured ? "正在使用服务器运行配置中的既有连接与Key；网页尚未另存连接。" : connection.state === "saved" ? "API Key已保存，仅供服务器使用；连接是否可用以任务实际结果为准。" : connection.state === "unreadable" ? "API Key无法解密，请重新填写后保存。" : "尚未保存API Key。"}</p>
    <form className="studio-model-form" onSubmit={save}>
      <div className="studio-wide"><label>API基础地址<input type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} maxLength={2048} required disabled={action.busy} aria-describedby={`${prefix}-url-help`} /></label>
        <p id={`${prefix}-url-help`} className="studio-caption">填写HTTPS地址，例如 https://api.deepseek.com/v1。不要填写 /chat/completions。</p></div>
      <label className="studio-wide">API Key<input type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={event => setApiKey(event.target.value)} maxLength={4096}
        required={connection.state !== "saved"} disabled={action.busy} placeholder={connection.state === "saved" ? "留空保留现有Key，填写新值可替换" : "填写服务商提供的API Key"} /></label>
      <label className="studio-wide">{basic ? "基础模型名称" : "DeepSeek模型"}<input value={basic ? modelName : STUDIO_MODEL} readOnly={!basic} onChange={event => setModelName(event.target.value)} required aria-describedby={`${prefix}-model-help`} /></label>
      <p id={`${prefix}-model-help`} className="studio-caption studio-wide">{basic ? "填写服务商的准确模型ID，需支持兼容Chat Completions的JSON文本响应；不会自动升级到昂贵模型。" : "创作流程继续使用 deepseek-flash，不因修改基础API而切换。"}</p>
      <section className="studio-settings-panel studio-wide" aria-label="兼容服务与费用估算"><h3>兼容服务与费用估算</h3>
        <p className="studio-caption">两套API分别按各自单价记录预算。填写人民币元／百万tokens；不抵扣缓存优惠，实际扣费以服务商账单为准。</p>
        <p className="studio-caption">更换服务商时需要重新填写Key。以下单位均为人民币元／百万tokens。</p>
        <div className="studio-model-form">
          <label>输入单价<input type="number" min={0} max={1_000_000} step="any" value={analysisInput} onChange={event => setAnalysisInput(event.target.value)} required={basic || !!analysisOutput} disabled={action.busy} /></label>
          <label>输出单价<input type="number" min={0} max={1_000_000} step="any" value={analysisOutput} onChange={event => setAnalysisOutput(event.target.value)} required={basic || !!analysisInput} disabled={action.busy} /></label>
        </div>
      </section>
      {basic && <section className="studio-settings-panel studio-wide" aria-label="参考视频关键帧分析（可选）"><h3>参考视频关键帧分析（可选）</h3>
        <div className="studio-actions"><span id="flash-vision-label">允许基础模型图片分析</span><button type="button" className="studio-slide-switch" role="switch" aria-labelledby="flash-vision-label" aria-checked={visionEnabled} disabled={action.busy} onClick={() => setVisionEnabled(value => !value)}><span aria-hidden="true" /></button></div>
        <p className="studio-caption">关键帧使用本基础API的模型与费率，Agnes支持多模态。选题、二审和写稿仍使用创作API。此开关不会启用博主采集。</p>
        <p className="studio-caption">保存不发送图片。仅在采纳选题时明确开启才准备分析；最多2条视频、每条3帧，估算超过2元不调用。相同参考和配置复用已完成结果，实际扣费以服务商为准。</p>
      </section>
      }<div className="studio-actions studio-wide"><button className="studio-primary" disabled={action.busy}>{action.busy ? "正在保存…" : "保存模型连接"}</button>
        {connection.state !== "missing" && <button type="button" disabled={action.busy} onClick={clear}>清除API Key</button>}</div>
    </form>
  </section>;
}

export function ModelConnectionSettings({connection,basicConnection,operations,usage,budget}:{connection:ModelConnection;basicConnection:ModelConnection;operations:ModelOperations;usage:ModelUsage;budget:ModelBudgetSettings}) {
 return <><section className="studio-session-settings"><h2>模型任务与费用</h2><ModelTaskControl operations={operations}/><ModelUsageSettings usage={usage} budget={budget}/></section>
 <ConnectionForm key={`basic:${basicConnection.version}`} connection={basicConnection} basic/>
 <ConnectionForm key={`creative:${connection.version}`} connection={connection}/></>;
}
