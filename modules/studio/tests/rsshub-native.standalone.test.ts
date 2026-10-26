import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { config } from "@aihot/backend/config";
import { listenHttpForFetch } from "../../../tests/http-listener.ts";
import { readNativeRsshub } from "../backend/rsshub-native.ts";
import { runWindowsProcessGroup } from "../backend/windows-process-group.ts";

async function nativeFixture() {
  await mkdir(".local", { recursive: true });
  const folder = await mkdtemp(path.resolve(".local/native-rsshub-test-"));
  await mkdir(path.join(folder, "dist"));
  return folder;
}
async function removeNativeFixture(folder: string) {
  assert.ok(path.resolve(folder).startsWith(path.resolve(".local") + path.sep));
  await rm(folder, { recursive: true, force: true });
}

// The installed third-party application is the external seam. Fixtures are not real RSSHub.
test("原生RSSHub任务在独立进程请求受控上游，返回完整订阅后退出", async () => {
  const feed = '<rss version="2.0"><channel><title>新闻源</title><item><title>隔离任务的新闻</title><link>https://publisher.example/news</link></item></channel></rss>';
  let hits = 0;
  const upstream = createServer((_req, res) => {
    hits++; res.writeHead(200, { "content-type": "application/rss+xml" }); res.end(feed);
  });
  const origin = await listenHttpForFetch(upstream);
  await mkdir(".local", { recursive: true });
  const folder = await nativeFixture();
  // A live interval makes process ownership significant: the job must end this child itself.
  await writeFile(path.join(folder, "dist/index.mjs"), `setInterval(() => {}, 1000); export default { fetch: () => fetch(${JSON.stringify(origin + "/feed")}) };`);
  const previous = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  try {
    const result = await readNativeRsshub("/fixture", 1, { runtimeDirectory: folder });
    assert.equal(result.status, 200);
    assert.equal(result.text(), feed);
    assert.equal(result.headers.get("content-type"), "application/rss+xml");
    assert.equal(hits, 1);
  } finally {
    config.allowPrivateNetworkFetch = previous;
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await removeNativeFixture(folder);
  }
});

test("RSSHub独立进程不能再启动额外程序或绕过任务资源管理", async () => {
  const folder = await nativeFixture();
  await writeFile(path.join(folder, "dist/index.mjs"), `import {execFileSync} from 'node:child_process';
    export default {fetch:()=>{try { execFileSync(process.execPath,['-e','process.stdout.write("child-running")'],{windowsHide:true}); return new Response('启动了额外程序'); }
    catch(error){if(error.code!=='ERR_ACCESS_DENIED')throw error; return new Response('已阻止额外子进程');}}};`);
  try {
    assert.equal((await readNativeRsshub("/fixture", 1, { runtimeDirectory: folder })).text(), "已阻止额外子进程");
  } finally {
    await removeNativeFixture(folder);
  }
});

test("RSSHub处理材料时不触发trace遥测网络请求", async () => {
  let telemetryHits = 0;
  const telemetry = createServer((_req, res) => { telemetryHits++; res.end("unexpected telemetry"); });
  const origin = await listenHttpForFetch(telemetry);
  const folder = await nativeFixture();
  const sdkFolder = path.join(folder, "node_modules/@opentelemetry/sdk-trace-base");
  await mkdir(sdkFolder, { recursive: true });
  await writeFile(path.join(sdkFolder, "package.json"), JSON.stringify({ type: "module", exports: "./index.mjs" }));
  await writeFile(path.join(sdkFolder, "index.mjs"), `export class AlwaysOffSampler { shouldSample(){return {decision:0};} }
    export class BasicTracerProvider { constructor(options){this.options=options;}
      getTracer(){const options=this.options;return {startSpan(){return {addEvent(){},end(){
        if ((options.sampler?.shouldSample().decision ?? 1)>0) for(const processor of options.spanProcessors) processor.onEnd();
      }}}};} }`);
  await writeFile(path.join(folder, "dist/index.mjs"), `import http from 'node:http'; import {BasicTracerProvider} from '@opentelemetry/sdk-trace-base';
    const provider=new BasicTracerProvider({spanProcessors:[{onEnd(){http.get(${JSON.stringify(origin)});}}]});
    export default {fetch:()=>{const span=provider.getTracer().startSpan('collect');span.addEvent('done');span.end();return new Response('正常材料正文');}};`);
  try {
    const response = await readNativeRsshub("/fixture", 1, { runtimeDirectory: folder });
    assert.equal(response.text(), "正常材料正文");
    assert.equal(telemetryHits, 0);
  } finally {
    telemetry.closeAllConnections();
    await new Promise<void>(resolve => telemetry.close(() => resolve()));
    await removeNativeFixture(folder);
  }
});

test("RSSHub的Prometheus导出器沿用原实现但禁用额外HTTP监听", async () => {
  const folder = await nativeFixture();
  const exporterFolder = path.join(folder, "node_modules/@opentelemetry/exporter-prometheus");
  await mkdir(exporterFolder, { recursive: true });
  await writeFile(path.join(exporterFolder, "package.json"), JSON.stringify({ type: "module", exports: "./index.mjs" }));
  await writeFile(path.join(exporterFolder, "index.mjs"), `import {createServer} from 'node:http';
    export class PrometheusExporter { constructor(options={}) { if(!options.preventServerStart) createServer().listen(0); } collect(){return '原采集能力保留';} }
    export class PrometheusSerializer { serialize(value){return value;} }`);
  await writeFile(path.join(folder, "dist/index.mjs"), `import {PrometheusExporter,PrometheusSerializer} from '@opentelemetry/exporter-prometheus';
    const exporter=new PrometheusExporter({}); const serializer=new PrometheusSerializer();
    export default {fetch:()=>new Response(serializer.serialize(exporter.collect()))};`);
  try {
    assert.equal((await readNativeRsshub("/fixture", 1, { runtimeDirectory: folder })).text(), "原采集能力保留");
  } finally {
    await removeNativeFixture(folder);
  }
});

test("原生入口复用Hono的fetch处理，不在RSSHub子进程额外监听端口", async () => {
  const folder = await nativeFixture();
  const serverFolder = path.join(folder, "node_modules/@hono/node-server");
  await mkdir(serverFolder, { recursive: true });
  await writeFile(path.join(serverFolder, "package.json"), JSON.stringify({ name: "@hono/node-server", type: "module", exports: "./index.mjs" }));
  await writeFile(path.join(serverFolder, "index.mjs"), `import { createServer } from 'node:http';
    export function serve() { const server=createServer(); server.listen(0); return server; }`);
  await writeFile(path.join(folder, "dist/index.mjs"), `import {serve} from '@hono/node-server';
    export default serve({fetch:()=>new Response('复用应用处理器')});`);
  try {
    assert.equal((await readNativeRsshub("/fixture", 1, { runtimeDirectory: folder })).text(), "复用应用处理器");
  } finally {
    await removeNativeFixture(folder);
  }
});

test("rss-parser的URL读取改走受控通路，保留原解析器和构造时请求头", async () => {
  const feed = '<rss><channel><title>量子位测试订阅</title></channel></rss>';
  let header: string | undefined;
  const upstream = createServer((req, res) => { header = req.headers["x-parser"] as string; res.end(feed); });
  const origin = await listenHttpForFetch(upstream);
  const folder = await nativeFixture();
  const parserFolder = path.join(folder, "node_modules/rss-parser");
  await mkdir(parserFolder, { recursive: true });
  await writeFile(path.join(parserFolder, "package.json"), JSON.stringify({ name: "rss-parser", type: "module", exports: "./index.mjs" }));
  await writeFile(path.join(parserFolder, "index.mjs"), `import http from 'node:http'; export default class Parser {
    constructor(options) { this.options=options; }
    parseString(raw) { return Promise.resolve({ raw }); }
    parseURL(url) { return new Promise((resolve,reject)=>http.get(url,()=>resolve({raw:'uncontrolled'})).on('error',reject)); }
  }`);
  await writeFile(path.join(folder, "dist/index.mjs"), `import Parser from 'rss-parser'; const parser=new Parser({headers:{'x-parser':'preserved'}});
    export default { fetch: async()=>new Response((await parser.parseURL(${JSON.stringify(origin)})).raw) };`);
  const previous = config.allowPrivateNetworkFetch; config.allowPrivateNetworkFetch = true;
  try {
    assert.equal((await readNativeRsshub("/fixture", 1, { runtimeDirectory: folder })).text(), feed);
    assert.equal(header, "preserved");
  } finally {
    config.allowPrivateNetworkFetch = previous; upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await removeNativeFixture(folder);
  }
});

test("第三方运行代码不能绕过受控请求直接使用Node HTTP访问网络", async () => {
  let hits = 0;
  const upstream = createServer((_req, res) => { hits++; res.end("uncontrolled"); });
  const origin = await listenHttpForFetch(upstream);
  const folder = await nativeFixture();
  await writeFile(path.join(folder, "dist/index.mjs"), `import http from 'node:http'; export default { fetch: async () => {
    const text = await new Promise((resolve, reject) => { http.get(${JSON.stringify(origin)}, res => { let body=''; res.on('data', chunk=>body+=chunk); res.on('end',()=>resolve(body)); }).on('error', reject); });
    return new Response(text); } };`);
  try {
    await assert.rejects(readNativeRsshub("/fixture", 1, { runtimeDirectory: folder }), /RSSHub独立采集失败/);
    assert.equal(hits, 0);
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await removeNativeFixture(folder);
  }
});

test("上游被安全策略拒绝后，RSSHub捕获错误的备用正文不能冒充完整采集", async () => {
  const folder = await nativeFixture();
  await writeFile(path.join(folder, "dist/index.mjs"), `export default {fetch:async()=>{
    try { await fetch('http://127.0.0.1:80/private'); } catch {}
    return new Response('缺失原文的备用正文');
  }};`);
  try {
    await assert.rejects(readNativeRsshub("/fixture", 1, { runtimeDirectory: folder }), /上游请求未完整完成/);
  } finally {
    await removeNativeFixture(folder);
  }
});

test("RSSHub吞掉未经适配的网络错误也不能返回完整采集", async () => {
  const folder = await nativeFixture();
  await writeFile(path.join(folder, "dist/index.mjs"), `import http from 'node:http'; export default {fetch:()=>{
    try { http.get('http://127.0.0.1:80/private'); } catch {}
    return new Response('未经适配的备用正文');
  }};`);
  try {
    await assert.rejects(readNativeRsshub("/fixture", 1, { runtimeDirectory: folder }), /RSSHub独立采集失败/);
  } finally {
    await removeNativeFixture(folder);
  }
});

test("第三方子进程返回损坏的结果时拒绝任务，父进程仍可继续采集", async () => {
  const folder = await nativeFixture();
  await writeFile(path.join(folder, "dist/index.mjs"), `process.send({type:'result',status:200,headers:{'x-broken':'a\\nb'},body:'eA=='});
    await new Promise(()=>{});`);
  try {
    await assert.rejects(readNativeRsshub("/fixture", 1, { runtimeDirectory: folder, signal: AbortSignal.timeout(2000) }), /RSSHub结果无效/);
    await writeFile(path.join(folder, "dist/index.mjs"), `export default {fetch:()=>new Response('后续采集正常')};`);
    assert.equal((await readNativeRsshub("/fixture", 1, { runtimeDirectory: folder })).text(), "后续采集正常");
  } finally {
    await removeNativeFixture(folder);
  }
});

test("RSSHub内部Fetch取消会中止整个不完整任务并关闭上游连接", async () => {
  let closed = false;
  const upstream = createServer((_req, res) => { res.on("close", () => { closed = true; }); res.write("未结束的正文"); });
  const origin = await listenHttpForFetch(upstream);
  const folder = await nativeFixture();
  await writeFile(path.join(folder, "dist/index.mjs"), `export default {fetch:async()=>{
    const controller=new AbortController(); setTimeout(()=>controller.abort(),200);
    try { await fetch(${JSON.stringify(origin)}, {signal:controller.signal}); } catch {}
    return new Response('已忽略取消的备用正文');
  }};`);
  const previous = config.allowPrivateNetworkFetch; config.allowPrivateNetworkFetch = true;
  try {
    await assert.rejects(readNativeRsshub("/fixture", 1, { runtimeDirectory: folder, signal: AbortSignal.timeout(2000) }), /RSSHub独立采集失败/);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(closed, true);
  } finally {
    config.allowPrivateNetworkFetch = previous; upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await removeNativeFixture(folder);
  }
});

test("未结束的超大请求体在读取时拒绝，不能等待全量缓存或发送上游", async () => {
  let hits = 0;
  const upstream = createServer((_req, res) => { hits++; res.end("unexpected"); });
  const origin = await listenHttpForFetch(upstream);
  const folder = await nativeFixture();
  await writeFile(path.join(folder, "dist/index.mjs"), `export default {fetch:async()=>{
    const body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(1024*1024+1));}});
    try { await fetch(${JSON.stringify(origin)}, {method:'POST',body,duplex:'half'}); } catch {}
    return new Response('已忽略超限的备用正文');
  }};`);
  const previous = config.allowPrivateNetworkFetch; config.allowPrivateNetworkFetch = true;
  try {
    await assert.rejects(readNativeRsshub("/fixture", 1, { runtimeDirectory: folder, signal: AbortSignal.timeout(2000) }), /RSSHub独立采集失败/);
    assert.equal(hits, 0);
  } finally {
    config.allowPrivateNetworkFetch = previous; upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await removeNativeFixture(folder);
  }
});

test("同一运行入口只允许一个RSSHub任务，退出后可继续下一项", async () => {
  let hits = 0;
  let release: (() => void) | undefined;
  let reached!: () => void;
  const ready = new Promise<void>(resolve => { reached = resolve; });
  const upstream = createServer((_req, res) => {
    hits++; release = () => res.end("串行完整正文"); reached();
  });
  const origin = await listenHttpForFetch(upstream);
  const folder = await nativeFixture();
  await writeFile(path.join(folder, "dist/index.mjs"), `export default {fetch:()=>fetch(${JSON.stringify(origin)})};`);
  const previous = config.allowPrivateNetworkFetch; config.allowPrivateNetworkFetch = true;
  const first = readNativeRsshub("/fixture", 1, { runtimeDirectory: folder });
  try {
    await ready;
    await assert.rejects(readNativeRsshub("/fixture", 1, { runtimeDirectory: folder, signal: AbortSignal.timeout(500) }), /已有RSSHub采集任务/);
    assert.equal(hits, 1);
    release!();
    assert.equal((await first).text(), "串行完整正文");
    await writeFile(path.join(folder, "dist/index.mjs"), `export default {fetch:()=>new Response('下一个任务')};`);
    assert.equal((await readNativeRsshub("/fixture", 1, { runtimeDirectory: folder })).text(), "下一个任务");
  } finally {
    release?.(); upstream.closeAllConnections(); await first.catch(() => {});
    config.allowPrivateNetworkFetch = previous;
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await removeNativeFixture(folder);
  }
});

test("采集宿主意外退出时，所属RSSHub子进程也退出，不留下常驻任务", async () => {
  let childPid: number | undefined;
  let reached!: () => void;
  const ready = new Promise<void>(resolve => { reached = resolve; });
  const upstream = createServer((req, res) => {
    childPid = Number(new URL(req.url!, "http://fixture.local").searchParams.get("pid"));
    res.write("未完成正文"); reached();
  });
  const origin = await listenHttpForFetch(upstream);
  const folder = await nativeFixture();
  await writeFile(path.join(folder, "dist/index.mjs"), `setInterval(()=>{},1000); export default {fetch:()=>fetch(${JSON.stringify(origin)}+'/?pid='+process.pid)};`);
  const setup = pathToFileURL(path.resolve("tests/setup.ts")).href;
  const entry = pathToFileURL(path.resolve("modules/studio/backend/rsshub-native.ts")).href;
  const driver = spawn(process.execPath, ["--input-type=module", "--eval", `import ${JSON.stringify(setup)};
    import {config} from '@aihot/backend/config'; config.allowPrivateNetworkFetch=true;
    import {readNativeRsshub} from ${JSON.stringify(entry)};
    await readNativeRsshub('/fixture',1,{runtimeDirectory:${JSON.stringify(folder)}});`], { windowsHide: true, stdio: "ignore" });
  const exited = once(driver, "exit");
  const exists = () => { try { process.kill(childPid!, 0); return true; } catch { return false; } };
  try {
    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error("宿主未能启动采集")), 3000))]);
    assert.ok(childPid && childPid !== process.pid && childPid !== driver.pid);
    driver.kill(); await exited;
    for (let attempt = 0; attempt < 10 && exists(); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(exists(), false, "宿主退出后RSSHub仍在后台运行");
  } finally {
    if (driver.exitCode === null && driver.signalCode === null) driver.kill();
    await exited;
    if (childPid && exists()) process.kill(childPid);
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
    await removeNativeFixture(folder);
  }
});

test("上游请求尚未完成就返回正文时拒绝结果，不能提前宣布采集完成", async () => {
  const upstream = createServer((_req, res) => { res.write("未结束"); });
  const origin = await listenHttpForFetch(upstream);
  const folder = await nativeFixture();
  await writeFile(path.join(folder, "dist/index.mjs"), `export default {fetch:()=>{
    void fetch(${JSON.stringify(origin)}).catch(()=>{}); return new Response('提前完成');
  }};`);
  const previous = config.allowPrivateNetworkFetch; config.allowPrivateNetworkFetch = true;
  try {
    await assert.rejects(readNativeRsshub("/fixture", 1, { runtimeDirectory: folder }), /上游请求未完整完成/);
  } finally {
    config.allowPrivateNetworkFetch = previous; upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await removeNativeFixture(folder);
  }
});

test("受控重定向后保留最终地址与redirected，供原路由识别实际内容来源", async () => {
  const upstream = createServer((req, res) => {
    if (req.url === "/start") { res.writeHead(302, { location: "/final" }); res.end(); }
    else res.end("真实正文");
  });
  const origin = await listenHttpForFetch(upstream);
  const folder = await nativeFixture();
  await writeFile(path.join(folder, "dist/index.mjs"), `export default {fetch:async()=>{
    const response=await fetch(${JSON.stringify(origin + "/start")});
    return Response.json({url:response.url,redirected:response.redirected,body:await response.text()});
  }};`);
  const previous = config.allowPrivateNetworkFetch; config.allowPrivateNetworkFetch = true;
  try {
    const result = await readNativeRsshub("/fixture", 1, { runtimeDirectory: folder });
    assert.deepEqual(JSON.parse(result.text()), { url: origin + "/final", redirected: true, body: "真实正文" });
  } finally {
    config.allowPrivateNetworkFetch = previous; upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await removeNativeFixture(folder);
  }
});

test("请求体尚未读完也属于进行中的采集，不接受提前返回的正文", async () => {
  const folder = await nativeFixture();
  await writeFile(path.join(folder, "dist/index.mjs"), `export default {fetch:()=>{
    const body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1]));}});
    void fetch('https://never-contact.invalid/',{method:'POST',body,duplex:'half'}).catch(()=>{});
    return new Response('请求体尚未读完的备用正文');
  }};`);
  try {
    await assert.rejects(readNativeRsshub("/fixture", 1, { runtimeDirectory: folder }), /RSSHub独立采集失败/);
  } finally {
    await removeNativeFixture(folder);
  }
});

test("RSSHub原生IPC在外层Windows资源组内保持可用且同组计数", { timeout: 20_000 }, async () => {
  const folder = await nativeFixture(), output = path.join(folder, "result.json");
  await writeFile(path.join(folder, "dist/index.mjs"), `setInterval(()=>{},1000);export default {fetch:async()=>{
    await new Promise(resolve=>setTimeout(resolve,500));return new Response('资源组中的完整订阅');}};`);
  const moduleUrl = new URL("../backend/rsshub-native.ts", import.meta.url).href;
  let maximumProcesses = 0;
  try {
    const result = await runWindowsProcessGroup({ executable: process.execPath, args: ["--input-type=module", "-e", `
      const {readNativeRsshub}=await import(${JSON.stringify(moduleUrl)});
      const response=await readNativeRsshub('/fixture',1,{runtimeDirectory:process.argv[1]});
      const fs=await import('node:fs/promises');await fs.writeFile(process.argv[2],JSON.stringify({status:response.status,text:response.text()}));
    `, folder, output], cwd: process.cwd(), cpuPercent: 50, memoryLimitBytes: 4 * 1024 ** 3,
    onStatus: status => { maximumProcesses = Math.max(maximumProcesses, status.activeProcesses); } });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), { status: 200, text: "资源组中的完整订阅" });
    assert.ok(maximumProcesses >= 2, "IPC child and its parent must share the same kernel group");
  } finally { await removeNativeFixture(folder); }
});
