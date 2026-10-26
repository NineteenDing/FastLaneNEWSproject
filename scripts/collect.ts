// Submit manual collection to the same durable queues as the admin interface. A worker must run it.
// node --env-file=.env scripts/collect.ts rss-openai-news rss-hugging-face ...
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { fetchNow } from "@aihot/backend/admin/sources";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";

installModules(SERVER_MODULES);
try {
  for (const id of process.argv.slice(2)) {
    try {
      const result = await fetchNow(id, "cli");
      console.log(JSON.stringify({ sourceId: id, state: result ? "submitted" : "not_found", ...result }));
      if (!result) process.exitCode = 1;
    } catch {
      console.log(JSON.stringify({ sourceId: id, state: "failed", code: "COLLECTION_SUBMIT_FAILED",
        message: "未能提交采集任务，请在关注管理检查来源状态和采集配置。" }));
      process.exitCode = 1;
    }
  }
} finally { await stopBoss(); await closeDb(); }
