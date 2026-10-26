import type { DatabaseResourceStatus } from "../contracts.ts";
import { sql } from "@aihot/backend/db";
import { createResourceSampler } from "./resource-sampler.ts";

type Usage = { databaseBytes: number; walBytes: number; temporaryBytes: number };
const GiB = 1024 ** 3, limitBytes = 6 * GiB;
async function readUsage(): Promise<Usage> {
  return sql.begin(async tx => {
    await tx`SET LOCAL statement_timeout = '5s'`;
    // pg_ls_tmpdir omits subdirectories. Parallel hash/index work uses FileSets
    // there, so walk only PostgreSQL's known temporary roots, including FileSets.
    const [usage] = await tx<(Usage & { unmeasured: boolean })[]>`WITH RECURSIVE roots(file) AS (
      SELECT 'base/pgsql_tmp'::text
      UNION ALL
      SELECT 'pg_tblspc/'||t.oid||'/'||v.name||'/pgsql_tmp'
        FROM pg_tablespace t CROSS JOIN LATERAL pg_ls_dir('pg_tblspc/'||t.oid,true,false) v(name)
        WHERE t.spcname NOT IN ('pg_global','pg_default')
          AND v.name LIKE ('PG_'||(current_setting('server_version_num')::int/10000)||'_%')
    ), files(file,depth,size,isdir) AS (
      SELECT file,0,0::bigint,true FROM roots
      UNION ALL
      SELECT parent.file||'/'||entry.name,parent.depth+1,info.size,info.isdir
        FROM files parent CROSS JOIN LATERAL pg_ls_dir(parent.file,true,false) entry(name)
        CROSS JOIN LATERAL pg_stat_file(parent.file||'/'||entry.name,true) info
        WHERE parent.isdir AND parent.depth<8
    ) SELECT pg_database_size(current_database()) AS "databaseBytes",
      (SELECT coalesce(sum(size),0)::bigint FROM pg_ls_waldir()) AS "walBytes",
      coalesce(sum(size) FILTER(WHERE NOT isdir),0)::bigint AS "temporaryBytes",
      coalesce(bool_or(isdir AND depth=8),false) AS unmeasured FROM files`;
    if (!usage || usage.unmeasured) throw new Error("数据库容量未取得");
    return { databaseBytes: usage.databaseBytes, walBytes: usage.walBytes, temporaryBytes: usage.temporaryBytes };
  }) as Promise<Usage>;
}
function unknownStatus(state: "warming" | "unavailable" = "warming"): DatabaseResourceStatus {
  return { scope: "database_with_shared_wal_temp", state, databaseBytes: null, walBytes: null,
    temporaryBytes: null, usedBytes: null, limitBytes, sampleAgeMs: null, estimatedRemainingSeconds: null, ingestionAllowed: false };
}

export function createDatabaseResourceMonitor(options: { read?: () => Promise<Usage>; now?: () => number } = {}) {
  const read = options.read ?? readUsage;
  const now = options.now ?? (() => Math.floor(performance.now()));
  let status = unknownStatus(), blocked = true;
  let sampledAt: number | undefined;
  function invalidate() {
    status = unknownStatus("unavailable"); blocked = true; sampledAt = undefined;
  }
  const sampling = createResourceSampler({ intervalMs: 30_000, invalidate,
    async sample(current) {
      if (!current()) return;
      try {
        const at = now();
        if (!Number.isSafeInteger(at) || at < 0) throw new Error();
        if (sampledAt !== undefined && (at < sampledAt || at - sampledAt > 90_000)) invalidate();
        const usage = await read(), age = now() - at;
        const usedBytes = usage.databaseBytes + usage.walBytes + usage.temporaryBytes;
        if (!Number.isSafeInteger(age) || age < 0 || age > 90_000
          || ![usage.databaseBytes, usage.walBytes, usage.temporaryBytes, usedBytes].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error();
        if (!current()) return;
        if (usedBytes <= 5.5 * GiB) blocked = false;
        else if (usedBytes >= limitBytes) blocked = true;
        let estimate = usedBytes >= limitBytes ? 0 : null;
        if (estimate === null && sampledAt !== undefined && at > sampledAt && status.usedBytes !== null && usedBytes > status.usedBytes) {
          const seconds = Math.ceil((limitBytes - usedBytes) / (usedBytes - status.usedBytes) * (at - sampledAt) / 1000);
          if (Number.isSafeInteger(seconds)) estimate = seconds;
        }
        status = { scope: "database_with_shared_wal_temp", databaseBytes: usage.databaseBytes, walBytes: usage.walBytes,
          temporaryBytes: usage.temporaryBytes, usedBytes, limitBytes, sampleAgeMs: 0,
          estimatedRemainingSeconds: estimate, state: usedBytes >= limitBytes ? "limited" : blocked ? "recovering"
            : usedBytes >= 5 * GiB ? "warning" : "normal", ingestionAllowed: !blocked };
        sampledAt = at;
      } catch { if (current()) invalidate(); }
    },
  });
  return { ...sampling,
    status(): DatabaseResourceStatus {
      if (sampledAt === undefined) return { ...status };
      try {
        const age = now() - sampledAt;
        if (!Number.isSafeInteger(age) || age < 0 || age > 90_000) return unknownStatus("unavailable");
        return { ...status, sampleAgeMs: age, estimatedRemainingSeconds: status.estimatedRemainingSeconds === null ? null
          : Math.max(0, status.estimatedRemainingSeconds - Math.floor(age / 1000)) };
      } catch { return unknownStatus("unavailable"); }
    },
  };
}
