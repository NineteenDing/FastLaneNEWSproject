import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import {after,test} from "node:test";
import {z} from "zod";
import {MockAgent,getGlobalDispatcher,setGlobalDispatcher} from "undici";
import {config} from "@aihot/backend/config";
import {closeDb} from "@aihot/backend/db";
import {stopBoss} from "@aihot/backend/jobs/queue";
import {studioChatJson} from "../backend/studio-model.ts";
import {sourceResourceFixture} from "./source-resource-fixture.ts";
const resources=await sourceResourceFixture(),previous=getGlobalDispatcher(),transport=new MockAgent();
transport.disableNetConnect();setGlobalDispatcher(transport);config.allowPrivateNetworkFetch=true;config.modelCallsEnabled=true;
Object.assign(process.env,{LLM_BASE_URL:"https://api.deepseek.com/v1",LLM_API_KEY:"parser-test-only"});
let calls=0;
transport.get("https://api.deepseek.com").intercept({method:"POST",path:"/v1/chat/completions"}).reply(()=>{
 calls++;return {statusCode:200,data:JSON.stringify({choices:[{message:{content:JSON.stringify({ok:true,titleZh:null})}}],usage:{prompt_tokens:10,completion_tokens:10}})};
}).persist();
after(async()=>{setGlobalDispatcher(previous);await transport.close();await resources.app.close();await stopBoss();await closeDb();});
test("兼容解析只恢复同一冻结材料的原付费响应，改变输入必须重新请求",async()=>{
 await resources.warm();
 const options={purpose:"studio_material_analysis",subject:"studio-material:news:parser",promptVersion:"parser-fixture-v1",system:"仅测试固定字段",user:JSON.stringify({material:{body:"原始正文"},analysisContext:{modelIdentity:"fixture"}})};
 await assert.rejects(studioChatJson("studioMaterialAnalysis",{...options,schema:z.object({ok:z.boolean()}).strict()}));assert.equal(calls,1);
 const compatible=z.object({ok:z.boolean(),titleZh:z.string().nullable()});
 const recovered=await studioChatJson("studioMaterialAnalysis",{...options,schema:compatible});assert.equal(recovered.data.ok,true);assert.equal(recovered.reused,true);assert.equal(calls,1);
 await studioChatJson("studioMaterialAnalysis",{...options,user:JSON.stringify({material:{body:"已更正正文"},analysisContext:{modelIdentity:"fixture"}}),schema:compatible});assert.equal(calls,2);
 await studioChatJson("studioMaterialAnalysis",{...options,system:"已修改系统语义",schema:compatible});assert.equal(calls,3,"同正文不同系统语义不得误复用");
});
