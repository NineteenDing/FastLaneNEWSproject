// Invoked only through the operator's isolated test command.
import assert from "node:assert/strict";
import { test } from "node:test";
import postgres from "postgres";

test("test command receives an isolated database and no live provider credentials", async () => {
  assert.equal(process.env.DEEPSEEK_API_KEY, undefined);
  assert.equal(process.env.DEV_AUTH_ROLE, undefined);
  assert.equal(process.env.FEISHU_CONTENT_PUSH_ENABLED, "false");
  assert.equal(process.env.INDEXNOW_SUBMIT_ENABLED, "false");
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const [row] = await sql`SELECT current_database() AS name`;
    assert.match(row.name, /_(test|ci)$/);
    assert.ok(Buffer.byteLength(row.name) <= 63);
    console.log(`isolated-database:${row.name}`);
  } finally { await sql.end(); }
});
