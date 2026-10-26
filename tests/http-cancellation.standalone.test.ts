import "./setup.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { fetchListing } from "@aihot/backend/sources/listing-fetch";
import { listenHttpForFetch } from "./http-listener.ts";

const previousPrivate = config.allowPrivateNetworkFetch;
config.allowPrivateNetworkFetch = true;
after(() => { config.allowPrivateNetworkFetch = previousPrivate; });

test("取消采集会中断仍在传输的正文并关闭连接，保留调用方取消原因", async () => {
  const controller = new AbortController();
  const cancelled = new Error("collection job cancelled");
  let upstreamClosed: Promise<unknown> | undefined;
  const server = createServer((_req, res) => {
    upstreamClosed = once(res, "close");
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("partial body");
    setImmediate(() => controller.abort(cancelled));
  });
  const origin = await listenHttpForFetch(server);
  try {
    await assert.rejects(guardedFetch(origin + "/stream", { signal: controller.signal, timeoutMs: 1000 }),
      error => error === cancelled);
    assert.ok(upstreamClosed, "真实上游必须已经开始传输");
    await upstreamClosed;
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("新闻请求退避等待期间取消会立即结束，不等待下一次重试", async () => {
  const controller = new AbortController();
  const cancelled = new Error("collection cancelled during retry backoff");
  let hits = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const server = createServer((_req, res) => {
    hits++;
    res.once("finish", () => { timer = setTimeout(() => controller.abort(cancelled), 30); });
    res.writeHead(503); res.end("temporarily unavailable");
  });
  const origin = await listenHttpForFetch(server);
  const started = Date.now();
  try {
    await assert.rejects(fetchListing(origin, { signal: controller.signal, timeoutMs: 2500 }), error => error === cancelled);
    assert.ok(Date.now() - started < 500, "取消不应继续等待原有1秒重试退避");
    assert.equal(hits, 1, "取消后不应再次访问上游");
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
