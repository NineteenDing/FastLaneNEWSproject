import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { getBoss, ensureQueue } from "@aihot/backend/jobs/queue";
import { randomUUID } from "node:crypto";
import { serverModules } from "@aihot/backend/modules";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { bilibiliFixture } from "./mediacrawler-fixture.ts";
import { creatorQueue } from "../backend/creator-collection.ts";
import { createMediaTranscriptionProcessor } from "../backend/media-transcription.ts";
import sharp from "sharp";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

test("图片分析默认关闭，开启后共用Flash及费率不启用任务，旧窗口和其他配置修改保留其版本保护", async () => {
  config.modelCallsEnabled = false;
  const url = "/api/admin/studio/model-connection", initial = (await app.inject({ url, headers })).json();
  assert.equal(initial.visionModel, null); assert.equal(initial.visionPrice, null); assert.equal(initial.runtimeEnabled, false);
  const payload = { baseUrl: "https://vision-fixture.example/v1", analysisModel: "text-analysis", qualityModel: "text-writing", apiKey: "local-only-vision-key",
    visionModel: "image-understanding", analysisPrice: { inputPerMillion: 4, outputPerMillion: 12 }, version: 0 };
  const saved = await app.inject({ method: "PUT", url, headers, payload });
  assert.equal(saved.statusCode, 200, saved.body); assert.equal(saved.json().visionModel, "deepseek-flash"); assert.deepEqual(saved.json().visionPrice, payload.analysisPrice);
  assert.equal(saved.json().runtimeEnabled, false); assert.equal(saved.json().verified, false); assert.ok(!saved.body.includes(payload.apiKey));
  const otherChange = await app.inject({ method: "PUT", url, headers, payload: { baseUrl: payload.baseUrl, analysisModel: "new-text-analysis", qualityModel: payload.qualityModel, version: 1 } });
  assert.equal(otherChange.statusCode, 200, otherChange.body); assert.equal(otherChange.json().visionModel, "deepseek-flash"); assert.deepEqual(otherChange.json().visionPrice, payload.analysisPrice);
  assert.equal((await app.inject({ method: "PUT", url, headers, payload })).statusCode, 409);
  const changed = await app.inject({ method: "PUT", url, headers, payload: { ...payload, version: 2, visionModel: "other-image-model", analysisPrice: null } });
  assert.equal(changed.statusCode, 200); assert.equal(changed.json().visionPrice, null);
  const cleared = await app.inject({ method: "PUT", url, headers, payload: { ...payload, version: 3, visionModel: null, visionPrice: null } });
  assert.equal(cleared.statusCode, 200); assert.equal(cleared.json().visionModel, null); assert.equal(cleared.json().visionPrice, null);
});

test("未开启深度分析不建立任务，显式开启但未配图像模型时明确拒绝，不把文字模型当图像模型", async () => {
  const endpoint = "/api/admin/studio/reference-analyses";
  const disabled = await app.inject({ method: "POST", url: endpoint, headers, payload: {} });
  assert.equal(disabled.statusCode, 200, disabled.body); assert.deepEqual(disabled.json(), { id: null, state: "disabled" });
  assert.equal((await app.inject({ method: "POST", url: endpoint, payload: {} })).statusCode, 401);
  const refused = await app.inject({ method: "POST", url: endpoint, headers, payload: { enabled: true, batchId: randomUUID(), materialIds: ["creator:" + randomUUID()] } });
  assert.equal(refused.statusCode, 409, refused.body); assert.match(refused.json().detail, /图像模型/);
  const queue = "studio.reference.vision", boss = await getBoss(); await ensureQueue(queue);
  assert.deepEqual(await boss.fetch(queue), []);
});

let preparedBatchId = "", preparedMaterialId = "", preparedId = "";
test("显式开启仅把选定视频已存的三帧和全文发给配置的图像模型，任务完成可读有据观察，同内容重试命中缓存不重付", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-17T12:00:00Z") }); await resources.warm(); config.modelCallsEnabled = true;
  const prior = getGlobalDispatcher(), transport = new MockAgent(), oldPrivate = config.allowPrivateNetworkFetch;
  transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
  let calls = 0;
  try {
    const connection = (await app.inject({ url: "/api/admin/studio/model-connection", headers })).json();
    assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/model-connection", headers, payload: { ...connection,
      state: undefined, verified: undefined, runtimeEnabled: undefined, updatedAt: undefined, version: connection.version,
      baseUrl: "https://vision-fixture.example/v1", analysisModel: "text-analysis", qualityModel: "text-writing", apiKey: "local-only-vision-key",
      visionModel: "image-understanding", analysisPrice: { inputPerMillion: 4, outputPerMillion: 12 } } })).statusCode, 200);
    const added = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://space.bilibili.com/20813884" } }); assert.equal(added.statusCode, 200);
    const creator = added.json().creator.id, boss = await getBoss();
    assert.equal((await app.inject({ method: "POST", url: `/api/admin/studio/creators/${creator}/collect`, headers, payload: {} })).statusCode, 200);
    bilibiliFixture(transport); const [discovery] = await boss.fetch(creatorQueue.name); assert.ok(discovery); await creatorQueue.run([discovery.data] as never[]); await boss.complete(creatorQueue.name, discovery.id);
    const post = (await app.inject({ url: `/api/admin/studio/creators/${creator}/contents`, headers })).json().rows[0]; preparedMaterialId = "creator:" + post.id;
    // PostgreSQL's clock is independent of the mocked application clock.
    await sql`UPDATE studio_creator_posts SET collected_at = '2026-10-17T12:00:00Z' WHERE id = ${post.id}`;
    const frames = await Promise.all(["#168356", "#2b64bc", "#ac3030", "#c5b218"].map(async (background, index) => ({ timeSeconds: [0, 3, 6, 10][index]!, pngBase64: (await sharp({ create: { width: 32, height: 24, channels: 3, background } }).png().toBuffer()).toString("base64") })));
    transport.get("https://video-fixture.example").intercept({ path: "/sample.mp4" }).reply(200, Buffer.from("external-media-boundary-fixture"), { headers: { "content-type": "video/mp4" } });
    await createMediaTranscriptionProcessor({ resolve: async () => ({ url: "https://video-fixture.example/sample.mp4", kind: "video" as const }), recognize: async () => ({
      language: "zh", durationSeconds: 12, model: "local-asr-fixture", segments: [{ start: 0, end: 5, text: "先固定参考图。" }, { start: 5, end: 12, text: "再逐镜核对效果。" }], frames,
    }) }).process(post.id);
    assert.equal((await app.inject({ url: `/api/admin/studio/intelligence/${preparedMaterialId}`, headers })).json().transcript.mediaState, "cleaned");
    t.mock.timers.setTime(Date.parse("2026-10-18T12:00:00Z"));
    const batch = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-16T12:00:00Z" } }); assert.equal(batch.statusCode, 200, batch.body); preparedBatchId = batch.json().batch.id;
    transport.get("https://vision-fixture.example").intercept({ method: "POST", path: "/v1/chat/completions", headers: { authorization: "Bearer local-only-vision-key" } }).reply(request => {
      calls++; const payload = JSON.parse(String(request.body)); assert.equal(payload.model, "deepseek-flash");
      const content = payload.messages.find((message: {role: string}) => message.role === "user").content;
      assert.equal(content.filter((part: {type: string}) => part.type === "image_url").length, 3);
      const input = JSON.parse(content[0].text); assert.equal(input.videos.length, 1); assert.equal(input.videos[0].materialId, preparedMaterialId);
      assert.ok(input.videos[0].text.includes("先固定参考图。")); assert.deepEqual(input.videos[0].frames.map((frame: {timeSeconds: number}) => frame.timeSeconds), [0, 6, 10]);
      assert.ok(content.filter((part: {type: string}) => part.type === "image_url").every((part: { image_url: {url: string} }) => part.image_url.url.startsWith("data:image/")));
      const result = { videos: [{ materialId: preparedMaterialId, observations: [{ assetId: input.videos[0].frames[0].assetId, timeSeconds: 0, phase: "opening", observation: "开头展示参考画面", possibleEffect: "可能帮助观众迅速理解对照对象" }],
        textualTone: { quote: "先固定参考图。", observation: "短句先给动作", possibleEffect: "可能降低理解负担" }, limitations: ["只观察抽样帧与文字，未听原音频，不代表整片分析"] }] };
      return { statusCode: 200, data: JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 600, completion_tokens: 200 } }) };
    });
    const endpoint = "/api/admin/studio/reference-analyses", input = { enabled: true, batchId: preparedBatchId, materialIds: [preparedMaterialId] };
    const submitted = await app.inject({ method: "POST", url: endpoint, headers, payload: input }); assert.equal(submitted.statusCode, 200, submitted.body);
    preparedId = submitted.json().id; assert.equal(submitted.json().state, "queued"); assert.equal(calls, 0);
    const queue = serverModules().find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.reference.vision")!; assert.ok(queue);
    const [job] = await boss.fetch(queue.name); assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
    const ready = await app.inject({ url: endpoint + "/" + preparedId, headers }); assert.equal(ready.statusCode, 200, ready.body); assert.equal(ready.json().state, "completed");
    assert.equal(ready.json().result.videos[0].observations[0].timeSeconds, 0); assert.equal(calls, 1);
    assert.equal((await app.inject({ method: "POST", url: endpoint, headers, payload: input })).json().id, preparedId); assert.equal(calls, 1);
    assert.deepEqual(await boss.fetch(queue.name), []); assert.equal((await app.inject({ url: endpoint + "/" + preparedId })).statusCode, 401);
  } finally { setGlobalDispatcher(prior); config.allowPrivateNetworkFetch = oldPrivate; await transport.close(); }
});


test("完成的参考分析只冻结到明确选用它的新稿，初稿和润色实际采用观察，关闭的另一稿只走文本", async () => {
  const prior = getGlobalDispatcher(), transport = new MockAgent(), oldPrivate = config.allowPrivateNetworkFetch;
  transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true; config.modelCallsEnabled = true;
  const writingInputs: Array<Record<string, any>> = [];
  try {
    const connection = (await app.inject({ url: "/api/admin/studio/model-connection", headers })).json();
    const { version, baseUrl, analysisModel, qualityModel } = connection;
    assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/model-connection", headers, payload: {version, baseUrl, analysisModel, qualityModel,
      analysisPrice:{inputPerMillion:4,outputPerMillion:12}, qualityPrice:{inputPerMillion:4,outputPerMillion:12}} })).statusCode, 200);
    const dimensions = {audience:90,practical:90,evidence:90,freshness:80,demand:null,distinctiveness:80}, gates = {audience:true,evidence:true,benefit:true};
    transport.get("https://vision-fixture.example").intercept({method:"POST",path:"/v1/chat/completions"}).reply(request => {
      const body = JSON.parse(String(request.body)), input = JSON.parse(body.messages.at(-1).content);
      if (input.task?.startsWith("writing_")) writingInputs.push(input);
      const result = input.task === "writing_draft" ? {content:{spoken:"先固定参考图，再逐镜核对。",production:"先展示参考与镜头对照。",notes:"仅有抽样画面，不代表整片理解。"},facts:[{materialId:preparedMaterialId,quote:"先固定参考图。",claim:"先固定参考"}],expressionReferences:[],shots:[{startSeconds:0,endSeconds:120,visual:"录屏对照",captureMethod:"screen_recording",assetIds:[]}]}
        : input.task === "writing_polish" ? {spoken:"先固定参考图，再逐镜核对。"} : input.task?.startsWith("writing_") ? {passed:true,issues:[]}
        : input.task === "review_packet" ? {checkedParts:input.parts.map((part:{id:string})=>part.id),opinions:[]}
        : input.task === "review_summary" ? {passed:true,opinionIds:[],summary:"制作步骤有来源与限制"}
        : input.material ? {columnId:"practice",disposition:"support",summary:"参考图核对",reason:"有步骤",viewerBenefit:"减少返工",event:"参考图",evidenceQuotes:["先固定参考图。"],dimensions,gates}
        : {directions:[{id:"reference",columnId:"practice",eventKey:"reference",question:"参考图怎么核对",viewerBenefit:"减少返工",whyNow:"本期方法",angle:"用镜头对照",usage:{steps:["固定参考","逐镜核对"],conditions:["有参考图"],limitations:["效果需验证"]},titles:["先固定参考再核对","参考图检查方法","逐镜核对条件"],preferredTitle:0,structure:{opening:"展示问题",rhythm:"操作与限制",ending:"给下一步"},references:[{materialId:preparedMaterialId,role:"fact",quote:"先固定参考图。",reason:"操作出处"}],dimensions,gates}],assignments:[{materialId:preparedMaterialId,columnId:"practice",disposition:"support",directionIds:["reference"],reason:"制作依据"}]};
      return {statusCode:200,data:JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}],usage:{prompt_tokens:100,completion_tokens:50}})};
    }).persist();
    const boss = await getBoss(), studio = serverModules().find(module=>module.name==="studio")!;
    for (const [suffix,name] of [["analysis","studio.topic.material-analysis"],["recommendations","studio.topic.generate"],["review","studio.topic.review"]]) {
      const submitted = await app.inject({method:"POST",url:`/api/admin/studio/topic-batches/${preparedBatchId}/${suffix}`,headers,payload:{}}); assert.equal(submitted.statusCode,200,submitted.body);
      const [job] = await boss.fetch(name!); assert.ok(job, `${suffix}: ${submitted.body}`); await studio.queues!.find(queue=>queue.name===name)!.run([job.data] as never[]); await boss.complete(name!,job.id);
    }
    const endpoint="/api/admin/studio/drafts", input={batchId:preparedBatchId,directionIds:["reference"],references:[{materialId:preparedMaterialId,role:"fact"},{materialId:preparedMaterialId,role:"expression"}]};
    const off = await app.inject({method:"POST",url:endpoint,headers,payload:{...input,requestId:randomUUID()}}); assert.equal(off.statusCode,200,off.body);
    assert.equal((await app.inject({url:endpoint+"/"+off.json().id,headers})).json().snapshot.referenceAnalysis,undefined);
    const on = await app.inject({method:"POST",url:endpoint,headers,payload:{...input,requestId:randomUUID(),referenceAnalysisId:preparedId}}); assert.equal(on.statusCode,200,on.body);
    const path=endpoint+"/"+on.json().id, saved=(await app.inject({url:path,headers})).json(); assert.equal(saved.snapshot.referenceAnalysis.id,preparedId);
    assert.equal(saved.snapshot.referenceAnalysis.result.videos[0].observations[0].observation,"开头展示参考画面");
    assert.equal((await app.inject({method:"POST",url:path+"/generation",headers,payload:{version:1}})).statusCode,200);
    const queue=studio.queues!.find(queue=>queue.name==="studio.writing.generate")!,[job]=await boss.fetch(queue.name); assert.ok(job); await queue.run([job.data] as never[]); await boss.complete(queue.name,job.id);
    assert.equal(writingInputs.find(input=>input.task==="writing_draft")!.snapshot.referenceAnalysis.id,preparedId);
    assert.equal(writingInputs.find(input=>input.task==="writing_polish")!.referenceAnalysis.id,preparedId);
    assert.equal((await app.inject({url:path,headers})).json().snapshot.referenceAnalysis.id,preparedId);
    assert.equal((await app.inject({url:endpoint+"/"+off.json().id,headers})).json().snapshot.referenceAnalysis,undefined);
  } finally {setGlobalDispatcher(prior);config.allowPrivateNetworkFetch=oldPrivate;await transport.close();}
});

test("参考准备守住视频数量、单次费用、暂停和配置变化，未选为表达参考的结果不能冻结到稿件", async () => {
  const endpoint = "/api/admin/studio/reference-analyses", input = {enabled:true,batchId:preparedBatchId,materialIds:[preparedMaterialId]};
  const boss=await getBoss(), queue=serverModules().find(module=>module.name==="studio")!.queues!.find(queue=>queue.name==="studio.reference.vision")!;
  const prior=getGlobalDispatcher(), transport=new MockAgent(); transport.disableNetConnect(); setGlobalDispatcher(transport);
  try {
    assert.equal((await app.inject({method:"POST",url:endpoint,headers,payload:{...input,materialIds:[preparedMaterialId,"creator:"+randomUUID(),"creator:"+randomUUID()]}})).statusCode,400);
    const refused=await app.inject({method:"POST",url:"/api/admin/studio/drafts",headers,payload:{requestId:randomUUID(),batchId:preparedBatchId,directionIds:["reference"],referenceAnalysisId:preparedId,references:[{materialId:preparedMaterialId,role:"fact"}]}});
    assert.equal(refused.statusCode,409,refused.body); assert.match(refused.json().detail,/表达/);
    async function price(amount:number) {
      const current=(await app.inject({url:"/api/admin/studio/model-connection",headers})).json();
      const {version,baseUrl,analysisModel,qualityModel}=current;
      const saved=await app.inject({method:"PUT",url:"/api/admin/studio/model-connection",headers,payload:{version,baseUrl,analysisModel,qualityModel,analysisPrice:{inputPerMillion:amount,outputPerMillion:amount}}}); assert.equal(saved.statusCode,200,saved.body);
    }
    await price(1_000_000);
    const expensive=await app.inject({method:"POST",url:endpoint,headers,payload:input}); assert.equal(expensive.statusCode,200,expensive.body);
    const [costJob]=await boss.fetch(queue.name); assert.ok(costJob);
    await assert.rejects(()=>queue.run([costJob.data] as never[]),/超过2元/); await boss.cancel(queue.name,costJob.id);
    const failed=(await app.inject({url:endpoint+"/"+expensive.json().id,headers})).json(); assert.equal(failed.state,"failed"); assert.equal(failed.result,null);
    await price(4);
    const waiting=await app.inject({method:"POST",url:endpoint,headers,payload:input}); assert.equal(waiting.statusCode,200,waiting.body);
    const [job]=await boss.fetch(queue.name); assert.ok(job);
    config.modelCallsEnabled=false;
    await assert.rejects(()=>queue.run([job.data] as never[]),/暂停/);
    assert.equal((await app.inject({url:endpoint+"/"+waiting.json().id,headers})).json().state,"queued");
    config.modelCallsEnabled=true; await price(5);
    await assert.rejects(()=>queue.run([job.data] as never[]),/配置已改变/); await boss.cancel(queue.name,job.id);
    assert.equal((await app.inject({url:endpoint+"/"+waiting.json().id,headers})).json().state,"failed");
    // No permitted provider interceptor exists: each rejection happened before any image request.
  } finally {setGlobalDispatcher(prior);await transport.close();config.modelCallsEnabled=true;}
});

test("真实弹窗默认关闭，分析完成前不建稿，关窗保留任务，重新提交复用结果并在写稿台展示依据", async () => {
  const {chromium,expect}=await import("@playwright/test"), {startWebServer}=await import("../../../apps/web/tests/web-server.ts");
  const {listenHttpForFetch}=await import("../../../tests/http-listener.ts"), {createServer,request:forwardRequest}=await import("node:http");
  const apiOrigin=await listenHttpForFetch(app.server), api=createServer((request,response)=>{
    const upstream=forwardRequest(new URL(request.url??"/",apiOrigin),{method:request.method,headers:request.headers},result=>{response.writeHead(result.statusCode??502,result.headers);result.pipe(response);});
    upstream.on("error",()=>{response.writeHead(502);response.end();});request.pipe(upstream);
  });
  const web=await startWebServer(api), browser=await chromium.launch(), page=await browser.newPage({viewport:{width:1440,height:1100}});
  const prior=getGlobalDispatcher(),transport=new MockAgent(),oldPrivate=config.allowPrivateNetworkFetch; transport.disableNetConnect();setGlobalDispatcher(transport);config.allowPrivateNetworkFetch=true;
  let calls=0;
  try {
    transport.get("https://vision-fixture.example").intercept({method:"POST",path:"/v1/chat/completions"}).reply(request=>{
      calls++;const content=JSON.parse(String(request.body)).messages.at(-1).content,source=JSON.parse(content[0].text).videos[0];
      const result={videos:[{materialId:source.materialId,observations:[{assetId:source.frames[0].assetId,timeSeconds:0,phase:"opening",observation:"抽样帧显示参考图",possibleEffect:"可能帮助理解操作对象"}],textualTone:{quote:"先固定参考图。",observation:"短句给动作",possibleEffect:"可能减少理解负担"},limitations:["仅抽样画面和文字，未听音频"]}]};
      return {statusCode:200,data:JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}],usage:{prompt_tokens:200,completion_tokens:80}})};
    });
    const batchUrl=web.origin+`/admin/studio/topics/batches/${preparedBatchId}`;
    await page.goto(batchUrl);await page.locator('input[name="password"]').fill(config.adminPassword!);await page.locator('button[type="submit"]').click();
    async function open() {
      await page.locator(".studio-topic-direction-button").filter({hasText:"先固定参考再核对"}).click();await page.getByRole("button",{name:"采纳并写稿",exact:true}).click();
      const dialog=page.getByRole("dialog",{name:"采纳选题，建立独立稿件"}); await expect(dialog.getByRole("switch",{name:"参考视频深度分析"})).toHaveAttribute("aria-checked","false");
      await dialog.getByRole("checkbox",{name:"表达参考",exact:true}).check();await dialog.getByRole("switch",{name:"参考视频深度分析"}).click(); return dialog;
    }
    let dialog=await open();
    for(const width of [1440,390]) {await page.setViewportSize({width,height:1100});assert.equal(await page.evaluate("document.documentElement.scrollWidth>innerWidth"),false);await page.screenshot({path:`.impeccable/review/reference-vision-adopt-${width}.png`,fullPage:true});}
    const endpoint="/api/admin/studio/drafts",before=(await app.inject({url:endpoint,headers})).json().total;
    const submission=page.waitForResponse(response=>response.url().endsWith("/api/admin/studio/reference-analyses")&&response.request().method()==="POST");
    await dialog.getByRole("button",{name:"建立稿件并进入写稿台",exact:true}).click();assert.equal((await submission).status(),200);await expect(dialog.getByText("正在准备参考分析，完成后自动建稿。关闭弹窗不会删除后台任务。",{exact:true})).toBeVisible();
    const boss=await getBoss(),queue=serverModules().find(module=>module.name==="studio")!.queues!.find(queue=>queue.name==="studio.reference.vision")!;
    const [job]=await boss.fetch(queue.name);assert.ok(job);assert.equal((await app.inject({url:endpoint,headers})).json().total,before);
    await dialog.getByRole("button",{name:"关闭",exact:true}).click();await expect(dialog).not.toBeVisible();
    await queue.run([job.data] as never[]);await boss.complete(queue.name,job.id);assert.equal(calls,1);assert.equal((await app.inject({url:endpoint,headers})).json().total,before);
    dialog=await open();await dialog.getByRole("button",{name:"建立稿件并进入写稿台",exact:true}).click();
    await expect(page).toHaveURL(/\/admin\/studio\/writing\/[0-9a-f-]+$/);
    const id=new URL(page.url()).pathname.split("/").at(-1)!,project=(await app.inject({url:endpoint+"/"+id,headers})).json();assert.ok(project.snapshot.referenceAnalysis);assert.equal(calls,1);
    await page.getByRole("button",{name:"写作依据",exact:true}).click();await page.getByText("本稿参考视频分析（1 条）",{exact:true}).click();
    await expect(page.getByText("0 秒：抽样帧显示参考图",{exact:false})).toBeVisible();
    for(const width of [1440,390]) {await page.setViewportSize({width,height:1100});assert.equal(await page.evaluate("document.documentElement.scrollWidth>innerWidth"),false);await page.screenshot({path:`.impeccable/review/reference-vision-evidence-${width}.png`,fullPage:true});}
    await page.goto(web.origin+"/admin/studio/settings/models");await expect(page.getByRole("switch",{name:"允许Flash图片分析",exact:true})).toHaveAttribute("aria-checked","true");
    await expect(page.getByLabel("Flash输入单价",{exact:true})).toHaveValue("5");
  } finally {await page.close();await browser.close();await web.stop();setGlobalDispatcher(prior);config.allowPrivateNetworkFetch=oldPrivate;await transport.close();}
});

