import { modelProfileFor, type ModelProfile } from "./model-routing.ts";
import type { z } from "zod";
import { sql } from "@aihot/backend/db";
import { chatJson, escapeControlCharsInStrings, type ChatJsonOptions } from "@aihot/backend/providers/llm";
import { credential } from "@aihot/backend/config";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { Conflict } from "@aihot/backend/audit";
import { modelConnection, modelConnectionSecret } from "./model-connection.ts";
import { modelWorkAllowed } from "./model-operations.ts";
import { QueueDeferred } from "@aihot/backend/jobs/queue";
import { ProviderRejectedError, logicalKeyFor } from "@aihot/backend/providers/receipts";
import { STUDIO_MODEL } from "../contracts.ts";

type Capability = "studioMaterialAnalysis" | "studioTopicGeneration" | "studioTopicReview" | "studioWriting" | "studioReferenceVision";
const connectionIdentity = (version: number, baseUrl: string, model: string) => sha256(stableJson({ version, baseUrl, model }));
const environmentIdentity = () => sha256(stableJson({ model: STUDIO_MODEL, baseUrl: credential("models", "LLM_BASE_URL"), policy: "studio-flash-only-v1" }));
/** A non-secret identity of the effective analysis service, model and configuration version. */
export async function materialAnalysisModelIdentity(purpose = "studio_material_analysis") {
  const basic = modelProfileFor(purpose) === "basic" ? await modelConnection("basic") : null, connection = basic?.version ? basic : await modelConnection();
  return connection.version ? (basic?.version ? "basic:" : "") + connectionIdentity(connection.version, connection.baseUrl, connection.analysisModel)
    : environmentIdentity();
}
async function beforeModelCall() {
  if (!await modelWorkAllowed()) throw new QueueDeferred("模型调用已暂停或启动配置未允许调用");
}
/** No image capability is inferred from a text model's name. */
export async function referenceVisionModel() {
  const connection = await modelConnection('basic');
  if (connection.state !== "saved" || !connection.visionModel || !connection.visionPrice) throw new Conflict("请先配置支持图片的图像模型和费用估算，再开启深度分析");
  return { model: connection.visionModel, price: connection.visionPrice, identity:'basic:'+connectionIdentity(connection.version, connection.baseUrl, connection.visionModel) };
}
/** Studio-specific selection/credential Adapter; receipts, schema checks and budgets stay in the engine. */
export async function studioChatJson<S extends z.ZodType>(capability: Capability, options: Omit<ChatJsonOptions<S>, "model" | "connection"> & { expectedIdentity?: string }) {
  const callerBeforeCall = options.beforeCall;
  if (capability === "studioReferenceVision") await referenceVisionModel();
  const beforeCall = async () => { await beforeModelCall(); await callerBeforeCall?.(); };
  options = { ...options, promptVersion: `${options.promptVersion}:media-observations-v1`, system: options.system + "只返回任务要求的合法JSON对象，不输出Markdown代码围栏或分析过程。" +
    "媒体观察约束：transcript.rhythm为本地信号测量。低能量不等于说话停顿，背景音乐可能掩盖停顿；audio时间基准decoded_audio只覆盖实际解码音轨，不能把音轨结束后的画面当实测静音。" +
    "采样画面变化不等于精确切镜：visual以首帧为零点、每0.5秒采样，运动/字幕/闪光可触发，短镜头可能漏掉；须说明sampledUntilSeconds、truncated及缺失字段，不能声称完整画面理解。" +
    "缺少rhythm或其中audio/visual为null表示没有该项观察，不能从ASR断句或少量关键帧补造语音/画面节奏。不能推断完播率、留存、收益或博主动机已被证实。" +
    "仅在任务需要表达参考时，结合实际正文、时间段和可用观察概括开头、展开和结尾；每项给出对应材料或时间依据，将可观察特征与可能作用分开，缺少证据明确说明。不能把风格样本中的经历、事实或口头禅搬进新稿。" };
  const requestedProfile = modelProfileFor(options.purpose);
  const basicConfigured = requestedProfile === "basic" && (await modelConnection("basic")).version > 0;
  const profile: ModelProfile = basicConfigured ? "basic" : "creative";
  let connection = await modelConnectionSecret(profile);
  const fromEnvironment = !connection;
  if (!connection) {
    if (capability === "studioReferenceVision") throw new Conflict("图像模型连接未配置");
    const baseUrl = credential("models", "LLM_BASE_URL"), apiKey = credential("models", "LLM_API_KEY");
    if (!baseUrl || !apiKey) throw new Conflict("Flash模型连接未配置，请在设置中保存服务地址和API Key");
    connection = { version: 0, baseUrl, apiKey, sealedKey: null, analysisModel: STUDIO_MODEL, qualityModel: STUDIO_MODEL };
  }
  if (capability === "studioReferenceVision" && (!connection.visionModel || !connection.visionPrice)) throw new Conflict("图像模型或费用配置已改变，请重新准备参考");
  const model = capability === "studioReferenceVision" ? connection.visionModel! : connection.analysisModel;
  if (options.expectedIdentity && (fromEnvironment ? environmentIdentity() : (profile === "basic" ? "basic:" : "") + connectionIdentity(connection.version, connection.baseUrl, model)) !== options.expectedIdentity) {
    if (capability === "studioReferenceVision") throw new Conflict("图像模型配置已改变，请重新准备参考");
    throw new QueueDeferred("材料分析模型已变更，等待按新配置处理");
  }
  // Explicit gateway estimates win. Official and legacy environment connections use the
  // conservative Flash peak rate; the UI identifies this as an estimate, never a bill.
  const configuredPrice = capability === "studioReferenceVision" ? connection.visionPrice : connection.analysisPrice;
  const price = configuredPrice ?? (fromEnvironment || new URL(connection.baseUrl).origin === "https://api.deepseek.com" ? { inputPerMillion: 2, outputPerMillion: 8 } : null);
  if (!price) throw new Conflict("此服务或模型尚未配置费用估算，未开始模型请求");
  const shortStructured = capability === "studioMaterialAnalysis" || capability === "studioReferenceVision" || options.subject.startsWith("studio-preview:");
  const agnes = profile === "basic" && new URL(connection.baseUrl).hostname === "api.agnes-ai.cn";
  const extra = profile === "basic" ? (agnes ? { chat_template_kwargs: { enable_thinking: false } } : {}) : { thinking: { type: shortStructured ? "disabled" : "enabled" } };
  const connectionId = fromEnvironment ? `studio-environment:${environmentIdentity()}` : `studio-model-${profile === "basic" ? "basic-" : ""}connection:${connection.version}`;
  // Re-validate an already-paid response only for the exact frozen material/model context.
  // Parser compatibility must not cause a second network request or accept mismatched evidence.
  if (["studio_material_analysis", "studio_news_title_translation"].includes(options.purpose) && typeof options.user === "string") {
    let sameMaterialIdentity=false;
    try { sameMaterialIdentity=options.purpose==='studio_material_analysis'&&!!options.expectedIdentity&&JSON.parse(options.user).analysisContext?.modelIdentity===options.expectedIdentity; } catch { /* Non-JSON legacy inputs only use the exact logical key. */ }
    const key = logicalKeyFor({service:"llm",model,purpose:options.purpose,subject:options.subject,attemptTag:options.attemptTag,
      identity:{model,promptVersion:options.promptVersion,system:sha256(options.system),user:sha256(options.user),temperature:options.temperature??0.2,
        maxTokens:Math.max(options.maxTokens??1500,512)+(shortStructured?0:4000),extra,connection:connectionId}});
    const rows = await sql<{id:number;response:{choices?:Array<{message?:{content?:string}}>};usage:Record<string,unknown>|null}[]>`SELECT id,response,usage FROM receipts
      WHERE purpose=${options.purpose} AND subject=${options.subject} AND model=${model} AND status='failed'
        AND error LIKE 'unusable output:%' AND response IS NOT NULL AND (logical_key=${key}
          OR (${sameMaterialIdentity}
            AND request->>'userHash'=${sha256(options.user)})) ORDER BY id DESC LIMIT 4`;
    for (const row of rows) {
      try {
        const text=row.response.choices?.[0]?.message?.content??"", start=text.indexOf("{"), end=text.lastIndexOf("}");
        const parsed=options.schema.safeParse(options.parse?options.parse(text):JSON.parse(escapeControlCharsInStrings(text.slice(start,end+1))));
        if (parsed.success) return {data:parsed.data,receiptId:Number(row.id),reused:true,model,usage:row.usage};
      } catch { /* Invalid saved output still requires an explicit bounded retry. */ }
    }
  }
  const activeConnection = connection;
  await beforeCall();
  return chatJson({ ...options, beforeCall, model: "studio-connection", connection: {
    model, service: "llm", identity: connectionId, jsonMode: profile !== "basic", price, extra,
    ...(!shortStructured ? { reasoningTokens: 4000 } : {}),
    async request(body, signal) {
      const serialized = JSON.stringify(body);
      if (capability === "studioReferenceVision" && Buffer.byteLength(serialized) > 2 * 1024 ** 2)
        throw new ProviderRejectedError("参考分析的完整请求超过2MiB，未发送；请减少参考视频", null, false);
      try {
        const result = await guardedFetch(`${activeConnection.baseUrl.replace(/\/+$/, "")}/chat/completions`, { method: "POST", route: "direct", redirect: "error",
          headers: { authorization: `Bearer ${activeConnection.apiKey}`, "content-type": "application/json" }, body: serialized,
          signal, timeoutMs: options.timeoutMs ?? 120000, maxBytes: 2 * 1024 ** 2 });
        const text = result.text();
        if (result.status < 200 || result.status >= 300) return new Response('{"error":"模型服务拒绝请求"}', { status: result.status, headers: { "content-type": "application/json" } });
        if (text.includes(activeConnection.apiKey) || text.includes(JSON.stringify(activeConnection.apiKey).slice(1, -1))) throw new Error("Provider echoed a credential");
        // Check the representation that receipts/business code will actually decode, including
        // JSON embedded in model content. An iterative bounded walk also covers property names.
        const pending: unknown[] = [JSON.parse(text)];
        let inspected = 0;
        while (pending.length) {
          if (++inspected > 100_000) throw new Error("Provider response is too complex");
          const value = pending.pop();
          if (typeof value === "string") {
            if (value.includes(activeConnection.apiKey)) throw new Error("Provider echoed a credential");
            const start = value.indexOf("{"), end = value.lastIndexOf("}");
            const candidate = start >= 0 && end > start ? value.slice(start, end + 1) : value;
            let embedded: unknown;
            try { embedded = JSON.parse(candidate); }
            catch {
              // Match the existing model parser's permitted control-character repair.
              try { embedded = JSON.parse(escapeControlCharsInStrings(candidate)); } catch { continue; }
            }
            if (embedded !== value) pending.push(embedded);
          } else if (value && typeof value === "object") {
            for (const [name, item] of Object.entries(value)) pending.push(name, item);
          }
        }
        return new Response(text, { status: result.status, headers: { "content-type": "application/json" } });
      } catch { throw new Error("模型服务请求失败，请检查服务地址、密钥、网络或响应大小"); }
    },
  } });
}
