import { createServer } from "node:http";
import type { Socket } from "node:net";
import { addAbortListener } from "node:events";
import { chromium, type Browser, type Page } from "playwright-core";
import { createRsshubOutbound } from "./rsshub-outbound.ts";
import { localProcessEnvironment } from "../../../scripts/local-environment.ts";

let active = false;

/** One isolated platform page. Every web request is fulfilled by the existing guarded HTTP
 * adapter; a deny-only loopback proxy blocks native/background paths outside interception. */
export async function withCollectorPage<T>(options: { platform: "tieba" | "douyin" | "kuaishou"; cookie: string; signal?: AbortSignal }, run: (page: Page) => Promise<T>): Promise<T> {
  if (!["tieba", "douyin", "kuaishou"].includes(options.platform) || /[\r\n]/.test(options.cookie) || options.cookie.length > 16000) throw new Error("采集页面配置无效");
  const origin = options.platform === "tieba" ? "https://tieba.baidu.com" : options.platform === "douyin" ? "https://www.douyin.com" : "https://www.kuaishou.com", controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90000), ...(options.signal ? [options.signal] : [])]);
  signal.throwIfAborted();
  if (active) throw new Error("已有采集浏览器正在运行，请稍后重试");
  active = true;
  const outbound = createRsshubOutbound({ signal });
  const sockets = new Set<Socket>();
  const sink = createServer((_request, response) => { response.writeHead(503); response.end(); });
  sink.on("connect", (_request, socket) => socket.destroy());
  sink.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  let browser: Browser | undefined, failure: Error | undefined, requests = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      sink.once("error", reject); sink.listen(0, "127.0.0.1", () => { sink.removeListener("error", reject); resolve(); });
    });
    const address = sink.address();
    if (!address || typeof address === "string") throw new Error("采集页面请求保护未就绪");
    browser = await chromium.launch({ headless: true, timeout: 15000, env: localProcessEnvironment(),
      proxy: { server: `http://127.0.0.1:${address.port}` }, args: ["--proxy-bypass-list=<-loopback>", "--disable-quic", "--dns-prefetch-disable", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] });
    signal.throwIfAborted();
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
    await context.addCookies(options.cookie.split(";").filter(part => part.includes("=")).map(part => {
      const index = part.indexOf("="); return { name: part.slice(0, index).trim(), value: part.slice(index + 1).trim(), url: origin };
    }));
    await context.routeWebSocket("**/*", socket => socket.close());
    await context.route("**/*", async route => {
      try {
        const request = route.request(), url = new URL(request.url());
        const staticScript = options.platform === "kuaishou" && url.origin === "https://static.yximgs.com" && request.resourceType() === "script" && request.method() === "GET" && /\.js$/.test(url.pathname);
        if (url.origin !== origin && !staticScript || url.username || url.password || !["GET", "POST", "HEAD"].includes(request.method()) || ++requests > 160) throw new Error("采集页面请求不在许可范围");
        const readable = options.platform === "kuaishou" ? staticScript || request.method() === "GET" && (url.pathname === "/" || request.resourceType() === "script" && /\.js$/.test(url.pathname))
          : options.platform === "douyin" ? request.method() === "GET" && url.pathname === "/"
          : request.method() === "GET" && ["/", "/c/u/pc/homeSidebarRight", "/c/u/feed/myThread", "/c/s/pc/sync", "/mo/q/search/multsearch", "/p/comment"].includes(url.pathname)
            || request.method() === "POST" && url.pathname === "/c/f/pb/page_pc";
        if (!readable) throw new Error("采集页面接口未接入");
        if (["image", "media", "font"].includes(request.resourceType())) { await route.fulfill({ status: 204 }); return; }
        const requestHeaders = await request.allHeaders();
        if (staticScript) { delete requestHeaders.cookie; delete requestHeaders.authorization; }
        const response = await outbound.fetch(request.url(), { method: request.method(), headers: requestHeaders,
          body: request.postDataBuffer() ?? undefined, redirect: "manual", signal });
        const headers = Object.fromEntries(response.headers);
        // These clients only need an origin for controlled fetch or local state, not page scripts,
        // analytics, subframes or remote styles. DevTools evaluation remains available.
        if (request.resourceType() === "document") headers["content-security-policy"] = options.platform === "kuaishou"
          ? "default-src 'none'; connect-src 'none'; script-src 'self' https://static.yximgs.com 'unsafe-inline' 'unsafe-eval'; frame-src 'none'; form-action 'none'; base-uri 'none'; worker-src 'none'"
          : "default-src 'none'; connect-src 'self'; script-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
        await route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
      } catch {
        failure ??= new Error("采集页面请求失败或超出允许范围，请检查平台会话与网络");
        await route.abort().catch(() => {});
      }
    });
    const page = await context.newPage();
    page.on("popup", popup => { void popup.close().catch(() => {}); });
    page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(15000);
    let subscription: ReturnType<typeof addAbortListener> | undefined;
    const canceled = new Promise<never>((_resolve, reject) => { subscription = addAbortListener(signal, () => reject(new Error("采集页面任务已取消或超时"))); });
    try {
      const result = await Promise.race([run(page), canceled]);
      if (failure) throw failure;
      return result;
    } finally { subscription?.[Symbol.dispose](); }
  } catch { throw new Error("采集页面未能完成，请检查浏览器运行环境、平台会话或网络"); }
  finally {
    controller.abort(); outbound.close();
    try { await browser?.close(); }
    finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => sink.close(error => error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
    }
    active = false;
  }
}
