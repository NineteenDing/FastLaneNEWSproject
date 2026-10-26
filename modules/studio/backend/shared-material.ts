import { z } from "zod";
import type { TopicBatchMaterial, TopicColumn } from "../contracts.ts";

const text = z.string().trim().min(1).max(500);
const quotes = z.array(z.string().trim().min(1).max(600)).min(1).max(8);
const dimension = z.object({ value: z.number().min(0).max(100).nullable(), reason: text }).strict();
const factIds = z.array(z.number().int().nonnegative()).max(20);
const v2Dimension = z.object({ value: z.number().min(0).max(100).nullable(), reason: text, factIds: factIds.optional() }).strict();

/** Factual understanding is shared; observed heat, age and editable weights are computed later. */
export const sharedMaterialSchema = z.object({
  scope: z.enum(["direct", "important_ai", "unrelated", "uncertain"]), scopeReason: text, scopeQuotes: z.array(z.string().trim().min(1).max(600)).max(8),
  editorialScope: z.enum(["direct_ai_film", "general_ai", "non_ai_film", "unrelated", "uncertain"]).optional(),
  aiCentral: z.boolean().optional(), filmRelevant: z.boolean().optional(),
  facts: z.array(z.object({ text, quotes }).strict()).max(16),
  publicDimensions: z.object({ practical: dimension, interest: dimension, substance: dimension }).strict(),
  impact: dimension.optional(),
  v2: z.object({ I: v2Dimension, M: v2Dimension, D: v2Dimension, P: v2Dimension, E: v2Dimension, X: v2Dimension }).strict().optional(),
  majorEvent: z.object({ kind: z.enum(["major_model_release", "binding_policy", "major_incident", "major_platform_change", "major_industry_change", "none"]),
    affectedGroups: z.array(text).max(12), realizedChange: text, evidenceFactIds: factIds, limitations: z.string().trim().max(500).nullable() }).strict().nullable().optional(),
  publicSummary: z.string().trim().min(1).max(300).optional(), summaryFactIds: factIds.optional(),
  primaryIntent: z.enum(["practice", "models", "news", "cases", "other"]).optional(),
  columnMatches: z.array(z.object({ columnId: z.string().max(80), value: z.number().min(0).max(100), reason: text }).strict()).max(50),
  event: z.object({ relation: z.enum(["new", "same", "development", "composite"]), candidateId: z.uuid().nullable(),
    label: z.string().trim().min(1).max(200), identity: z.string().trim().min(1).max(300), quotes,
    time: z.object({ at: z.iso.datetime({ offset: true }), precision: z.enum(["instant", "day"]), quote: z.string().trim().min(1).max(600) }).strict().nullable().optional(),
  }).strict().nullable(),
  reportingKind: z.enum(["original", "repost", "commentary", "test", "development"]),
  memeEvidence: z.array(z.object({ text, quotes }).strict()).max(6),
  dailyReuse: z.object({ kind: z.enum(["background", "policy"]), validFrom: z.iso.date().nullable(), validThrough: z.iso.date().nullable(), quotes }).strict().nullable().optional(),
  /** Compatible models may repeat root-only fields here; the root values remain authoritative. */
  insights: z.any().optional(), dimensions: z.any().optional(),
}).strict().superRefine((data, ctx) => {
  const validFact = (index: number) => Number.isInteger(index) && index >= 0 && index < data.facts.length;
  if (data.editorialScope === "direct_ai_film" && (data.aiCentral !== true || data.filmRelevant !== true))
    ctx.addIssue({ code: "custom", message: "direct_ai_film 需要 aiCentral 和 filmRelevant 都为 true", path: ["editorialScope"] });
  if (data.editorialScope === "general_ai" && data.aiCentral !== true)
    ctx.addIssue({ code: "custom", message: "general_ai 需要 aiCentral=true", path: ["editorialScope"] });
  if (data.editorialScope === "non_ai_film" && data.filmRelevant !== true)
    ctx.addIssue({ code: "custom", message: "non_ai_film 需要 filmRelevant=true", path: ["editorialScope"] });
  if (data.summaryFactIds?.some(index => !validFact(index)))
    ctx.addIssue({ code: "custom", message: "summaryFactIds 必须指向 shared.facts", path: ["summaryFactIds"] });
  for (const key of ["I", "M", "D", "P", "E", "X"] as const)
    if (data.v2?.[key].factIds?.some(index => !validFact(index)))
      ctx.addIssue({ code: "custom", message: `v2.${key}.factIds 必须指向 shared.facts`, path: ["v2", key, "factIds"] });
  if (data.majorEvent?.evidenceFactIds.some(index => !validFact(index)))
    ctx.addIssue({ code: "custom", message: "majorEvent.evidenceFactIds 必须指向 shared.facts", path: ["majorEvent", "evidenceFactIds"] });
});
export type SharedMaterial = z.infer<typeof sharedMaterialSchema>;

const forbiddenSummary = /值得精选|相关性较弱|可作为选题背景|潜在参考价值|建议创作者|模型评分|入选理由|值得关注/;
/** Public summary only, with a bounded fact-only fallback. It never exposes internal analysis prose. */
export function publicSummaryState(shared: SharedMaterial | null | undefined): { text: string | null; fallback: boolean } {
  const value = shared?.publicSummary?.trim();
  if (value && !forbiddenSummary.test(value)) return { text: value, fallback: false };
  const facts = (shared?.facts ?? []).map(fact => fact.text.trim()).filter(text => text && !forbiddenSummary.test(text));
  const text = facts.slice(0, 4).join("；").slice(0, 300);
  return { text: text || null, fallback: !!text };
}

export function validSharedMaterial(data: SharedMaterial, evidence: TopicBatchMaterial, columns: TopicColumn[]) {
  const time = data.event?.time;
  const allQuotes = [...data.scopeQuotes, ...data.facts.flatMap(fact => fact.quotes), ...(data.event?.quotes ?? []), ...data.memeEvidence.flatMap(item => item.quotes), ...(time ? [time.quote] : []), ...(data.dailyReuse?.quotes ?? [])];
  const reuse = data.dailyReuse;
  if (reuse) {
    if (reuse.validFrom && reuse.validThrough && reuse.validFrom > reuse.validThrough) return false;
    for (const date of [reuse.validFrom, reuse.validThrough].filter((value): value is string => !!value)) {
      const [year, month, day] = date.split("-").map(Number);
      if (!reuse.quotes.some(quote => quote.includes(date) || new RegExp(`${year}年0?${month}月0?${day}日`).test(quote))) return false;
    }
  }
  if (time) {
    const [year, month, day] = time.at.slice(0, 10).split("-").map(Number);
    const hasDate = time.quote.includes(time.at.slice(0, 10)) || new RegExp(`${year}年0?${month}月0?${day}日`).test(time.quote);
    if (!hasDate || (time.precision === "instant" ? !time.quote.includes(time.at.slice(11, 16)) : time.at.slice(11, 19) !== "00:00:00")) return false;
  }
  return allQuotes.every(quote => evidence.body.includes(quote))
    && new Set(data.columnMatches.map(match => match.columnId)).size === data.columnMatches.length
    && data.columnMatches.every(match => columns.some(column => column.enabled && column.id === match.columnId))
    && (!["direct", "important_ai"].includes(data.scope) || data.scopeQuotes.length > 0);
}

export const sharedMaterialInstructions = "本次为二期共享基础分析：同时输出shared对象，公开新闻和内部选题共同复用，不再独立重复分析正文。" +
  "shared.scope为direct(直接AI影视)/important_ai(重要通用AI变化、政策、事故等)/unrelated/uncertain，scopeReason与scopeQuotes给出逐字正文依据。" +
  "重要AI变化不要求已经有教程或亲测；无关社会娱乐热点不能因为热度入选，潜在影视影响只能作有条件推断。" +
  "shared.facts每项text与quotes只记原文明确陈述的事实，推断仍放insights.impacts(kind=inferred)，不把转载当独立验证。" +
  "shared.publicDimensions含practical/interest/substance，每项value为0至100或null，reason简述依据，分别对应影视实用、大众兴趣、实质信息。" +
  "shared.impact为{value:0至100或null,reason}，评价对创作者和行业的实际影响，与已有practical实操性分开；推断说明条件。" +
  "shared.columnMatches为所有适合栏目的columnId/value(0至100)/reason，不强制只归一栏；原columnId仍是主归属。" +
  "shared.event为null或{relation:new/same/development/composite,candidateId:UUID或null,label,identity,quotes}。" +
  "identity明确主体、具体版本/变化、原文可证日期，不能只写工具或公司名而合并不同事件；无可信日期写未知，不补造。" +
  "event.time为null或{at:含时区的ISO日期时间,precision:instant或day,quote:逐字时间依据}；只从正文明确事件发生时间提取，不能用转载日期或采集时间猜测。仅明确日期时precision为day、当地00:00:00，按日期保守计时；时间未知为null。" +
  "同一事件才能same，实质后续变化为development，泛综述为composite。没有eventCandidates时candidateId必须null且relation不能same或development。" +
  "eventCandidates只含有界索引召回的历史事件及其已保存依据，不因名称相同就认定同一事件；逐项核对具体版本/变化/时间，确实同一事件才引用其id。" +
  "shared.reportingKind为original/repost/commentary/test/development；memeEvidence每项text/quotes需有正文具体模仿、玩梗或广泛讨论的证据，只有宣传称爆火不算，没有则[]。" +
  "仅当正文明确支持作为持续有效背景或政策复用时，可补dailyReuse:{kind:background/policy,validFrom:YYYY-MM-DD或null,validThrough:YYYY-MM-DD或null,quotes:逐字依据}。" +
  "不要把一次发布消息自动当长期有效政策；已知生效与失效日期须有引用，不知道日期用null，不编造永久有效。此字段不改变原发布日期，不表示重新发生。" +
  "评论中的parentExternalId指向本材料父评论，回复须连同父评论理解，不把同一讨论链当作多份事实验证；样本范围由采集记录展示，不从样本推断全网共识。" +
  "全部quotes逐字来自material.body；不从标题或评论补造新闻事实。material未提供发布时间、指标与来源身份，因为它们由程序按原记录计算，不能填猜测数字。" +
  "v2补充：editorialScope为direct_ai_film(明确直接AI影视)/general_ai(AI是主体但非直接AI影视)/non_ai_film(影视音乐漫剧相关但AI非核心)/unrelated/uncertain；aiCentral与filmRelevant为布尔并须有正文依据。direct_ai_film须两者true，general_ai须aiCentral=true，non_ai_film须filmRelevant=true；来源是AI科技媒体不能替代文章相关性。" +
  "v2为{I,M,D,P,E,X}，每项{value:0至100或null,reason,factIds:指向shared.facts的整数下标数组}；I受众兴趣、M影响重要性、D实质信息、P可操作价值、E证据支撑、X表达与新增空间。无实操内容的P=0是明确不适用，不得为了过线倒推分数；核心维度缺失标null。" +
  "publicSummary只写80至180个中文字符（硬上限300）的新闻事实及明确归因的原文观点，不写评分、推荐、相关性、选题、模型判断或“值得关注/潜在参考”；summaryFactIds指向支持摘要的shared.facts下标。" +
  "majorEvent仅在已核实的重大模型发布、约束性政策、重大事故、重大平台或行业变化时输出{kind,affectedGroups,realizedChange,evidenceFactIds,limitations}；普通融资、名人表态、预告、估值变化和普通小版本更新不是重大，否则null。primaryIntent为practice/models/news/cases/other，按文章主要问题给出。同时保留旧shared.scope字段。" ;
