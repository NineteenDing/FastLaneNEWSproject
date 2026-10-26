import assert from "node:assert/strict";
import { createServer, Server } from "node:http";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { startWebServer } from "../apps/web/tests/web-server.ts";

test("网页测试在系统临时端口包含浏览器禁用端口时仍可打开真实登录页", async t => {
  const original = Server.prototype.listen;
  let ephemeral = 0;
  t.mock.method(Server.prototype, "listen", function (this: Server, ...args: Parameters<typeof original>) {
    const values: unknown[] = [...args];
    if (values[0] === 0) values[0] = ephemeral++ === 0 ? 6667 : 6697;
    return original.apply(this, values as Parameters<typeof original>);
  });
  const api = createServer((req, res) => {
    res.writeHead(req.url === "/api/site/meta" ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/api/site/meta" ? { changelogVersion: null } : { error: "unauthorized" }));
  });
  const web = await startWebServer(api);
  try {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const response = await page.goto(web.origin + "/admin/login");
      assert.equal(response?.status(), 200);
      await page.locator('input[type="password"]').waitFor({ state: "visible" });
    } finally { await browser.close(); }
  } finally { await web.stop(); }
});
