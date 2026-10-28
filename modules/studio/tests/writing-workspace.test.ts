import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { serverModules } from "@aihot/backend/modules";
import { stub, gate } from "../../../tests/setup.ts";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

const resources = await sourceResourceFixture(), { app, headers } = resources;
config.allowPrivateNetworkFetch = true; // Controlled localhost model fixture, never production configuration.
const body = "先固定参考图，再逐镜检查角色与光线；运动镜头仍需单独验证。";
let batchId: string;
let generationStarted: ReturnType<typeof gate<void>> | undefined, holdGeneration: ReturnType<typeof gate<void>> | undefined;
const provider = await stub(async (_hit, request) => {
  const input = JSON.parse(JSON.parse(request.body).messages.at(-1).content);
  const dimensions = { audience: 90, practical: 90, evidence: 90, freshness: 80, demand: null, distinctiveness: 80 }, gates = { audience: true, evidence: true, benefit: true };
  if (input.task === "writing_draft") { generationStarted?.open(); await holdGeneration?.promise; }
  const spoken = "先固定参考图，再逐镜核对角色与光线。运动镜头仍需自己验证，检查工具只是辅助，不保证消除所有漂移。";
  const result = input.task === "writing_draft" ? { title: "角色与镜头工具如何配合", titleOptions: ["角色与镜头工具如何配合", "固定参考后再选检查工具", "两步核对镜头条件"],
      content: { spoken, production: "先展示参考图，再录屏对照工具与镜头。", notes: "需要实际录屏素材。" }, facts: [{ materialId: input.snapshot.materials[0].id, quote: body, claim: "先固定参考再检查" }], expressionReferences: [], shots: [{ startSeconds: 0, endSeconds: 120, visual: "参考图与镜头检查", captureMethod: "screen_recording", assetIds: [] }] }
    : ["writing_polish", "writing_repair"].includes(input.task) ? { spoken }
    : ["writing_check", "writing_check_repaired"].includes(input.task) ? { passed: true, issues: [] }
    : input.task === "review_packet" ? { checkedParts: input.parts.map((part: { id: string }) => part.id), opinions: [] }
    : input.task === "review_summary" ? { passed: true, opinionIds: [], summary: "实际依据和限制已覆盖" }
    : input.material ? { columnId: "practice", disposition: "support", summary: "参考图与逐镜检查", reason: "有操作与限制", viewerBenefit: "减少返工", event: "参考图方法", evidenceQuotes: [body], dimensions, gates, entities: [] }
    : { directions: ["reference", "lighting"].map((id, index) => ({ id, columnId: index ? "models" : "practice", eventKey: id, question: index ? "如何选镜头检查工具" : "如何固定角色", viewerBenefit: "先固定参考再核对镜头", whyNow: "有新的制作说明", angle: index ? "工具的检查条件" : "参考图操作",
      usage: { steps: ["固定参考图", "逐镜核对"], conditions: ["已有角色图"], limitations: ["运动镜头单独验证"] },
      titles: index ? ["检查工具怎么选", "镜头检查条件", "工具推荐须知"] : ["角色参考怎么用", "先固定参考图", "两步核对镜头"], preferredTitle: 0,
      structure: { opening: "指出返工问题", rhythm: "演示与条件", ending: "说明限制" }, dimensions, gates,
      references: input.materials.map(({ material }: { material: { id: string } }) => ({ materialId: material.id, role: "fact", quote: body, reason: "操作依据" })) })),
      assignments: input.materials.map(({ material }: { material: { id: string } }) => ({ materialId: material.id, columnId: "practice", disposition: "support", directionIds: ["reference", "lighting"], reason: "角色与工具共同依据" })) };
  return { choices: [{ message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 30, completion_tokens: 30 } };
});

Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "local-writing-workspace-key", LLM_MODEL: "local-writing-workspace" });
after(async () => { await app.close(); await provider.close(); await stopBoss(); await closeDb(); });

test("备用标题随本稿版本独立保存，删除不影响其他稿，复制和历史恢复保留对应版本标题", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-18T12:00:00Z") }); config.modelCallsEnabled = true; await resources.warm();
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: { id: "writing-workspace", name: "制作方法来源", kind: "rss", config: { feedUrl: "https://writing-workspace.example/feed" } } })).statusCode, 200);
  await upsertMaterial({ sourceId: "writing-workspace", title: "参考图与镜头工具", url: "https://writing-workspace.example/one", via: "import", bodyStatus: "ok", bodyText: body, discoveredAt: new Date("2026-10-17T10:00:00Z") });
  const frozen = await app.inject({ method: "POST", url: "/api/admin/studio/topic-batches", headers, payload: { startsAt: "2026-10-16T12:00:00Z" } });
  assert.equal(frozen.statusCode, 200, frozen.body); batchId = frozen.json().batch.id;
  const boss = await getBoss(), studio = serverModules().find(module => module.name === "studio")!;
  for (const [suffix, name] of [["analysis", "studio.topic.material-analysis"], ["recommendations", "studio.topic.generate"], ["review", "studio.topic.review"]]) {
    const submit = await app.inject({ method: "POST", url: `/api/admin/studio/topic-batches/${batchId}/${suffix}`, headers, payload: {} }); assert.equal(submit.statusCode, 200, submit.body);
    const [job] = await boss.fetch(name!); assert.ok(job); await studio.queues!.find(queue => queue.name === name)!.run([job.data] as never[]); await boss.complete(name!, job.id);
  }
  const endpoint = "/api/admin/studio/drafts", payload = { batchId, directionIds: ["reference", "lighting"] };
  const first = await app.inject({ method: "POST", url: endpoint, headers, payload: { ...payload, requestId: randomUUID() } }); assert.equal(first.statusCode, 200, first.body);
  const second = await app.inject({ method: "POST", url: endpoint, headers, payload: { ...payload, requestId: randomUUID() } }); assert.equal(second.statusCode, 200);
  const url = endpoint + "/" + first.json().id, other = endpoint + "/" + second.json().id;
  const before = (await app.inject({ url, headers })).json(), otherBefore = (await app.inject({ url: other, headers })).json();
  assert.deepEqual(before.titleOptions, ["角色参考怎么用", "先固定参考图", "两步核对镜头", "检查工具怎么选", "镜头检查条件", "工具推荐须知"]);
  const saved = await app.inject({ method: "PATCH", url, headers, payload: { version: 1, title: "先固定参考图", titleOptions: ["两步核对镜头"], content: { spoken: "固定参考后再逐镜核对。", production: "录屏演示", notes: "" } } });
  assert.equal(saved.statusCode, 200, saved.body); assert.equal(saved.json().version, 2);
  assert.deepEqual((await app.inject({ url: url + "/versions/1", headers })).json().titleOptions, before.titleOptions);
  assert.deepEqual((await app.inject({ url: other, headers })).json(), otherBefore);
  const confirmed = await app.inject({ method: "POST", url: url + "/finalize", headers, payload: { version: 2 } }); assert.equal(confirmed.statusCode, 200);
  const removed = await app.inject({ method: "PATCH", url, headers, payload: { version: 3, titleOptions: [] } }); assert.equal(removed.statusCode, 200);
  assert.deepEqual((await app.inject({ url: url + "/versions/3", headers })).json().titleOptions, ["两步核对镜头"]);
  const restored = await app.inject({ method: "POST", url: url + "/restore", headers, payload: { version: 4, restoreVersion: 2 } }); assert.equal(restored.statusCode, 200, restored.body);
  assert.deepEqual(restored.json().titleOptions, ["两步核对镜头"]);
  const copy = await app.inject({ method: "POST", url: url + "/copy", headers, payload: { requestId: randomUUID(), version: 5 } }); assert.equal(copy.statusCode, 200, copy.body);
  assert.deepEqual((await app.inject({ url: endpoint + "/" + copy.json().id, headers })).json().titleOptions, ["两步核对镜头"]);
  assert.equal((await app.inject({ method: "PATCH", url, headers, payload: { version: 1, titleOptions: [] } })).statusCode, 409);
});

test("跨栏目组合稿实际生成统一标题和备选，迟到提案不覆盖手改标题，明确采纳才一起保存", async () => {
  config.modelCallsEnabled = true;
  const endpoint = "/api/admin/studio/drafts";
  const created = await app.inject({ method: "POST", url: endpoint, headers, payload: { requestId: randomUUID(), batchId, directionIds: ["reference", "lighting"], title: "用户提供的起稿方向" } });
  assert.equal(created.statusCode, 200, created.body); const url = endpoint + "/" + created.json().id;
  const submit = await app.inject({ method: "POST", url: url + "/generation", headers, payload: { version: 1 } }); assert.equal(submit.statusCode, 200, submit.body);
  const boss = await getBoss(), studio = serverModules().find(module => module.name === "studio")!, queue = studio.queues!.find(queue => queue.name === "studio.writing.generate")!;
  const [first] = await boss.fetch(queue.name); assert.ok(first); await queue.run([first.data] as never[]); await boss.complete(queue.name, first.id);
  const written = (await app.inject({ url, headers })).json();
  assert.equal(written.title, "角色与镜头工具如何配合"); assert.deepEqual(written.titleOptions, ["角色与镜头工具如何配合", "固定参考后再选检查工具", "两步核对镜头条件"]);
  assert.equal(written.version, 2); assert.equal(written.snapshot.directions.length, 2);
  generationStarted = gate<void>(); holdGeneration = gate<void>();
  try {
    assert.equal((await app.inject({ method: "POST", url: url + "/generation", headers, payload: { version: 2 } })).statusCode, 200);
    const [second] = await boss.fetch(queue.name); assert.ok(second); const running = queue.run([second.data] as never[]);
    await generationStarted.promise;
    const edited = await app.inject({ method: "PATCH", url, headers, payload: { version: 2, title: "我手写的统一标题", titleOptions: ["手写备用标题"] } }); assert.equal(edited.statusCode, 200);
    holdGeneration.open(); await running; await boss.complete(queue.name, second.id);
    assert.equal((await app.inject({ url, headers })).json().title, "我手写的统一标题");
    const proposal = (await app.inject({ url: url + "/generation", headers })).json(); assert.equal(proposal.state, "proposal"); assert.equal(proposal.result.title, "角色与镜头工具如何配合");
    assert.equal((await app.inject({ method: "POST", url: `${url}/generation/${proposal.id}/apply`, headers, payload: { version: 2 } })).statusCode, 409);
    assert.equal((await app.inject({ method: "POST", url: `${url}/generation/${proposal.id}/apply`, headers, payload: { version: 3 } })).statusCode, 200);
    const adopted = (await app.inject({ url, headers })).json(); assert.equal(adopted.title, "角色与镜头工具如何配合"); assert.deepEqual(adopted.titleOptions, written.titleOptions);
    assert.equal((await app.inject({ url: url + "/versions/3", headers })).json().title, "我手写的统一标题");
  } finally { holdGeneration?.open(); holdGeneration = undefined; generationStarted = undefined; }
});

test("正文默认预览，点击编辑后离开保存；切换同批稿件先保存原稿，两篇内容不互相影响", async () => {
  const { chromium, expect } = await import("@playwright/test"), { startWebServer } = await import("../../../apps/web/tests/web-server.ts");
  const { listenHttpForFetch } = await import("../../../tests/http-listener.ts"), { createServer, request: forwardRequest } = await import("node:http");
  const address = app.server.address(), apiOrigin = address && typeof address !== "string" ? `http://127.0.0.1:${address.port}` : await listenHttpForFetch(app.server), api = createServer((request, response) => {
    const upstream = forwardRequest(new URL(request.url ?? "/", apiOrigin), { method: request.method, headers: request.headers }, result => { response.writeHead(result.statusCode ?? 502, result.headers); result.pipe(response); });
    upstream.on("error", () => { response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  const web = await startWebServer(api), browser = await chromium.launch();
  const list = (await app.inject({ url: `/api/admin/studio/drafts?batchId=${batchId}`, headers })).json();
  const first = list.rows.find((row: { title: string }) => row.title === "先固定参考图"), second = list.rows.find((row: { title: string }) => row.title === "角色参考怎么用"); assert.ok(first && second);
  const otherBefore = (await app.inject({ url: `/api/admin/studio/drafts/${second.id}`, headers })).json();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  try {
    await page.goto(web.origin + `/admin/studio/writing/${first.id}`); await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    const text = page.getByRole("textbox", { name: "纯口播正文", exact: true }); await expect(text).toBeEditable();
    await text.fill("本机编辑后的独立口播。");
    await page.getByRole("navigation", { name: "本期稿件", exact: true }).getByRole("link", { name: /角色参考怎么用/ }).click();
    await expect(page).toHaveURL(new RegExp(`/writing/${second.id}$`));
    assert.equal((await app.inject({ url: `/api/admin/studio/drafts/${first.id}`, headers })).json().content.spoken.trim(), "本机编辑后的独立口播。");
    assert.deepEqual((await app.inject({ url: `/api/admin/studio/drafts/${second.id}`, headers })).json(), otherBefore);
    await page.getByRole("navigation", { name: "本期稿件", exact: true }).locator(`a[href="/admin/studio/writing/${first.id}"]`).click();
    await expect(page.getByRole("textbox", { name: "纯口播正文", exact: true })).toHaveValue("本机编辑后的独立口播。");
    await page.getByRole("textbox", { name: "纯口播正文", exact: true }).fill("离开正文也要保留的口播。");
    await page.getByRole("textbox", { name: "稿件标题", exact: true }).click();
    await expect(text).toBeEditable();
    await expect(page.getByRole("status").filter({ hasText: "已保存" }).first()).toBeVisible();
    assert.equal((await app.inject({ url: `/api/admin/studio/drafts/${first.id}`, headers })).json().content.spoken.trim(), "离开正文也要保留的口播。");
  } finally { await page.close(); await browser.close(); await web.stop(); }
});

test("历史定稿筛选指向实际确认版本，后续草稿修改仍能单独找到，栏目与期次筛选不漏合并稿", async () => {
  const endpoint = "/api/admin/studio/drafts";
  const final = (await app.inject({ url: endpoint + "?state=final", headers })).json();
  assert.equal(final.total, 1); assert.equal(final.rows[0].confirmedTitle, "先固定参考图"); assert.equal(final.rows[0].confirmedVersion, 3);
  const saved = (await app.inject({ url: `${endpoint}/${final.rows[0].id}/versions/3`, headers })).json();
  assert.equal(saved.content.spoken, "固定参考后再逐镜核对。");
  const drafts = (await app.inject({ url: endpoint + "?state=draft", headers })).json();
  assert.ok(drafts.rows.some((row: { id: string }) => row.id === final.rows[0].id));
  assert.equal((await app.inject({ url: endpoint + "?periodStart=2026-10-16T12:00:00Z&columnId=models", headers })).json().total, 4);
  assert.equal((await app.inject({ url: endpoint + "?periodStart=2026-10-14T12:00:00Z", headers })).json().total, 0);
  assert.equal((await app.inject({ url: endpoint + "?columnId=other", headers })).json().total, 0);
});

test("写稿工作区可换删标题、搜索阅读引用、拖图存稿导出，历史打开原定稿并保留当前草稿入口", async () => {
  const { chromium, expect } = await import("@playwright/test"), { startWebServer } = await import("../../../apps/web/tests/web-server.ts");
  const { listenHttpForFetch } = await import("../../../tests/http-listener.ts"), { createServer, request: forwardRequest } = await import("node:http");
  const { default: sharp } = await import("sharp"), { unzipSync, strFromU8 } = await import("fflate");
  const address = app.server.address(), apiOrigin = address && typeof address !== "string" ? `http://127.0.0.1:${address.port}` : await listenHttpForFetch(app.server), api = createServer((request, response) => {
    const upstream = forwardRequest(new URL(request.url ?? "/", apiOrigin), { method: request.method, headers: request.headers }, result => { response.writeHead(result.statusCode ?? 502, result.headers); result.pipe(response); });
    upstream.on("error", () => { response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  const web = await startWebServer(api), browser = await chromium.launch();
  const created = await app.inject({ method: "POST", url: "/api/admin/studio/drafts", headers, payload: { requestId: randomUUID(), batchId, directionIds: ["reference"] } });
  assert.equal(created.statusCode, 200); const id = created.json().id, endpoint = `/api/admin/studio/drafts/${id}`;
  const picture = await sharp({ create: { width: 32, height: 24, channels: 3, background: "#168356" } }).png().toBuffer();
  const uploaded = await app.inject({ method: "POST", url: endpoint + "/images", headers, payload: { name: "可拖入的镜头图.png", contentType: "image/png", bodyBase64: picture.toString("base64") } });
  assert.equal(uploaded.statusCode, 200, uploaded.body);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  try {
    await page.goto(web.origin + `/admin/studio/writing/${id}`); await page.locator('input[name="password"]').fill(config.adminPassword!); await page.locator('button[type="submit"]').click();
    await expect(page.getByRole("group", { name: "备用标题", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "先固定参考图", exact: true }).click();
    await page.getByRole("button", { name: "删除备用标题：两步核对镜头", exact: true }).click();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect.poll(async () => (await app.inject({ url: endpoint, headers })).json().title).toBe("先固定参考图");
    assert.deepEqual((await app.inject({ url: endpoint, headers })).json().titleOptions, ["角色参考怎么用", "先固定参考图"]);
    const references = page.getByRole("region", { name: "本稿全部引用", exact: true });
    await references.getByRole("textbox", { name: "搜索本稿参考", exact: true }).fill("不存在的引用词");
    await expect(references.getByText("没有匹配引用，可换个关键词。", { exact: true })).toBeVisible();
    await references.getByRole("textbox", { name: "搜索本稿参考", exact: true }).fill("参考图与镜头工具");
    await references.getByRole("button", { name: "参考图与镜头工具", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText(body); await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: "图片素材", exact: true }).click();
    await expect(page.locator(".studio-writing-images img")).toHaveAttribute("draggable", "false");
    const spoken = page.getByRole("textbox", { name: "纯口播正文", exact: true });
    const transfer = await page.evaluateHandle("(() => { const data=new DataTransfer();data.setData('application/x-fastlanenews-image','ignored');return data; })()");
    await spoken.dispatchEvent('drop',{dataTransfer:transfer});await expect(spoken).toHaveValue('');
    await page.getByRole("tab", { name: "制作方案", exact: true }).click();
    await page.getByRole("textbox", { name: "制作方案与备注", exact: true }).fill('独立的制作方案，不将图片写入口播。');
    await page.getByRole("button",{name:'保存',exact:true}).click();
    await expect.poll(async () => (await app.inject({ url: endpoint, headers })).json().content.production).toBe('独立的制作方案，不将图片写入口播。');
    const current = (await app.inject({ url: endpoint, headers })).json(); assert.equal(current.content.spoken, "");
    const exported = await app.inject({ method: "POST", url: endpoint + "/export", headers, payload: { version: current.version, mode: "draft", format: "zip" } });
    assert.equal(exported.statusCode, 200, exported.body.slice(0, 200));
    const files = unzipSync(exported.rawPayload); assert.ok(Object.keys(files).some(name => name.includes("images/")));
    assert.ok(Object.entries(files).some(([name, content]) => name.endsWith("图片素材.md") && strFromU8(content).includes("images/")));
    for (const width of [1440, 390]) { await page.setViewportSize({ width, height: 1100 }); assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false); await page.screenshot({ path: `.impeccable/review/writing-workspace-${width}.png`, fullPage: true }); }
    await page.goto(web.origin + "/admin/studio/writing?view=history");
    await expect(page.getByRole("link", { name: "全部稿件", exact: true })).toHaveAttribute("aria-current", "page");
    await page.getByRole("link", { name: "已确认定稿", exact: true }).click();
    await expect(page.getByRole("link", { name: "已确认定稿", exact: true })).toHaveAttribute("aria-current", "page");
    await page.getByRole("link", { name: "查看定稿", exact: true }).click();
    await expect(page.locator(".tiptap")).toContainText("固定参考后再逐镜核对。"); await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "false");
    await expect(page.locator(".tiptap")).not.toContainText("离开正文也要保留的口播。");
    await page.getByRole("link", { name: "返回历史稿件", exact: true }).click(); await page.getByRole("link", { name: "未完成草稿", exact: true }).click();
    await expect(page.getByRole("link", { name: "继续编辑", exact: true }).first()).toBeVisible();
  } finally { await page.close(); await browser.close(); await web.stop(); }
});
