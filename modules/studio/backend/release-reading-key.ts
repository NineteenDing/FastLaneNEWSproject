import type {SharedMaterial} from './shared-material.ts';

/** A narrow, fact-grounded backstop for model releases the semantic linker labelled independently. */
export function releaseReadingKey(shared:SharedMaterial):string|null{
 const event=shared.event;
 if(!shared.aiCentral||!event||!['new','same'].includes(event.relation))return null;
 const label=event.label.normalize('NFKC');
 const test=shared.reportingKind==='test'&&shared.facts.some(fact=>/实测|测评|对比测试|我们测试|we tested|our test|benchmark/i.test(fact.text));
 if(!(/发布|推出|上线|开源|\brelease|\blaunch|\bintroduc/i.test(label)||test&&/实测|测评|测试|\btest|benchmark|review/i.test(label))
  ||/传闻|否认|争议|漏洞|泄露|rumou?r|denied|controvers|leak/i.test(label))return null;
 // Consume complete Latin suffixes, including unknown ones. Narrative words terminate the name;
 // an unfamiliar descriptive tail may under-group, but must never collapse two product variants.
 const pattern=/\b(?:Genie|GPT|Gemini|Sora|Veo|Kling|Runway|Qwen|Claude|DeepSeek|Kimi)\s*[-‐‑]?\s*\d+(?:\.\d+)*(?:(?:[-‐‑]|\s+)(?!(?:released?|launch(?:ed)?|introduc(?:ed|es|ing)|is|was|has|with|supports?|at|for|in|on|world|model|preview|test|review)\b)[a-z0-9][a-z0-9]*(?:[.‐‑-][a-z0-9]+)*)*\b/gi;
 const normalize=(name:string)=>name.toLowerCase().replace(/[\s‐‑-]/g,'');
 const matches=[...label.matchAll(pattern)];
 if(matches.some(match=>/^[-‐‑]/.test(label.slice(match.index!+match[0].length))))return null;
 const models=[...new Set(matches.map(match=>normalize(match[0])))];
 if(models.length!==1)return null;
 const model=models[0]!;
 if(!shared.facts.some(fact=>[...fact.text.matchAll(pattern)].some(match=>normalize(match[0])===model)))return null;
 return model+':'+(test?'test':'release');
}
