import {classifyTrendTitle} from "./rsshub-keywords.ts";
/** Metadata-only discovery gate; views, author identity and popularity never establish relevance. */
export function creatorMediaRelevant(post: {title:string;text:string}) {
 const text=post.title+"\n"+post.text;
 const ai=/\bAI\b|AIGC|人工智能|生成式|智能体|\bagent\b/i.test(text);
 const creationTechnique=/场景一致性|主体一致性|风格一致性|多视角一致性|多视角控制|\bskills?\b|\bAI\s*(?:入门|教程|教学|技巧|干货|创作)/i.test(text);
 return classifyTrendTitle(text).relevant || /ChatGPT|GPT|Claude|Gemini|DeepSeek|Qwen|Kimi|大模型|人工智能|通用AI/i.test(text)
  || ai && creationTechnique;
}
export function selectCreatorIntake<T extends {externalId:string;publishedAt:string|null}>(posts:T[], since:string|null, now:string) {
 const end=Date.parse(now), start=since ? Date.parse(since) : -Infinity;
 const unique=[...new Map(posts.map(p=>[p.externalId,p])).values()];
 return unique.filter(p=>p.publishedAt && Number.isFinite(Date.parse(p.publishedAt)) && Date.parse(p.publishedAt)<=end && Date.parse(p.publishedAt)>start)
 .sort((a,b)=>Date.parse(b.publishedAt!)-Date.parse(a.publishedAt!)).slice(0,since ? undefined : 5);
}
