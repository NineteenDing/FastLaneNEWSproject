import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { sourceResourceFixture } from "./source-resource-fixture.ts";

const { app, headers } = await sourceResourceFixture();
const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
after(async () => { await app.close(); await stopBoss(); await closeDb(); setGlobalDispatcher(previous); await transport.close(); });
const follow = (url: string) => app.inject({ method: "POST", url: "/api/admin/studio/creators", headers, payload: { url } });

test("粘贴五平台主页分享短链或分享文案，受控重定向到完整主页并复用同一关注身份", async () => {
  const examples = [
    { short: "https://b23.tv/Creator42", target: "https://space.bilibili.com/20813884?share_source=copy", platform: "bilibili" },
    { short: "https://v.douyin.com/Creator42/", target: "https://www.douyin.com/user/MS4wLjABAAAAexample?from=copy", platform: "douyin" },
    { short: "https://v.kuaishou.com/Creator42", target: "https://www.kuaishou.com/profile/3x84qugg4ch9zhs", platform: "kuaishou" },
    { short: "https://xhslink.com/m/Creator42", target: "https://www.xiaohongshu.com/user/profile/5eb8e1d400000000010075ae?xsec_token=private-share-token&xsec_source=app_share", platform: "xhs" },
    { short: "https://t.cn/Creator42", target: "https://weibo.com/u/5756404150", platform: "weibo" },
  ];
  for (const example of examples) {
    const url = new URL(example.short);
    transport.get(url.origin).intercept({ path: url.pathname }).reply(302, "", { headers: { location: example.target } });
    const created = await follow(`分享这位创作者的主页：${example.short}，复制后打开。`);
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(created.json().creator.platform, example.platform);
    assert.equal(created.json().creator.profileState, "pending");
    const repeated = await follow(example.target);
    assert.equal(repeated.statusCode, 200); assert.equal(repeated.json().created, false);
    assert.equal(repeated.json().creator.id, created.json().creator.id);
    assert.ok(!created.body.includes("private-share-token"));
  }
  assert.equal((await app.inject({ url: "/api/admin/studio/creators", headers })).json().total, 5);
  transport.assertNoPendingInterceptors();
});

test("失效、循环、跨平台、作品或非白名单跳转不访问目标且不创建关注，错误不回显分享凭据", async () => {
  const before = (await app.inject({ url: "/api/admin/studio/creators", headers })).json().total;
  const cases = [
    { path: "/BadPrivate", location: "http://127.0.0.1:4311/admin?secret=private-share-secret" },
    { path: "/BadHost", location: "https://www.douyin.com.evil.example/user/example" },
    { path: "/WrongPlatform", location: "https://space.bilibili.com/55555" },
    { path: "/VideoInstead", location: "https://www.douyin.com/video/12345" },
    { path: "/Credentials", location: "https://private-user:private-share-secret@www.douyin.com/user/example" },
    { path: "/Loop", location: "https://v.douyin.com/Loop" },
  ];
  for (const value of cases) {
    transport.get("https://v.douyin.com").intercept({ path: value.path }).reply(302, "", { headers: { location: value.location } });
    const rejected = await follow("https://v.douyin.com" + value.path);
    assert.equal(rejected.statusCode, 400, rejected.body); assert.ok(!rejected.body.includes("private-share-secret"));
  }
  transport.get("https://b23.tv").intercept({ path: "/Expired" }).reply(200, "此分享已失效");
  assert.equal((await follow("https://b23.tv/Expired")).statusCode, 400);
  for (const url of ["https://v.douyin.com.evil.example/abc", "https://unknown.example/abc", "https://b23.tv/a https://b23.tv/b", "http://127.0.0.1/a", "没有链接"]) {
    assert.equal((await follow(url)).statusCode, 400);
  }
  assert.equal((await app.inject({ url: "/api/admin/studio/creators", headers })).json().total, before);
  transport.assertNoPendingInterceptors();
});
