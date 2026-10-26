import { addAbortListener } from "node:events";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";

/** One RSSHub job owns its requests; close cancels active downloads and queued work. */
export function createRsshubOutbound(options: { signal?: AbortSignal } = {}) {
  const controller = new AbortController();
  const jobSignal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const waiting = new Set<() => void>();
  let active = 0;
  const release = () => {
    active--;
    const next = waiting.values().next().value;
    if (next) { waiting.delete(next); next(); }
  };
  const acquire = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (active < 2) { active++; return; }
    await new Promise<void>((resolve, reject) => {
      const grant = () => { subscription[Symbol.dispose](); active++; resolve(); };
      const subscription = addAbortListener(signal, () => { waiting.delete(grant); reject(signal.reason); });
      waiting.add(grant);
    });
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const signal = AbortSignal.any([jobSignal, request.signal, AbortSignal.timeout(8000)]);
    await acquire(signal);
    try {
      let requestBody: Buffer | undefined;
      if (request.body) {
        const chunks: Buffer[] = [];
        let size = 0;
        const reader = request.body.getReader();
        const subscription = addAbortListener(signal, () => { void reader.cancel(signal.reason).catch(() => {}); });
        try {
          for (;;) {
            signal.throwIfAborted();
            const { value, done } = await reader.read();
            signal.throwIfAborted();
            if (done) break;
            size += value.byteLength;
            if (size > 1024 * 1024) throw new Error("RSSHub请求体超过1MiB，未发送本次请求");
            chunks.push(Buffer.from(value));
          }
        } finally {
          subscription[Symbol.dispose]();
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        requestBody = Buffer.concat(chunks);
      }
      const result = await guardedFetch(request.url, { method: request.method,
        headers: Object.fromEntries(request.headers), body: requestBody, route: "direct", signal,
        redirect: request.redirect, maxBytes: 8 * 1024 * 1024 });
      const headers = new Headers(result.headers);
      // Undici has already decompressed the body; do not describe those bytes as compressed.
      headers.delete("content-encoding"); headers.delete("content-length");
      const body = request.method === "HEAD" || [204, 205, 304].includes(result.status) ? null : Uint8Array.from(result.body);
      const response = new Response(body, { status: result.status, headers });
      Object.defineProperties(response, { url: { value: result.url }, redirected: { value: result.url !== request.url } });
      return response;
    } finally { release(); }
  };
  return { fetch, close: () => controller.abort(new Error("RSSHub采集任务已结束")) };
}
