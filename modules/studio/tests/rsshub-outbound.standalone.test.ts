import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { gzipSync } from "node:zlib";
import { after, mock, test } from "node:test";
import { config } from "@aihot/backend/config";
import { listenHttpForFetch } from "../../../tests/http-listener.ts";
import { createRsshubOutbound } from "../backend/rsshub-outbound.ts";

const previousPrivate = config.allowPrivateNetworkFetch;
config.allowPrivateNetworkFetch = true;
after(() => { config.allowPrivateNetworkFetch = previousPrivate; });

test("RSSHub的并发正文请求至多两个，槽位覆盖完整正文下载而非只到响应头", async () => {
  let active = 0, peak = 0, hits = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const upstream = createServer((_req, res) => {
    hits++; active++; peak = Math.max(peak, active);
    res.once("finish", () => { active--; });
    res.writeHead(200, { "content-type": "text/plain" }); res.write("start-");
    const timer = setTimeout(() => { timers.delete(timer); res.end("complete"); }, 75);
    timers.add(timer);
  });
  const origin = await listenHttpForFetch(upstream);
  const outbound = createRsshubOutbound();
  try {
    const responses = await Promise.all(["one", "two", "three"].map(id => outbound.fetch(origin + "/" + id)));
    assert.equal(peak, 2);
    assert.equal(hits, 3);
    assert.deepEqual(await Promise.all(responses.map(response => response.text())), Array(3).fill("start-complete"));
    assert.equal(responses[0]!.url, origin + "/one");
  } finally {
    outbound.close();
    for (const timer of timers) clearTimeout(timer);
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

test("RSSHub适配继续拒绝私网与混合DNS答案，不扩大普通来源访问权限", async () => {
  let hits = 0;
  const upstream = createServer((_req, res) => { hits++; res.end("must not be read"); });
  const origin = await listenHttpForFetch(upstream);
  const outbound = createRsshubOutbound();
  config.allowPrivateNetworkFetch = false;
  mock.method(dns, "lookup", async (host: string) => {
    assert.equal(host, "rsshub-network.invalid");
    return [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }];
  });
  syncBuiltinESMExports();
  try {
    for (const address of [origin, "http://169.254.169.254/", "http://[::1]/", "http://rsshub-network.invalid/"]) {
      await assert.rejects(outbound.fetch(address), /Blocked/);
    }
    assert.equal(hits, 0);
    assert.equal(config.allowPrivateNetworkFetch, false);
  } finally {
    mock.restoreAll(); syncBuiltinESMExports(); config.allowPrivateNetworkFetch = true;
    outbound.close(); upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

test("RSSHub响应按解压后实际字节限制8MiB，已解压正文不保留误导性的压缩头", async () => {
  const normal = gzipSync("完整正文");
  const oversized = gzipSync(Buffer.alloc(8 * 1024 * 1024 + 1, 65));
  const upstream = createServer((req, res) => {
    const body = req.url === "/oversized" ? oversized : normal;
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-encoding": "gzip", "content-length": String(body.length) });
    res.end(body);
  });
  const origin = await listenHttpForFetch(upstream);
  const outbound = createRsshubOutbound();
  try {
    const response = await outbound.fetch(origin + "/normal");
    assert.equal(await response.text(), "完整正文");
    assert.equal(response.headers.get("content-encoding"), null);
    assert.equal(response.headers.get("content-length"), null);
    await assert.rejects(outbound.fetch(origin + "/oversized"), /too large/i);
  } finally {
    outbound.close(); upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

test("RSSHub要求手动或禁止重定向时不擅自访问下一地址", async () => {
  let finalHits = 0;
  const upstream = createServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { location: "/final" }); res.end("redirect body"); }
    else { finalHits++; res.end("destination"); }
  });
  const origin = await listenHttpForFetch(upstream);
  const outbound = createRsshubOutbound();
  try {
    const response = await outbound.fetch(origin + "/redirect", { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/final");
    assert.equal(response.redirected, false);
    await assert.rejects(outbound.fetch(origin + "/redirect", { redirect: "error" }), /redirect/i);
    assert.equal(finalHits, 0);
  } finally {
    outbound.close(); upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

test("取消任务也能终止尚未读完的请求体，不把慢请求体留在并发槽位", async () => {
  const controller = new AbortController();
  const cancelled = new Error("cancel while reading request body");
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(stream) { streamController = stream; stream.enqueue(new Uint8Array([65])); } });
  let hits = 0;
  const upstream = createServer((_req, res) => { hits++; res.end("unexpected"); });
  const origin = await listenHttpForFetch(upstream);
  const outbound = createRsshubOutbound({ signal: controller.signal });
  const finished = outbound.fetch(origin, { method: "POST", body, duplex: "half" } as RequestInit)
    .then(response => ({ response, error: undefined }), error => ({ response: undefined, error }));
  const cancelTimer = setTimeout(() => controller.abort(cancelled), 20);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([finished, new Promise<null>(resolve => { deadline = setTimeout(() => resolve(null), 500); })]);
    assert.ok(result, "取消不应等待尚未结束的请求体");
    assert.equal(result.error, cancelled);
    assert.equal(hits, 0);
  } finally {
    clearTimeout(cancelTimer); clearTimeout(deadline);
    try { streamController.close(); } catch { /* cancellation already closed it */ }
    outbound.close(); await finished; upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

test("RSSHub出站拒绝超过1MiB的实际请求体，不信任缺失的Content-Length且不先发送", async () => {
  let hits = 0;
  const upstream = createServer(async (req, res) => {
    hits++; for await (const _chunk of req) { /* consume the request */ }
    res.end("accepted");
  });
  const origin = await listenHttpForFetch(upstream);
  const outbound = createRsshubOutbound();
  try {
    const body = new ReadableStream<Uint8Array>({ start(stream) {
      stream.enqueue(new Uint8Array(1024 * 1024)); stream.enqueue(new Uint8Array(1)); stream.close();
    } });
    await assert.rejects(outbound.fetch(origin, { method: "POST", body, duplex: "half" } as RequestInit), /请求体超过1MiB/);
    assert.equal(hits, 0);
  } finally {
    outbound.close(); upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

test("RSSHub接口的POST内容按原字节与类型发送，不把二进制正文转为乱码", async () => {
  const bytes = Uint8Array.from([0, 255, 128, 65]);
  let observed: Buffer | undefined;
  let contentType: string | undefined;
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    observed = Buffer.concat(chunks); contentType = req.headers["content-type"];
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"accepted":true}');
  });
  const origin = await listenHttpForFetch(upstream);
  const outbound = createRsshubOutbound();
  try {
    const response = await outbound.fetch(new Request(origin, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes }));
    assert.deepEqual(await response.json(), { accepted: true });
    assert.deepEqual(observed, Buffer.from([0, 255, 128, 65]));
    assert.equal(contentType, "application/octet-stream");
  } finally {
    outbound.close(); upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

test("取消RSSHub任务会同时停止活动正文与排队请求，排队地址不会被访问", async () => {
  const controller = new AbortController();
  const cancelled = new Error("RSSHub job cancelled by caller");
  let hits = 0;
  const upstream = createServer((_req, res) => {
    hits++; res.writeHead(200); res.write("partial");
    if (hits === 2) setImmediate(() => controller.abort(cancelled));
  });
  const origin = await listenHttpForFetch(upstream);
  const outbound = createRsshubOutbound({ signal: controller.signal });
  const finished = Promise.allSettled(["first", "second", "queued"].map(id => outbound.fetch(origin + "/" + id)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const results = await Promise.race([finished,
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 500); })]);
    assert.ok(results, "任务取消必须立即释放两个活动请求和排队请求");
    assert.equal(hits, 2);
    for (const result of results) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") assert.equal(result.reason, cancelled);
    }
  } finally {
    clearTimeout(timer); outbound.close();
    upstream.closeAllConnections();
    await finished;
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
