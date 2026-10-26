import { z } from "zod";
import type { MaterialInsights, TopicBatchMaterial } from "../contracts.ts";

export const materialInsightPolicy = "grounded-insights-v1";
export const materialInsightsSchema = z.object({
  commentFocus: z.array(z.object({ point: z.string().trim().min(1).max(300), evidence: z.array(z.object({
    commentId: z.string().min(1).max(150), quote: z.string().trim().min(1).max(400),
  }).strict()).min(1).max(4) }).strict()).max(3),
  impacts: z.array(z.object({ effect: z.string().trim().min(1).max(400), conditions: z.string().trim().min(1).max(400),
    kind: z.enum(["reported", "inferred"]), evidenceQuotes: z.array(z.string().trim().min(1).max(600)).min(1).max(4),
  }).strict()).max(3),
}).strict();

export function materialInsightsResult(data: z.infer<typeof materialInsightsSchema>, evidence: TopicBatchMaterial): MaterialInsights {
  return { ...data, policy: materialInsightPolicy, commentSample: { count: evidence.comments.length,
    complete: evidence.commentCoverage?.complete ?? null, repliesComplete: evidence.commentCoverage?.repliesComplete ?? null } };
}

export const materialInsightInstructions = "同时输出insights对象：commentFocus数组最多3项，每项point和evidence数组（commentId、quote）；" +
  "仅从material.comments已收录样本归纳具体需求或争议，每项引用对应externalId和该评论的逐字原句，不能编造评论/数量/全平台共识，没样本则[]。" +
  "insights.impacts数组最多3项，每项effect、conditions、kind(reported/inferred)、evidenceQuotes。" +
  "effect说明对AI视频、漫剧、影视创作者的可能影响；conditions说明适用条件与未验证限制；原文明确陈述的影响标reported，推断标inferred，不能将可能改成保证。" +
  "每项evidenceQuotes必须逐字来自material.body，不把评论观点当事实；正文或转写不完整时impacts输出[]，不足以判断也输出[]。";
