import assert from "node:assert/strict";
import { createServer, Server } from "node:http";
import { test } from "node:test";
import { listenHttpForFetch } from "./http-listener.ts";

test("本地HTTP替身遇到Windows拒绝的端口时换端口，有界重试后仍使用真实HTTP", async t => {
  const original = Server.prototype.listen;
  let attempts = 0;
  t.mock.method(Server.prototype, "listen", function (this: Server, ...args: Parameters<typeof original>) {
    if (++attempts <= 2) {
      queueMicrotask(() => this.emit("error", Object.assign(new Error("test-excluded-port"), { code: "EACCES" })));
      return this;
    }
    return original.apply(this, args);
  });
  const server = createServer((_req, res) => res.end("real-http-after-denial"));
  try {
    const url = await listenHttpForFetch(server);
    assert.ok(attempts >= 3 && attempts <= 10);
    assert.equal(await (await fetch(url)).text(), "real-http-after-denial");
    assert.equal(server.listenerCount("error"), 0);
  } finally { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("所有候选端口都被拒绝时十次后终止，其他系统错误直接保留", async t => {
  let attempts = 0, code = "EACCES";
  t.mock.method(Server.prototype, "listen", function (this: Server) {
    attempts++;
    queueMicrotask(() => this.emit("error", Object.assign(new Error("test-listen-fault"), { code })));
    return this;
  });
  await assert.rejects(() => listenHttpForFetch(createServer()), /after 10 attempts/);
  assert.equal(attempts, 10);
  code = "EIO"; attempts = 0;
  await assert.rejects(() => listenHttpForFetch(createServer()), { code: "EIO" });
  assert.equal(attempts, 1);
});
