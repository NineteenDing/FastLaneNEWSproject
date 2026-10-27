import {test} from "node:test";
import assert from "node:assert/strict";
import {modelProfileFor} from "../backend/model-routing.ts";
import {verifiedModelLaunch,editorialEvidenceScope} from "../backend/editorial-evidence.ts";
import type {SharedMaterial} from "../backend/shared-material.ts";
import {trendRepresentative} from "../backend/trend-representative.ts";
test("材料和翻译走基础API，选题/审核/口播/风格与未知任务均保留创作API",()=>{
 for(const p of ["studio_material_analysis","studio_news_title_translation","studio_film_translation","studio_daily_edition","studio_writing_reference_vision"])assert.equal(modelProfileFor(p),"basic");
 for(const p of ["studio_topic_generation","studio_topic_review","studio_writing_draft","studio_style_creator","studio_style_learning","unrecognized"])assert.equal(modelProfileFor(p),"creative");
});
test("发布证据不能靠标题或名人表态；必须有已落地的版本发布及可用性事实",()=>{
 const shared={aiCentral:true,v2:{E:{value:85}},facts:[{text:"OpenAI发布GPT-6.1 Terra",quotes:["发布原文"]},{text:"GPT-6.1 Terra现已开放API访问",quotes:["可用性原文"]}]} as SharedMaterial;
 assert.equal(verifiedModelLaunch(shared),true);
 assert.equal(verifiedModelLaunch({...shared,facts:[{text:"OpenAI即将发布GPT-6.1 Terra",quotes:["预告原文"]},shared.facts[1]!]}),false);
 assert.equal(verifiedModelLaunch({...shared,facts:[{text:"孙正义预计未来AI将改变世界",quotes:["表态原文"]},shared.facts[1]!]}),false);
});
test("以事实补正AI音乐版权范围，不把泛AI融资或 unrelated 新闻改成AI影视",()=>{
 const shared={editorialScope:"general_ai",aiCentral:true,filmRelevant:false,facts:[{text:"Anthropic因使用歌曲训练AI遭版权诉讼",quotes:["诉讼原文"]}]} as SharedMaterial;
 assert.equal(editorialEvidenceScope(shared).scope,"direct_ai_film");
 assert.equal(editorialEvidenceScope({...shared,facts:[{text:"Anthropic完成融资",quotes:["融资原文"]}]}).scope,"general_ai");
 assert.equal(editorialEvidenceScope({...shared,editorialScope:"unrelated"}).scope,"unrelated");
});

test("辟谣、不可用及不同模型版本不得通过发布公开兜底",()=>{
 const base={aiCentral:true,v2:{E:{value:85}}} as SharedMaterial;
 for(const texts of [["OpenAI尚未发布GPT-6.1 Terra","GPT-6.1 Terra API目前不可用"],["OpenAI否认发布GPT-6.1 Terra","GPT-6.1 Terra目前不可用"],["OpenAI发布GPT-6.1 Terra","GPT-5.6 Terra现已开放API"]])
  assert.equal(verifiedModelLaunch({...base,facts:texts.map(text=>({text,quotes:[text]}))}),false);
});

test("API发布与权重未开放分别判断，不因附带限制误拦已落地API",()=>{
 const shared={aiCentral:true,v2:{E:{value:85}},facts:[{text:"OpenAI发布GPT-6.1 Terra，但尚未开放权重",quotes:["发布与限制原文"]},{text:"GPT-6.1 Terra已开放API访问",quotes:["可用性原文"]}]} as SharedMaterial;
 assert.equal(verifiedModelLaunch(shared),true);
});

test("同一版本多篇有事实依据的发布报道可选一篇承接热榜；争议新闻与多义匹配不强连",()=>{
 const shared={aiCentral:true,v2:{E:{value:85}},facts:[{text:"OpenAI发布GPT-6.1 Terra",quotes:["原文"]},{text:"GPT-6.1 Terra已开放API",quotes:["原文"]}]} as SharedMaterial;
 const rows=[{id:"one",title:"OpenAI 发布 GPT-6.1 Terra",titleZh:null,shared},{id:"two",title:"OpenAI 发布 GPT-6.1 Terra，面向开发者开放",titleZh:null,shared}];
 assert.equal(trendRepresentative("如何评价 OpenAI 发布的 GPT-6.1 Terra？",rows)?.id,"one");
 assert.equal(trendRepresentative("如何评价 OpenAI 发布的 GPT-6.1 Terra？",[rows[0]!,{...rows[1]!,linked:true}])?.id,"two","新短标题不能使仍有效的原代表换绑，给两个事件同时加热");
 assert.equal(trendRepresentative("如何看待 Kimi K3.1 Pro 开源版刻意削弱网安能力？",rows),null);
 assert.equal(trendRepresentative("如何评价 OpenAI 发布的 GPT-6.1 Terra？",[rows[0]!,{...rows[1]!,shared:{...shared,facts:[]}}])?.id,"one","证据较少的转载不能阻断已有充分依据的发布代表");
});
