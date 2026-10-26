import { createServer } from "node:http";
import type { Socket } from "node:net";
import { addAbortListener } from "node:events";
import { chromium, type Browser } from "playwright-core";
import { localProcessEnvironment } from "../../../scripts/local-environment.ts";
import { createRsshubOutbound } from "./rsshub-outbound.ts";
import type { CreatorPlatform } from "../contracts.ts";
import type { LoginBrowser } from "./platform-logins.ts";
import { LoginBrowserOpenFailed } from "./platform-logins.ts";

const urls: Record<CreatorPlatform, string> = { xhs: "https://www.xiaohongshu.com/explore", douyin: "https://www.douyin.com/", kuaishou: "https://www.kuaishou.com/",
  bilibili: "https://passport.bilibili.com/login", weibo: "https://passport.weibo.com/sso/signin?entry=miniblog", tieba: "https://tieba.baidu.com/", zhihu: "https://www.zhihu.com/signin" };
const domains: Record<CreatorPlatform, string[]> = { xhs: ["xiaohongshu.com"], douyin: ["douyin.com"], kuaishou: ["kuaishou.com"], bilibili: ["bilibili.com"],
  weibo: ["weibo.com", "weibo.cn"], tieba: ["baidu.com"], zhihu: ["zhihu.com"] };
const markers: Record<CreatorPlatform, string[]> = { xhs: ["web_session"], douyin: ["LOGIN_STATUS"], kuaishou: ["passToken"], bilibili: ["SESSDATA"], weibo: ["SUB", "SSOLoginState"], tieba: ["STOKEN", "PTOKEN", "BDUSS"], zhihu: ["z_c0"] };

/** Remote login adapts the fixed MediaCrawler login markers; no existing browser profile is read.
 * Guarded HTTP and deny proxy are reused from collector-browser, permitting interactive page scripts. */
export async function openPlatformLogin(platform: CreatorPlatform, signal: AbortSignal, trustedTestUrl?: string): Promise<LoginBrowser> {
  signal.throwIfAborted();
  const outbound = createRsshubOutbound({ signal }), sockets = new Set<Socket>();
  const sink = createServer((_req, res) => { res.writeHead(503); res.end(); });
  sink.on("connect", (_req, socket) => socket.destroy());
  sink.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  let browser: Browser | undefined, subscription: ReturnType<typeof addAbortListener> | undefined, closed: Promise<void> | undefined;
  const close = () => closed ??= (async () => {
    subscription?.[Symbol.dispose](); outbound.close();
    try { await browser?.close(); }
    finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => sink.close(() => resolve())); }
  })();
  try {
    await new Promise<void>((resolve, reject) => { sink.once("error", reject); sink.listen(0, "127.0.0.1", () => { sink.removeListener("error", reject); resolve(); }); });
    const address = sink.address(); if (!address || typeof address === "string") throw new Error();
    browser = await chromium.launch({ headless: true, timeout: 15000, env: localProcessEnvironment(), proxy: { server: `http://127.0.0.1:${address.port}` },
      args: ["--proxy-bypass-list=<-loopback>", "--disable-quic", "--dns-prefetch-disable", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] });
    const context = await browser.newContext({ viewport: { width: 900, height: 650 }, serviceWorkers: "block", acceptDownloads: false });
    await context.routeWebSocket("**/*", socket => socket.close());
    let requests = 0, bytes = 0;
    await context.route("**/*", async route => {
      try {
        signal.throwIfAborted();
        const req = route.request(), url = new URL(req.url());
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || !["GET", "POST", "HEAD", "OPTIONS"].includes(req.method()) || ++requests > 800 || bytes > 64 * 1024 ** 2) throw new Error();
        if (["media", "font"].includes(req.resourceType())) { await route.fulfill({ status: 204 }); return; }
        const response = await outbound.fetch(req.url(), { method: req.method(), headers: await req.allHeaders(), body: req.postDataBuffer() ?? undefined, redirect: "manual", signal });
        const body = Buffer.from(await response.arrayBuffer()); bytes += body.length;
        if (bytes > 64 * 1024 ** 2) throw new Error();
        const headers = Object.fromEntries(response.headers), cookies = response.headers.getSetCookie();
        if (cookies.length) headers["set-cookie"] = cookies.join("\n");
        await route.fulfill({ status: response.status, headers, body });
      } catch { await route.abort().catch(() => {}); }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000); page.setDefaultNavigationTimeout(15000);
    page.on("popup", popup => { void popup.close().catch(() => {}); });
    subscription = addAbortListener(signal, () => { void close().catch(() => {}); });
    await page.goto(trustedTestUrl ?? urls[platform], { waitUntil: "domcontentloaded" });
    signal.throwIfAborted();
    const baseline = new Map((await context.cookies()).map(c => [c.name, c.value]));
    return {
      frame: () => page.screenshot({ type: "jpeg", quality: 70, timeout: 5000 }),
      async session() {
        signal.throwIfAborted();
        const cookies = (await context.cookies()).filter(c => domains[platform].some(domain => c.domain.replace(/^\./, "") === domain || c.domain.endsWith("." + domain)));
        const changed = cookies.some(c => markers[platform].includes(c.name) && !!c.value && baseline.get(c.name) !== c.value && (platform !== "douyin" || c.value === "1"));
        // XHS may issue web_session anonymously: require its logged-in profile affordance too.
        if (!changed || platform === "xhs" && !await page.locator('a[href*="/user/profile/"]').filter({ hasText: "我" }).first().isVisible()) return "";
        return cookies.map(c => `${c.name}=${c.value}`).join("; ");
      },
      async action(action) {
        signal.throwIfAborted();
        if (action.type === "click") await page.mouse.click(action.x, action.y);
        else if (action.type === "drag") { await page.mouse.move(action.x, action.y); await page.mouse.down(); try { await page.mouse.move(action.toX, action.toY, { steps: 20 }); } finally { await page.mouse.up(); } }
        else if (action.type === "scroll") await page.mouse.wheel(0, action.delta);
        else if (action.type === "text") await page.keyboard.insertText(action.text);
        else await page.keyboard.press(action.key);
      },
      close,
    };
  } catch { let confirmed = false; try { await close(); confirmed = true; } catch {} throw new LoginBrowserOpenFailed(confirmed); }
}
