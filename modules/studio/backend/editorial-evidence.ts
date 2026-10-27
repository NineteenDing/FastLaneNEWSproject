import type { SharedMaterial } from "./shared-material.ts";

/** Observed authoritative-platform heat only: never an imputed view count or missing-data placeholder. */
export function verifiedAttentionBreakout(shared:SharedMaterial,platformHeat:number|null){
 return shared.aiCentral===true&&['direct_ai_film','general_ai'].includes(shared.editorialScope??'')&&shared.facts.length>0
  &&platformHeat!==null&&platformHeat>=50&&(shared.v2?.I.value??0)>=65&&(shared.v2?.D.value??0)>=55&&(shared.v2?.E.value??0)>=70;
}

/** Uses already-grounded facts, never a title or source reputation as the event itself. */
export function verifiedModelLaunch(shared: SharedMaterial | null | undefined) {
 if (!shared || shared.aiCentral !== true || (shared.v2?.E.value ?? 0) < 60 || shared.facts.length < 2) return false;
 const model = String.raw`(?:GPT[-‐‑ ]?\d+(?:\.\d+)*(?:[- ](?:Terra|Sol|Astra|Luna|Pro))?|Gemini\s*\d+(?:\.\d+)*(?:\s*Pro)?|Kimi\s*K?\d+(?:\.\d+)*(?:\s*Pro)?|Qwen[-\s]?\d+(?:\.\d+)*(?:[-\w.]+)?|DeepSeek[-\s]?(?:V|R)?\d+(?:\.\d+)*|Claude\s*(?:Opus|Sonnet|Haiku)?\s*\d+(?:\.\d+)*|GLM[-\s]?\d+(?:\.\d+)*|Llama[-\s]?\d+(?:\.\d+)*|MiniMax[-\s]?M\d+(?:\.\d+)*)`;
 const negative = /未|否认|并非|将能|将可|明年|后年|未来|预计|预期|待开放|待发布|没有|不可|无法|暂停|停止|关闭|即将|将于|计划|预告|传闻|据传|去年|前年|此前|过去|previously|last year|rumou?r|plans? to|coming soon|will release|not\s+(?:available|released|launched)|unavailable|den(?:y|ies|ied)/i;
 const launchVerb=String.raw`(?:发布|推出|上线|开源|\breleased?\b|\blaunched?\b|\bintroduc(?:e|ed|ing)\b)`;
 const forward=new RegExp(launchVerb+String.raw`(?:了|的|全新|新版|新一代|模型|\s){0,8}(`+model+')','i');
 const reverse=new RegExp('('+model+')'+String.raw`\s*(?:模型)?\s*(?:已|现已|正式|今日|今天|宣布)?`+launchVerb,'i');
 const normalize=(value:string)=>value.toLowerCase().replace(/[\s‐‑-]/g,'');
 const clauses=shared.facts.flatMap(fact=>fact.text.split(/[，,；;。！？!?]|但是|不过|然而|但|\bbut\b/i));
 const launches=new Set(clauses.filter(text=>!negative.test(text)).flatMap(text=>{
  const name=(forward.exec(text)??reverse.exec(text))?.[1];return name?[normalize(name)]:[];
 }));
 return clauses.some(text=>!negative.test(text) && /开放|可用|访问|下载|定价|价格|API|available|access|download|pricing/i.test(text)
  && [...text.matchAll(new RegExp(model,'gi'))].some(match=>launches.has(normalize(match[0]))));
}

/** Correct a broad-AI label only when AI is central and a grounded fact explicitly concerns creative media. */
export function editorialEvidenceScope(shared: SharedMaterial) {
 const direct = shared.editorialScope === "general_ai" && shared.aiCentral === true && shared.facts.some(fact =>
  /AI|人工智能|生成式|大模型|Claude|Anthropic|OpenAI/i.test(fact.text)
  && /图像|视频|影视|电影|漫剧|剧本|配音|音乐|歌曲|歌词|image|video|film|screenplay|music|songs?|lyrics?/i.test(fact.text)
  && /生成|创作|制作|作品|训练|版权|诉讼|著作权|合成|generate|creat|produc|train|copyright|lawsuit|synthetic/i.test(fact.text));
 return direct ? {scope:"direct_ai_film" as const,aiCentral:true,filmRelevant:true}
  : {scope:shared.editorialScope,aiCentral:shared.aiCentral,filmRelevant:shared.filmRelevant};
}
