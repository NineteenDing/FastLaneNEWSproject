import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql, type Tx } from "@aihot/backend/db";
import { audit, Conflict } from "@aihot/backend/audit";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { defineQueue } from "@aihot/backend/modules";
import { ensureQueue, enqueueOn, QueueDeferred } from "@aihot/backend/jobs/queue";
import { completeReceipt } from "@aihot/backend/providers/receipts";
import { currentTopicBatch, currentTopicEvidence, currentWindow } from "./topic-batches.ts";
import { currentColumns, topicAudience } from "./topic-columns.ts";
import { topicPlan } from "./topic-plan.ts";
import { backgroundWorkHasPriority } from "./background-priority.ts";
import { materialAnalysisReadings } from "./material-analysis-state.ts";
import { columnSemanticsKey } from "./column-matching.ts";
import { modelWorkAllowed } from "./model-operations.ts";
import { createModelAdmission } from "./model-admission.ts";
import { analyzeMaterialEvidence, prepareMaterialAnalysis, materialAnalysisCachePolicy } from "./material-analysis.ts";
import { materialInsightPolicy } from "./material-insights.ts";
import { materialAnalysisModelIdentity } from "./studio-model.ts";
import { synthesizeTopicDirections, type TopicSynthesisMaterial } from "./topic-directions.ts";
import { freezeSharedTopicSignals } from "./topic-signals.ts";
import { currentFilterPolicy } from "./filter-settings.ts";
import { rescoreCurrentDirections } from "./filter-scoring.ts";
import type { CurrentTopicPreview, FilterPolicy, TopicBatchMaterial, TopicColumn, TopicMaterialAnalysis } from "../contracts.ts";

type PreviewInput = { startsAt: string; endsAt: string; capturedAt: string; audience: string; columns: TopicColumn[];
  materials: TopicBatchMaterial[]; materialCount: number; modelIdentity: string; synthesisModelIdentity?: string; sharedPolicy?: string; filterPolicy?: FilterPolicy;
  analyses?: Record<string, TopicMaterialAnalysis> };
type Input = PreviewInput & { previous?: { version: number; fingerprint: string; input: PreviewInput; result: NonNullable<CurrentTopicPreview["result"]>; generatedAt: string | null } };
type Stored = { id: string; version: number; fingerprint: string; input: Input; state: Exclude<CurrentTopicPreview["state"], "not_generated">;
  result: CurrentTopicPreview["result"]; generated_at: Date | null; error: string | null; job_id: string | null; run_token: string };
type Job = { id: string; token: string };
function sizeIssue(input: Input) {
  return Buffer.byteLength(JSON.stringify(input), "utf8") > 2 * 1024 ** 2
    ? "完整预览输入（含上版展示）超过2MiB预算，未截断材料；保留原展示并等待正式批次处理" : null;
}
function retainDisplay(snapshot: PreviewInput, existing?: Stored): Input {
  if (!existing) return snapshot;
  const { previous, ...priorInput } = existing.input;
  return { ...snapshot, previous: existing.result ? { version: existing.version, fingerprint: existing.fingerprint, input: priorInput,
    result: existing.result, generatedAt: existing.generated_at?.toISOString() ?? null } : previous };
}
class PreviewStopped extends Error {}
const previewAdmission = createModelAdmission();

export const topicPreviewQueue = defineQueue<Job>({ name: "studio.topic.preview",
  options: { policy: "short", retryLimit: 1, retryDelay: 60, expireInSeconds: 1800 },
  worker: { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 2, groupConcurrency: 1 },
  admission: () => {
    const active = previewAdmission();
    return { canStart: async db => await active.canStart(db) && await backgroundWorkHasPriority(db, "preview") && await active.canStart(db), stop: active.stop };
  },
  async run(jobs) { for (const job of jobs) await generate(job); },
});

/** A private reading never freezes the current window or submits model work. */
export async function currentTopicPreview(): Promise<CurrentTopicPreview> {
  const batch = await currentTopicBatch();
  const [row] = await sql<Stored[]>`SELECT * FROM studio_topic_previews WHERE starts_at = ${batch.startsAt}`;
  const [job] = row?.job_id && !row.result ? await sql`SELECT state FROM pgboss.job WHERE name = ${topicPreviewQueue.name} AND id = ${row.job_id}` : [];
  const interrupted = row && !row.result && !["created", "retry", "active"].includes(job?.state ?? "missing");
  const identity = row ? await materialAnalysisModelIdentity() : null;
  const synthesisIdentity = row ? await materialAnalysisModelIdentity("studio_topic_generation") : undefined;
  const current = row ? await sql.begin("isolation level repeatable read read only", db => capture(db, batch, identity!, synthesisIdentity)) : null;
  const previous = row && !row.result ? row.input.previous : undefined, shownInput = previous?.input ?? row?.input;
  const savedResult = row?.result ?? previous?.result ?? null;
  const result = savedResult && shownInput ? await sql.begin("isolation level repeatable read read only", async db =>
    rescoreCurrentDirections(db, savedResult, shownInput.materials, await currentFilterPolicy(db), new Date())) : savedResult;
  return { ...batch, stale: !!row && current!.fingerprint !== (previous?.fingerprint ?? row.fingerprint), inputIssue: current?.inputIssue ?? (row && current?.fingerprint !== row.fingerprint ? sizeIssue(retainDisplay(current!.snapshot, row)) : null),
    state: interrupted ? "failed" : row?.state ?? "not_generated", result,
    includedMaterialCount: shownInput?.materials.length ?? 0, generatedAt: previous?.generatedAt ?? row?.generated_at?.toISOString() ?? null,
    ...(row && shownInput ? { id: row.id, version: previous?.version ?? row.version, capturedAt: shownInput.capturedAt, columns: shownInput.columns,
      referenceMaterials: shownInput.materials.map(({ id, title, url, source, excerpt, kind, metrics, publishedAt }) => ({ id, title, url, source, excerpt, kind, metrics, publishedAt })),
      error: row.error ?? (interrupted ? "候选草案任务已中断，请检查模型和预算后显式重试" : null) } : {}),
    reviewState: "not_started", modelEnabled: await modelWorkAllowed() };
}

/** Read the exact saved candidate input; overwritten provisional versions never fall back to live facts. */
export async function topicPreviewMaterial(id: string, version: string, materialId: string) {
  z.uuid().parse(id); const expected = z.coerce.number().int().positive().parse(version);
  z.string().regex(/^(news|creator):[A-Za-z0-9_-]+$/).parse(materialId);
  const [row] = await sql<Pick<Stored, "version" | "input">[]>`SELECT version, input FROM studio_topic_previews WHERE id = ${id}`;
  if (!row) return null;
  if (row.input.previous?.version === expected) return row.input.previous.input.materials.find(material => material.id === materialId) ?? null;
  if (row.version !== expected) throw new Conflict("候选草案已更新，请关闭详情并刷新后查看；不会用新正文替换旧版本");
  return row.input.materials.find(material => material.id === materialId) ?? null;
}

/** Compare precisely the current window and rules without changing its ownership or paying for analysis. */
async function capture(db: Tx, window: { startsAt: string; endsAt: string }, modelIdentity: string, synthesisModelIdentity?: string) {
  const columns = await currentColumns(db), all = await currentTopicEvidence(db, window);
  const readings = await materialAnalysisReadings(db, all.map(material=>material.id), true), analyses: Record<string,TopicMaterialAnalysis> = {};
  let materials = all.filter(material => {
    const reading=readings.get(material.id), result=reading?.result;
    if(result?.shared?.scope === "unrelated") return false;
    if(reading?.state === "completed" && result && reading.classification?.state !== "pending"
      && (!result.shared || result.columnSemanticsKey===columnSemanticsKey(columns)))
      analyses[material.id]={materialId:material.id,state:"completed",...result,receiptId:reading.receiptId,error:null};
    return material.body.trim() && ["ok", "collected", "transcribed"].includes(material.bodyState);
  });
  // A rolling draft uses already-understood qualified candidates. The formal cutoff still owns
  // every material; this prevents a live preview from buying another analysis of the entire archive.
  if(Object.values(analyses).some(analysis=>analysis.shared)) {
    const signals=freezeSharedTopicSignals(materials.map(material=>({material,analysis:analyses[material.id]??null})),new Date().toISOString(),
      undefined,undefined,(await currentFilterPolicy(db)).editorial);
    const qualified=new Set(signals?.candidates.filter(candidate=>candidate.path!==null).map(candidate=>candidate.materialId));
    let bytes=0;
    materials=materials.filter(material=>qualified.has(material.id)).sort((a,b)=>b.collectedAt.localeCompare(a.collectedAt)).filter((material,index)=>{
      const size=Buffer.byteLength(JSON.stringify([material,analyses[material.id]]),'utf8');
      if(index>=60 || bytes+size>650000)return false;bytes+=size;return true;
    });
    const included=new Set(materials.map(material=>material.id));
    for(const id of Object.keys(analyses))if(!included.has(id))delete analyses[id];
  }
  const snapshot: Input = { startsAt: window.startsAt, endsAt: window.endsAt, capturedAt: new Date().toISOString(),
    audience: topicAudience, columns, materials, analyses, materialCount: all.length, modelIdentity, synthesisModelIdentity, sharedPolicy: materialAnalysisCachePolicy, filterPolicy: await currentFilterPolicy(db) };
  const inputIssue = sizeIssue(snapshot);
  const keys = inputIssue ? [] : await Promise.all(materials.map(evidence => prepareMaterialAnalysis({ evidence, columns, audience: topicAudience, insightPolicy: materialInsightPolicy, sharedPolicy: snapshot.sharedPolicy }, modelIdentity)));
  const fingerprint = inputIssue ? "preview-input-too-large" : sha256(stableJson({ startsAt: window.startsAt, endsAt: window.endsAt, columns, synthesisModelIdentity, keys: keys.map(item => item.key),analyses }));
  return { fingerprint, snapshot, inputIssue };
}

export async function submitTopicPreview(input: unknown, actor: string, automatic = false) {
  const value = z.object({ startsAt: z.iso.datetime(), retryFailed: z.boolean().optional() }).strict().parse(input);
  if (!await modelWorkAllowed()) throw new Conflict("模型调用尚未启用，请先配置并启用模型服务");
  const modelIdentity = await materialAnalysisModelIdentity(), synthesisIdentity = await materialAnalysisModelIdentity("studio_topic_generation"), window = await currentWindow();
  if (window.stage !== "collecting" || window.startsAt !== new Date(value.startsAt).toISOString()) throw new Conflict("当期窗口已变化，请刷新后生成候选草案");
  await ensureQueue(topicPreviewQueue.name, topicPreviewQueue.options);
  return sql.begin(async db => {
    await db`SELECT pg_advisory_xact_lock(hashtextextended('studio.topic.columns', 0))`;
    await db`SELECT pg_advisory_xact_lock(hashtextextended(${'studio.topic.preview:' + window.startsAt}, 0))`;
    if ((await currentWindow()).startsAt !== window.startsAt) throw new Conflict("当期窗口已变化，请刷新后生成候选草案");
    const [existing] = await db<Stored[]>`SELECT * FROM studio_topic_previews WHERE starts_at = ${window.startsAt} FOR UPDATE`;
    const [active] = existing?.job_id ? await db`SELECT id FROM pgboss.job WHERE name = ${topicPreviewQueue.name} AND id = ${existing.job_id} AND state IN ('created', 'retry', 'active')` : [];
    if (automatic && (!(await topicPlan(db)).enabled || !await modelWorkAllowed(db) || active ||
      (existing && Date.now() - Date.parse(existing.input.capturedAt) < 15 * 60_000))) return { id: existing?.id ?? null, queued: false };
    if (value.retryFailed && !existing) throw new Conflict("没有可重试的候选草案，请先生成草案");
    if (value.retryFailed && existing && existing.input.modelIdentity !== modelIdentity)
      throw new Conflict("原模型配置已变化，不能按原输入重试，请按最新材料更新候选草案");
    if (value.retryFailed && existing && (existing.result || active)) return { id: existing.id, queued: false };
    const captured = value.retryFailed && existing ? { fingerprint: existing.fingerprint, snapshot: existing.input, inputIssue: null } : await capture(db, window, modelIdentity, synthesisIdentity);
    if (captured.inputIssue) throw new Conflict(captured.inputIssue);
    const { fingerprint } = captured;
    if (!captured.snapshot.materials.length) {
      if (automatic) return { id: existing?.id ?? null, queued: false };
      throw new Conflict("尚无已准备完整正文或转写的当期材料，请先完成采集与处理");
    }
    const same = existing?.fingerprint === fingerprint;
    if (same && (existing.result || active || !value.retryFailed)) return { id: existing.id, queued: false };
    if (active) throw new Conflict("上一份候选草案仍在处理，完成后可按新增材料更新");
    const snapshot: Input = same ? existing.input : retainDisplay(captured.snapshot, existing);
    const completeIssue = sizeIssue(snapshot); if (completeIssue) throw new Conflict(completeIssue);
    const id = existing?.id ?? randomUUID(), token = randomUUID(), version = existing ? existing.version + Number(!same) : 1;
    const jobId = await enqueueOn(topicPreviewQueue, { id, token }, { singletonKey: `${id}:${token}`, group: { id: "topic-preview" } }, db);
    if (!jobId) throw new Conflict("候选草案尚在等待处理，请刷新任务状态");
    await db`INSERT INTO studio_topic_previews (id, starts_at, ends_at, version, fingerprint, input, state, run_token, job_id)
      VALUES (${id}, ${window.startsAt}, ${window.endsAt}, ${version}, ${fingerprint}, ${db.json(snapshot as never)}, 'queued', ${token}, ${jobId})
      ON CONFLICT (starts_at) DO UPDATE SET version = EXCLUDED.version, fingerprint = EXCLUDED.fingerprint, input = EXCLUDED.input,
      state = 'queued', result = NULL, run_token = EXCLUDED.run_token, job_id = EXCLUDED.job_id, error = NULL, generated_at = NULL, updated_at = now()`;
    await audit(actor, "studio.topic.preview.submit", `preview:${id}`, null, null, { version, materials: snapshot.materials.length }, { db });
    return { id, queued: true };
  });
}

/** Worker-only bounded updates. Unchanged inputs and terminal failures are not paid retries. */
export async function scheduleTopicPreview() {
  if (!(await topicPlan()).enabled || !await modelWorkAllowed()) return { queued: false };
  const window = await currentWindow();
  return window.stage === "collecting" ? submitTopicPreview({ startsAt: window.startsAt }, "system:studio.topic.preview", true) : { queued: false };
}

/** Provisional copies are not historical evidence: the originals and frozen batches retain that role. */
export async function pruneTopicPreviews(now: Date) {
  const before = new Date(now.getTime() - 48 * 3600_000);
  const removed = await sql`DELETE FROM studio_topic_previews WHERE id IN
    (SELECT id FROM studio_topic_previews WHERE ends_at < ${before} ORDER BY ends_at LIMIT 20) RETURNING id`;
  return removed.length;
}

async function generate(job: Job) {
  const [row] = await sql<Stored[]>`UPDATE studio_topic_previews SET state = 'running', error = NULL, updated_at = now()
    WHERE id = ${job.id} AND run_token = ${job.token} AND result IS NULL RETURNING *`;
  if (!row) return;
  const input = row.input;
  let outputReceiptId: number | undefined;
  const beforeCall = async () => {
    const [current] = await sql`SELECT run_token FROM studio_topic_previews WHERE id = ${job.id}`;
    if (current?.run_token !== job.token) throw new PreviewStopped("候选草案任务已过期");
    if (Date.now() >= Date.parse(input.endsAt) || (await currentWindow()).startsAt !== input.startsAt)
      throw new PreviewStopped("本期候选窗口已截止，请查看正式批次或生成新一期草案");
    if (await materialAnalysisModelIdentity() !== input.modelIdentity)
      throw new PreviewStopped("模型配置已变化，原依据仍保留，请按最新材料更新候选草案");
    if (input.synthesisModelIdentity && await materialAnalysisModelIdentity("studio_topic_generation") !== input.synthesisModelIdentity)
      throw new PreviewStopped("创作模型配置已变化，请更新候选草案");
    if (!await backgroundWorkHasPriority(sql, "preview")) throw new QueueDeferred("候选草案等待已确认稿件或正式选题完成");
  };
  try {
    const materials: TopicSynthesisMaterial[] = [];
    for (const evidence of input.materials) {
      await beforeCall();
      const existing=input.analyses?.[evidence.id];
      if(existing){materials.push({material:evidence,analysis:existing});continue;}
      const context = { evidence, audience: input.audience, columns: input.columns, insightPolicy: materialInsightPolicy, sharedPolicy: input.sharedPolicy };
      const analyzed = await analyzeMaterialEvidence(context, undefined, await prepareMaterialAnalysis(context, input.modelIdentity), beforeCall);
      materials.push({ material: evidence, analysis: { materialId: evidence.id, state: "completed", ...analyzed.result, receiptId: analyzed.receiptId, error: null } });
    }
    const sharedSignals = input.sharedPolicy === materialAnalysisCachePolicy ? freezeSharedTopicSignals(materials, input.capturedAt,
      input.filterPolicy?.propagation, input.filterPolicy?.heat, input.filterPolicy?.editorial) : undefined;
    const output = await synthesizeTopicDirections({ audience: input.audience, columns: input.columns,
      preview: { startsAt: input.startsAt, endsAt: input.endsAt, capturedAt: input.capturedAt } }, materials,
      { subject: `studio-preview:${job.id}:v${row.version}`, promptVersion: "studio-preview-v1", beforeCall,
        ...(sharedSignals ? { rankingContext: { policy: "studio-direction-ranking-v2", asOf: input.capturedAt, sharedSignals,
          ...(input.filterPolicy ? { filterPolicy: input.filterPolicy } : {}) } } : {}) });
    outputReceiptId = output.receiptId;
    await beforeCall();
    await sql.begin(async db => {
      await db`UPDATE studio_topic_previews SET state = 'draft', input = input - 'previous', result = ${db.json(output.result as never)}, receipt_id = ${output.receiptId},
        generated_at = ${new Date()}, error = NULL, updated_at = now() WHERE id = ${job.id} AND run_token = ${job.token} AND result IS NULL`;
      await completeReceipt(db, output.receiptId);
    });
  } catch (error) {
    if (error instanceof PreviewStopped) {
      await sql.begin(async db => {
        await db`UPDATE studio_topic_previews SET state = 'failed', error = ${error.message}, updated_at = now()
          WHERE id = ${job.id} AND run_token = ${job.token} AND result IS NULL`;
        if (outputReceiptId !== undefined) await completeReceipt(db, outputReceiptId);
      });
      return;
    }
    const paused = error instanceof QueueDeferred;
    await sql`UPDATE studio_topic_previews SET state = ${paused ? "queued" : "failed"}, error = ${paused ? null : "候选草案未生成完成，请检查模型、预算或材料后显式重试"},
      updated_at = now() WHERE id = ${job.id} AND run_token = ${job.token} AND result IS NULL`;
    throw error;
  }
}
