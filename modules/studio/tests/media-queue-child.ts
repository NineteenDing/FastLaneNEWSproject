// Independent worker for real process/PG-session failure tests; not a test runner entry point.
import "../../../tests/setup.ts";
import sharp from "sharp";
import { MockAgent, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss, workModuleQueues } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { sourceResourceFixture } from "./source-resource-fixture.ts";
import { createMediaProcessingQueue } from "../backend/media-jobs.ts";
import { gate } from "../../../tests/setup.ts";
import { weiboVideoDetailFixture } from "./mediacrawler-fixture.ts";

const transport = new MockAgent(); transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
weiboVideoDetailFixture(transport);
transport.get("https://f.video.weibocdn.com").intercept({ path: "/fixture-video.mp4" }).reply(200, "external-session-fault-video");
const release = gate(), finish = gate(), resources = await sourceResourceFixture();
process.on("message", message => { if (message === "release") release.open(); if (message === "stop") { release.open(); finish.open(); } });
const png = await sharp({ create: { width: 128, height: 72, channels: 3, background: "#496258" } }).png().toBuffer();
const queue = createMediaProcessingQueue({ recognize: async () => {
  // Interrupt the worker's held session if present; after durable coordination the business
  // session is the only one left. This selects the external PG fault, not business evidence.
  const [connection] = await sql`SELECT coalesce((SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE a.datname = current_database() AND l.locktype = 'advisory' AND l.granted AND l.pid <> pg_backend_pid() LIMIT 1), pg_backend_pid()) AS pid`;
  process.send?.({ type: "recognizing", databasePid: connection!.pid });
  await release.promise;
  return { language: "zh", durationSeconds: 6, model: "external-process-asr-fixture", segments: [{ start: 0, end: 6, text: "数据库连接失联不使采集与转写重叠。" }], frames: [{ timeSeconds: 0, pngBase64: png.toString("base64") }] };
} }, resources.host, resources.disk, resources.database);
installModules([{ name: "independent-media-worker", queues: [queue] }]);
await resources.warm();
const stop = await workModuleQueues(await getBoss());
await finish.promise; await stop(); await resources.app.close(); await stopBoss(); await closeDb(); await transport.close();
process.disconnect?.();
