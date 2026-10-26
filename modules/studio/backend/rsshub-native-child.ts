// Dedicated RSSHub process: never imported by the API/worker itself.
import { pathToFileURL } from "node:url";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { addAbortListener } from "node:events";
import { installRsshubHooks } from "./rsshub-native-hooks.ts";
import { readParentMessage, type RsshubChildMessage } from "./rsshub-native-protocol.ts";
const [entry, route, limit] = process.argv.slice(2);
const send = (message: RsshubChildMessage, callback: (error: Error | null) => void = error => { if (error) process.exit(1); }) => {
  if (!process.connected) process.exit(1);
  process.send!(message, callback);
};
process.on("disconnect", () => process.exit(1));

// RSSHub uses IPC for every supported read. Unexpected network paths fail closed.
let blockedNetwork = false;
const blockedSocket = () => { blockedNetwork = true; throw new Error("RSSHub只允许受控出站，不允许独立网络或监听"); };
net.connect = blockedSocket;
net.createConnection = blockedSocket;
net.Socket.prototype.connect = blockedSocket;
net.Server.prototype.listen = blockedSocket;
tls.connect = blockedSocket;
syncBuiltinESMExports();

let sequence = 0;
let activeRequests = 0;
const pending = new Map<number, { resolve: (response: Response) => void; reject: (error: Error) => void }>();
process.on("message", (raw: unknown) => {
  const message = readParentMessage(raw);
  if (!message) { send({ type: "error" }); return; }
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if ("error" in message) { request.reject(new Error("RSSHub受控上游请求失败")); return; }
  try {
    const response = new Response([204, 205, 304].includes(message.status) ? null : Uint8Array.from(Buffer.from(message.body, "base64")),
      { status: message.status, headers: message.headers });
    Object.defineProperties(response, { url: { value: message.url }, redirected: { value: message.redirected } });
    request.resolve(response);
  } catch { send({ type: "error" }); request.reject(new Error("RSSHub上游响应无效")); }
});

const brokerFetch: typeof globalThis.fetch = async (input, init) => {
  activeRequests++;
  let subscription: ReturnType<typeof addAbortListener> | undefined;
  try {
    const request = new Request(input, init);
    // Any cancelled read leaves this feed incomplete; the parent cancels every request and exits this job.
    subscription = addAbortListener(request.signal, () => { send({ type: "error" }); });
    request.signal.throwIfAborted();
    let body: Buffer | undefined;
    if (request.body) {
      const chunks: Buffer[] = [];
      let size = 0;
      const reader = request.body.getReader();
      try {
        for (;;) {
          request.signal.throwIfAborted();
          const { value, done } = await reader.read();
          request.signal.throwIfAborted();
          if (done) break;
          size += value.byteLength;
          if (size > 1024 * 1024) throw new Error("RSSHub请求体超过1MiB");
          chunks.push(Buffer.from(value));
        }
        body = Buffer.concat(chunks);
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    const id = sequence++;
    return await new Promise<Response>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ type: "fetch", id, url: request.url, method: request.method, headers: Object.fromEntries(request.headers),
        body: body?.toString("base64"), redirect: request.redirect }, error => { if (error) { pending.delete(id); reject(error); } });
    });
  } catch (error) { send({ type: "error" }); throw error; }
  finally { subscription?.[Symbol.dispose](); activeRequests--; }
};

try {
  installRsshubHooks(entry!);
  globalThis.fetch = brokerFetch;
  const application = (await import(pathToFileURL(entry!).href)).default;
  globalThis.fetch = brokerFetch;
  const response: Response = await application.fetch(new Request(`http://rsshub.local${route}?limit=${limit}`));
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > 4 * 1024 * 1024) throw new Error("RSSHub结果超过4MiB");
    chunks.push(Buffer.from(chunk));
  }
  if (blockedNetwork || activeRequests > 0) throw new Error("RSSHub请求未完整完成或使用了未经适配的网络通路");
  send({ type: "result", status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.concat(chunks).toString("base64") });
} catch { send({ type: "error" }); }
