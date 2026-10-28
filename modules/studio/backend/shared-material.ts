import { z } from "zod";
import type { TopicBatchMaterial, TopicColumn } from "../contracts.ts";

const text = z.string().trim().min(1).max(500);
const quotes = z.array(z.string().trim().min(1).max(600)).min(1).max(8);
const dimension = z.object({ value: z.number().min(0).max(100).nullable(), reason: text }).strict();
const aiTerm = /\bAI\b|AIGC|人工智能|生成式|大模型|GPT|Genie|Gemini|Sora|Veo|Kling|Runway|Qwen|Claude|DeepSeek|Kimi|Llama|GLM|MiniMax|可灵|即梦|豆包|通义|智谱|混元|海螺|Seedance|Midjourney|Stable Diffusion|FLUX|Suno|Udio/i;
const factIds = z.array(z.number().int().nonnegative()).max(20);
const v2Dimension = z.object({ value: z.number().min(0).max(100).nullable(), reason: text, factIds: factIds.optional() }).strict();

/** A model must not invent a year from a month/day-only phrase. Unsupported precision stays unknown. */
function supportedTimeQuote(time: { at: string; precision: "instant" | "day"; quote: string }) {
  const [year, month, day] = time.at.slice(0,10).split("-").map(Number);
  const months = ["January|Jan", "February|Feb", "March|Mar", "April|Apr", "May", "June|Jun", "July|Jul", "August|Aug", "September|Sep|Sept", "October|Oct", "November|Nov", "December|Dec"];
  const monthName = `(?:${months[month!-1]})\\.?`;
  const hasDate = time.quote.includes(time.at.slice(0,10)) || new RegExp(`${year}\\s*年\\s*0?${month}\\s*月\\s*0?${day}\\s*日`).test(time.quote)
    || new RegExp(`\\b${monthName}\\s+0?${day}(?:st|nd|rd|th)?(?:,\\s*|\\s+)${year}\\b`, "i").test(time.quote)
    || new RegExp(`\\b0?${day}\\s+${monthName}\\s+${year}\\b`, "i").test(time.quote);
  return hasDate && (time.precision === "instant" ? time.quote.includes(time.at.slice(11,16)) : time.at.slice(11,19) === "00:00:00");
}

/** Factual understanding is shared; observed heat, age and editable weights are computed later. */
export const sharedMaterialSchema = z.object({
  scope: z.enum(["direct", "important_ai", "unrelated", "uncertain"]), scopeReason: text, scopeQuotes: z.array(z.string().trim().min(1).max(600)).max(8),
  editorialScope: z.enum(["direct_ai_film", "general_ai", "adjacent_industry", "non_ai_film", "unrelated", "uncertain"]).optional(),
  aiCentral: z.boolean().optional(), filmRelevant: z.boolean().optional(),
  scopeFactIds: factIds.optional(), aiRole: z.string().trim().max(500).nullable().optional(),
  facts: z.array(z.object({ text, quotes }).strict()).max(32),
  publicDimensions: z.object({ practical: dimension, interest: dimension, substance: dimension }).strict(),
  impact: dimension.optional(),
  v2: z.object({ I: v2Dimension, M: v2Dimension, D: v2Dimension, P: v2Dimension, E: v2Dimension, X: v2Dimension }).strict().optional(),
  majorEvent: z.object({ kind: z.enum(["major_model_release", "binding_policy", "major_incident", "major_platform_change", "major_industry_change", "none"]),
    affectedGroups: z.array(text).max(12), realizedChange: text, evidenceFactIds: factIds, limitations: z.string().trim().max(500).nullable() }).strict().nullable().optional(),
  publicSummary: z.string().trim().min(1).max(300).optional(), summaryFactIds: factIds.optional(),
  titleZh: z.string().trim().min(1).max(500).nullish().transform(value => value ?? undefined).optional(),
  primaryIntent: z.enum(["practice", "models", "news", "cases", "other"]).optional(),
  columnMatches: z.array(z.object({ columnId: z.string().max(80), value: z.number().min(0).max(100), reason: text }).strict()).max(50),
  event: z.object({ relation: z.enum(["new", "same", "development", "composite"]), candidateId: z.uuid().nullable(),
    label: z.string().trim().min(1).max(200), identity: z.string().trim().min(1).max(300), quotes,
    time: z.object({ at: z.iso.datetime({ offset: true }), precision: z.enum(["instant", "day"]), quote: z.string().trim().min(1).max(600) }).strict().nullable().optional(),
  }).strict().nullable(),
  reportingKind: z.enum(["original", "repost", "commentary", "test", "development"]),
  memeEvidence: z.array(z.object({ text, quotes }).strict()).max(6),
  memeMetrics: z.object({ participants: z.number().int().nonnegative(), platforms: z.number().int().nonnegative(),
    sources: z.number().int().nonnegative(), cases: z.number().int().nonnegative(), originalParticipants: z.number().int().nonnegative(),
    derivativeWorks: z.number().int().nonnegative(), evidenceFactIds: factIds }).strict().nullable().optional(),
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
  if (data.scopeFactIds?.some(index => !validFact(index))) ctx.addIssue({ code: "custom", message: "scopeFactIds必须指向事实", path: ["scopeFactIds"] });
  if (data.aiCentral === true && data.scopeFactIds !== undefined && (!data.scopeFactIds.length || !data.aiRole?.trim()))
    ctx.addIssue({ code: "custom", message: "AI核心判断必须提供scopeFactIds和AI实际作用", path: ["scopeFactIds"] });
  if (data.filmRelevant === true && data.scopeFactIds !== undefined && !data.scopeFactIds.length)
    ctx.addIssue({ code: "custom", message: "影视相关须指向具体相关事实", path: ["scopeFactIds"] });
  if (data.editorialScope === "adjacent_industry" && (data.filmRelevant !== true || data.aiCentral !== false))
    ctx.addIssue({ code: "custom", message: "邻近产业须影视相关且AI非核心", path: ["editorialScope"] });
  if (data.aiCentral === true && data.scopeFactIds !== undefined && !data.scopeFactIds.some(index => validFact(index) && data.facts[index]!.quotes.some(quote => aiTerm.test(quote))))
    ctx.addIssue({ code: "custom", message: "AI核心范围所引用事实没有明确AI主体，不能凭设备/来源或观众推断", path: ["scopeFactIds"] });
  if (data.summaryFactIds?.some(index => !validFact(index)))
    ctx.addIssue({ code: "custom", message: "summaryFactIds 必须指向 shared.facts", path: ["summaryFactIds"] });
  for (const key of ["I", "M", "D", "P", "E", "X"] as const)
    if (data.v2?.[key].factIds?.some(index => !validFact(index)))
      ctx.addIssue({ code: "custom", message: `v2.${key}.factIds 必须指向 shared.facts`, path: ["v2", key, "factIds"] });
  if (data.majorEvent?.evidenceFactIds.some(index => !validFact(index)))
    ctx.addIssue({ code: "custom", message: "majorEvent.evidenceFactIds 必须指向 shared.facts", path: ["majorEvent", "evidenceFactIds"] });
  if (data.memeMetrics?.evidenceFactIds.some(index => !validFact(index)))
    ctx.addIssue({ code: "custom", message: "memeMetrics.evidenceFactIds 必须指向 shared.facts", path: ["memeMetrics", "evidenceFactIds"] });
}).transform(data => data.event?.time && !supportedTimeQuote(data.event.time)
  ? { ...data, event: { ...data.event, time: null } } : data);
export type SharedMaterial = z.infer<typeof sharedMaterialSchema>;

export function verifiedMemeEvidence(shared: SharedMaterial | null | undefined) {
  const value = shared?.memeMetrics;
  if (!value || !value.evidenceFactIds.length) return false;
  const text = value.evidenceFactIds.flatMap(id => shared?.facts[id]?.quotes ?? []).join(" ");
  const stated = (count: number) => count > 0 && new RegExp(`(^|[^0-9])${count}([^0-9]|$)`).test(text);
  return value.participants >= 20 && value.platforms >= 2 && value.sources >= 2 && value.cases >= 5
    && [value.participants, value.platforms, value.sources, value.cases].every(stated)
    || value.originalParticipants >= 1000 && value.derivativeWorks >= 100 && [value.originalParticipants, value.derivativeWorks].every(stated);
}

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
    if (!supportedTimeQuote(time)) return false;
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
  "v3补充：adjacent_industry指短剧/漫剧/IP/制作发行平台等产业变化；non_ai_film指普通电影项目、影展融资、器材、演员作品。花边、恋情、私生活与无影视作品事实的明星争议须unrelated，不能以明星身份推导影视相关。editorialScope为direct_ai_film(明确直接AI影视)/general_ai(AI是主体但非直接AI影视)/non_ai_film(影视音乐漫剧相关但AI非核心)/unrelated/uncertain；aiCentral与filmRelevant为布尔并须有正文依据。direct_ai_film须两者true，general_ai须aiCentral=true，non_ai_film须filmRelevant=true；来源是AI科技媒体不能替代文章相关性。" +
  "M按事件所在AI领域的真实影响评价，通用AI模型发布不以影视实操落地为必需；AI音乐、配音、图像、视频、剧本创作及其版权与观看体验直接属于AI影视，不要求教程。v2为{I,M,D,P,E,X}，每项{value:0至100或null,reason,factIds:指向shared.facts的整数下标数组}；I受众兴趣、M影响重要性、D实质信息、P可操作价值、E证据支撑、X表达与新增空间。无实操内容的P=0是明确不适用，不得为了过线倒推分数；核心维度缺失标null。" +
  "publicSummary只写80至180个中文字符（硬上限300）的新闻事实及明确归因的原文观点，不写评分、推荐、相关性、选题、模型判断或“值得关注/潜在参考”；summaryFactIds指向支持摘要的shared.facts下标。" +
  "majorEvent仅在已核实的重大模型发布、约束性政策、重大事故、重大平台或行业变化时输出{kind,affectedGroups,realizedChange,evidenceFactIds,limitations}；普通融资、名人表态、预告、估值变化和普通小版本更新不是重大，否则null。primaryIntent为practice/models/news/cases/other，按文章主要问题给出。同时保留旧shared.scope字段。" +
  "外文新闻无论相关、无关、是否公开，都必须在本次同一轮初筛理解中同步输出自然中文titleZh作为正式中文标题，保留专有名词，不杜撰原标题没有的事实。中文原标题可省略titleZh。" +
  "memeMetrics仅在正文引文明确给出量化传播证据时输出{participants,platforms,sources,cases,originalParticipants,derivativeWorks,evidenceFactIds}，未知计0，不能把刷屏/爆火修辞换算人数。无量化证据输出null。" +
  "输出契约补充：shared只能放JSON顶层，与insights并列，不能放在insights里面。majorEvent可为null；非null时kind只允许major_model_release、binding_policy、major_incident、major_platform_change、major_industry_change、none，不能新增其他枚举；affectedGroups必须是字符串数组，evidenceFactIds必须是整数下标数组，limitations为字符串或null。无法适配类型时majorEvent=null，不改写为已核实重大事件。" +
  "事实引句包括evidenceQuotes、facts.quotes、scopeQuotes与insights.impacts.evidenceQuotes，必须是material.body中的连续原文子串；insights.commentFocus.evidence.quote必须是对应material.comments评论中的连续原文子串并标记真实commentId；英文引句不得翻译成中文，不改引号、不缩写、不补省略号，不确定就引用较短但完整的原文。未知时间置null，不补年份。" +
  "事实条目聚焦最多8项核心事实，每项引用1至3段简短原文；维度reason及其他理由保持简短单句。完整正文是输入依据，不需要逐段复述全文；必须在输出额度内返回一个完整闭合JSON对象。";
