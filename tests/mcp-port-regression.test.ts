import "./setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";

test("系统可能分配Fetch禁止端口时，HTTP采集与MCP契约测试仍可执行", async () => {
  // Model the OS choosing the observed forbidden ephemeral port. Actual TCP, Fastify,
  // MCP CLI and official client remain real; explicit safe reservations are unaffected.
  const allocator = `import net from 'node:net';
    const listen=net.Server.prototype.listen;
    net.Server.prototype.listen=function(options,...args){
      if(options===0)options=1723;
      if(options && typeof options==='object' && options.port===0)options={...options,port:1723};
      return listen.call(this,options,...args);
    };`;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const file of ["tests/mcp-check.test.ts", "tests/source-publication-window.test.ts"]) {
    const result = await promisify(execFile)(process.execPath,
      ["--import", "data:text/javascript," + encodeURIComponent(allocator), "--test", file],
      { env, windowsHide: true, timeout: 15_000, maxBuffer: 256 * 1024 });
    assert.match(result.stdout, /# fail 0|ℹ fail 0/);
  }
});
