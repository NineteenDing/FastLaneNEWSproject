// Cross-platform local supervisor transport. Application shutdown remains in each real entry point.
import { pathToFileURL } from "node:url";
import path from "node:path";

const role = process.argv[2];
const entries: Record<string, string> = { api: "apps/api/src/main.ts", web: "apps/web/server.ts", worker: "apps/worker/src/main.ts" };
const entry = entries[role ?? ""];
if (!entry || !process.send) throw new Error("Only the local supervisor can launch this entry point");
function shutdown() {
  if (!process.emit("SIGTERM")) process.exit(0);
}
process.on("message", message => {
  if (message && typeof message === "object" && "type" in message && message.type === "studio:shutdown") shutdown();
});
process.on("disconnect", shutdown);
await import(pathToFileURL(path.resolve(import.meta.dirname, "..", entry)).href);
if (role === "worker" && process.connected) process.send({ type: "studio:ready", role });
