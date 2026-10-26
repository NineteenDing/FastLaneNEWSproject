import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { tiebaFixture } from "./tieba-fixture.ts";

const { app, headers } = await sourceResourceFixture();
const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
after(async () => { await app.close(); await stopBoss(); await closeDb(); setGlobalDispatcher(previous); await transport.close(); });
async function runImport() {
  const queue = SERVER_MODULES.find(module => module.name === "studio")!.queues!.find(queue => queue.name === "studio.content.import")!;
  const boss = await getBoss(), [job] = await boss.fetch(queue.name); assert.ok(job);
  await queue.run([job.data] as never[]); await boss.complete(queue.name, job.id);
}

test("知乎回答与文章原文按类型隔离同号身份，保留真实作者及所属问题且不自动关注", async () => {
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/zhihu", headers,
    payload: { version: 0, cookie: "d_c0=private-single-device; z_c0=private-single-login" } })).statusCode, 200);
  const profile = { id: "stable-author", urlToken: "film-creator", name: "镜头制作手记", headline: "分享镜头方法" };
  const commonHeaders = { cookie: "d_c0=private-single-device; z_c0=private-single-login", "x-zse-93": "101_3_3.0", "x-zse-96": /^2\.0_/, "x-zst-81": /^3_2\.0/ };
  for (const sample of [
    { url: "https://www.zhihu.com/question/77001/answer/88001?utm_source=copy", kind: "answer", origin: "https://www.zhihu.com", path: "/question/77001/answer/88001", body: "固定角色参考，再检查镜头连续性。", title: "如何保持角色一致？" },
    { url: "https://zhuanlan.zhihu.com/p/88001", kind: "article", origin: "https://zhuanlan.zhihu.com", path: "/p/88001", body: "把分镜输入与检查点写成清单。", title: "分镜工作流" },
  ]) {
    const result = await app.inject({ method: "POST", url: "/api/admin/studio/content-imports", headers, payload: { url: sample.url } });
    assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().queued, true);
    const raw = { id: 88001, type: sample.kind, author: "stable-author", question: "77001", title: sample.title, content: `<p>${sample.body}</p>`, createdTime: 1792231200, commentCount: 0, voteupCount: 218 };
    const state = { initialState: { entities: { users: { "stable-author": profile }, questions: { "77001": { id: 77001, title: "如何保持角色一致？" } }, [sample.kind === "answer" ? "answers" : "articles"]: { "88001": raw } } } };
    transport.get(sample.origin).intercept({ path: sample.path, headers: commonHeaders }).reply(200, `<script id="js-initialData">${JSON.stringify(state)}</script>`);
    await runImport();
    const item = (await app.inject({ url: "/api/admin/studio/content-imports", headers })).json().rows.find((row: { id: string }) => row.id === result.json().item.id);
    assert.equal(item.state, "ready");
    const material = (await app.inject({ url: `/api/admin/studio/intelligence/${item.materialId}`, headers })).json();
    assert.equal(material.kind, sample.kind); assert.equal(material.body, sample.body); assert.equal(material.title, sample.title);
    assert.equal(material.source.name, "镜头制作手记"); assert.equal(material.source.homepage, "https://www.zhihu.com/people/film-creator");
    assert.equal(material.metrics.likes, 218);
    if (sample.kind === "answer") assert.equal(material.parent.url, "https://www.zhihu.com/question/77001");
  }
  assert.equal((await app.inject({ url: "/api/admin/studio/intelligence?platform=zhihu", headers })).json().total, 2);
  assert.equal((await app.inject({ url: "/api/admin/studio/creators", headers })).json().total, 0);
  const followed = await app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url: "https://www.zhihu.com/people/film-creator" } });
  assert.equal(followed.statusCode, 200); assert.equal(followed.json().creator.collectedCount, 2);
  transport.assertNoPendingInterceptors();
});

test("贴吧单帖子复用原PC详情及楼层解析，不扫描作者主页或把首楼当作评论", async () => {
  await app.inject({ method: "PUT", url: "/api/admin/studio/platform-sessions/tieba", headers, payload: { version: 0, cookie: "BDUSS=private-tieba-cookie" } });
  const submitted = await app.inject({ method: "POST", url: "/api/admin/studio/content-imports", headers, payload: { url: "https://tieba.baidu.com/p/99001?share=copy" } });
  assert.equal(submitted.statusCode, 200, submitted.body);
  tiebaFixture(transport, { single: true });
  await runImport();
  const item = (await app.inject({ url: "/api/admin/studio/content-imports", headers })).json().rows.find((row: { id: string }) => row.id === submitted.json().item.id);
  assert.equal(item.state, "ready");
  const material = (await app.inject({ url: `/api/admin/studio/intelligence/${item.materialId}`, headers })).json();
  assert.equal(material.kind, "post"); assert.equal(material.body, "先锁定角色参考，再切换不同景别。");
  assert.equal(material.source.name, "漫剧镜头研究"); assert.equal(material.source.homepage, "https://tieba.baidu.com/home/main?id=tb.fixture");
  assert.equal(material.comments.length, 1); assert.equal(material.comments[0].floor, 2); assert.equal(material.commentCoverage.complete, false);
  const repeated = await app.inject({ method: "POST", url: "/api/admin/studio/content-imports", headers, payload: { url: "https://tieba.baidu.com/p/99001" } });
  assert.equal(repeated.json().queued, false); assert.equal(repeated.json().item.materialId, item.materialId);
  assert.equal((await app.inject({ url: "/api/admin/studio/creators?platform=tieba", headers })).json().total, 0);
  transport.assertNoPendingInterceptors();
});

test("原文链接拒绝伪装主机与无具体内容地址，返回了其他问题的回答不能入库", async () => {
  for (const url of ["https://www.zhihu.com.evil.example/question/77001/answer/88001", "https://www.zhihu.com/question/77001",
    "http://zhuanlan.zhihu.com/p/88001", "https://tieba.baidu.com.evil.example/p/99001"])
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/studio/content-imports", headers, payload: { url } })).statusCode, 400);
  const submitted = await app.inject({ method: "POST", url: "/api/admin/studio/content-imports", headers, payload: { url: "https://www.zhihu.com/question/77001/answer/99802" } });
  assert.equal(submitted.statusCode, 200);
  const entities = { answers: { "99802": { id: 99802, type: "answer", question: { id: 99999, title: "其他问题" }, content: "不应保存的原文",
    author: { id: "another-user", urlToken: "another-user", name: "其他作者" } } } };
  transport.get("https://www.zhihu.com").intercept({ path: "/question/77001/answer/99802" }).reply(200, `<script id="js-initialData">${JSON.stringify({ initialState: { entities } })}</script>`);
  await assert.rejects(runImport(), /未完成导入/);
  const item = (await app.inject({ url: "/api/admin/studio/content-imports", headers })).json().rows.find((row: { id: string }) => row.id === submitted.json().item.id);
  assert.equal(item.state, "failed"); assert.equal(item.materialId, null);
  assert.equal((await app.inject({ url: "/api/admin/studio/intelligence?platform=zhihu", headers })).json().total, 2);
  transport.assertNoPendingInterceptors();
});
