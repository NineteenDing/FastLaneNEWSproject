import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { createServer } from "node:http";
import { listenHttpForFetch } from "../../../tests/http-listener.ts";
import { withCollectorPage } from "../backend/collector-browser.ts";

const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
after(async () => { setGlobalDispatcher(previous); await transport.close(); });

test("采集浏览器真实执行同源页面和POST，只经受控HTTP传送本平台Cookie，结束后页面已关闭", async () => {
  const api = transport.get("https://tieba.baidu.com");
  const headers = { cookie: "BDUSS=private-tieba-session" };
  api.intercept({ path: "/", headers })
    .reply(200, "<html><title>贴吧采集测试</title><body>作者主页</body></html>", { headers: { "content-type": "text/html; charset=utf-8" } });
  api.intercept({ path: "/c/f/pb/page_pc", method: "POST", body: value => Buffer.from(value).toString("utf8") === "kz=12345&pn=1", headers })
    .reply(200, { error_code: 0, data: { text: "先固定角色，再安排分镜。" } });
  let closed = () => false;
  const result = await withCollectorPage({ platform: "tieba", cookie: "BDUSS=private-tieba-session" }, async page => {
    closed = () => page.isClosed();
    await page.goto("https://tieba.baidu.com/", { waitUntil: "domcontentloaded" });
    assert.equal(await page.title(), "贴吧采集测试");
    return page.evaluate(async () => {
      const response = await fetch("/c/f/pb/page_pc", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "kz=12345&pn=1", credentials: "include" });
      return response.json();
    });
  });
  assert.equal((result as { data: { text: string } }).data.text, "先固定角色，再安排分镜。");
  assert.equal(closed(), true);
  transport.assertNoPendingInterceptors();
});

test("同一运行器已有采集浏览器时拒绝再开，结束后可以重新使用", async () => {
  await withCollectorPage({ platform: "tieba", cookie: "" }, async () => {
    await assert.rejects(withCollectorPage({ platform: "tieba", cookie: "" }, async () => true), /已有采集浏览器/);
  });
  assert.equal(await withCollectorPage({ platform: "tieba", cookie: "" }, async page => page.isClosed()), false);
});

test("建立平台同源环境时不执行来源页面脚本，原客户端的受控读取仍可运行", async () => {
  transport.get("https://tieba.baidu.com").intercept({ path: "/" }).reply(200, "<html><script>window.sourceScriptExecuted=true</script><body>origin</body></html>", { headers: { "content-type": "text/html" } });
  const executed = await withCollectorPage({ platform: "tieba", cookie: "" }, async page => {
    await page.goto("https://tieba.baidu.com/");
    return page.evaluate("Boolean(window.sourceScriptExecuted)");
  });
  assert.equal(executed, false);
  transport.assertNoPendingInterceptors();
});

test("平台页面只能读取已接入的PC接口，不能发帖或执行其他平台动作", async () => {
  let writes = 0;
  const denied = new MockAgent(); denied.disableNetConnect(); setGlobalDispatcher(denied);
  denied.get("https://tieba.baidu.com").intercept({ path: "/" }).reply(200, "<html></html>", { headers: { "content-type": "text/html" } });
  denied.get("https://tieba.baidu.com").intercept({ path: "/c/c/post/add", method: "POST" }).reply(() => {
    writes++; return { statusCode: 200, data: { error_code: 0 } };
  });
  try { await assert.rejects(withCollectorPage({ platform: "tieba", cookie: "" }, async page => {
    await page.goto("https://tieba.baidu.com/");
    await page.evaluate(async () => { await fetch("/c/c/post/add", { method: "POST", body: "content=should-never-be-sent" }).catch(() => null); });
  }), /采集页面未能完成/);
  assert.equal(writes, 0);
  } finally { setGlobalDispatcher(transport); await denied.close(); }
});

test("页面请求和绕过页面路由的原生请求均不能直达本机地址", async () => {
  let connections = 0;
  const target = createServer((_request, response) => response.end("private"));
  target.on("connection", () => connections++);
  const local = (await listenHttpForFetch(target)).replace("http:", "https:") + "/secret";
  try {
    transport.get("https://tieba.baidu.com").intercept({ path: "/" }).reply(200, "<html><body>only this platform</body></html>", { headers: { "content-type": "text/html" } });
    await assert.rejects(withCollectorPage({ platform: "tieba", cookie: "" }, async page => {
      await page.goto("https://tieba.baidu.com/");
      assert.equal(await page.evaluate(async url => { try { await fetch(url); return true; } catch { return false; } }, local), false);
      await page.goto(local);
    }), /采集页面未能完成/);
    const nativeDenied = await withCollectorPage({ platform: "tieba", cookie: "" }, async page => {
      try { await page.context().request.get(local, { timeout: 1500 }); return false; } catch { return true; }
    });
    assert.equal(nativeDenied, true); assert.equal(connections, 0);
    transport.assertNoPendingInterceptors();
  } finally { target.closeAllConnections(); await new Promise<void>(resolve => target.close(() => resolve())); }
});

test("取消活动页面请求时等待浏览器关闭并释放执行位，未完成内容不当成功", async () => {
  const controller = new AbortController();
  let reached!: () => void, closed = () => false;
  const reading = new Promise<void>(resolve => { reached = resolve; });
  transport.get("https://tieba.baidu.com").intercept({ path: "/" }).reply(() => {
    reached(); return { statusCode: 200, data: "<html><body>late</body></html>" };
  }).delay(2000);
  const running = withCollectorPage({ platform: "tieba", cookie: "", signal: controller.signal }, async page => {
    closed = () => page.isClosed(); await page.goto("https://tieba.baidu.com/"); return "late";
  });
  await reading; controller.abort();
  await assert.rejects(running, /采集页面未能完成/); assert.equal(closed(), true);
  assert.equal(await withCollectorPage({ platform: "tieba", cookie: "" }, async page => page.isClosed()), false);
  transport.assertNoPendingInterceptors();
});

test("快手签名页可执行官方静态脚本但不向CDN发送平台Cookie，也不能从页面提交GraphQL动作", async () => {
  const api = transport.get("https://www.kuaishou.com");
  api.intercept({ path: "/?isHome=1", headers: { cookie: "did=private-page-cookie" } }).reply(200,
    '<html><script src="https://static.yximgs.com/fixture-sdk.js"></script><body>SDK boundary fixture</body></html>', { headers: { "content-type": "text/html" } });
  transport.get("https://static.yximgs.com").intercept({ path: "/fixture-sdk.js", headers: headers => !headers.cookie && !headers.authorization })
    .reply(200, "window.fixtureSDKReady=true;", { headers: { "content-type": "application/javascript" } });
  const result = await withCollectorPage({ platform: "kuaishou", cookie: "did=private-page-cookie" }, async page => {
    await page.goto("https://www.kuaishou.com/?isHome=1", { waitUntil: "load" });
    assert.equal(await page.evaluate("window.fixtureSDKReady"), true);
    return page.evaluate(async () => {
      try { await fetch("/graphql", { method: "POST", body: '{"query":"mutation{follow}"}' }); return true; }
      catch { return false; }
    });
  });
  assert.equal(result, false);
  transport.assertNoPendingInterceptors();
});
