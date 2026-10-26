import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

delete process.env.EGRESS_POLICY;
const { config } = await import("@aihot/backend/config");
const { guardedFetch } = await import("@aihot/backend/lib/http-fetch");

// A local transport substitute: no real DNS, platform or proxy is contacted.
const previous = getGlobalDispatcher();
const mock = new MockAgent();
mock.disableNetConnect();
setGlobalDispatcher(mock);
config.allowPrivateNetworkFetch = true;
config.egressProxyUrl = null;
after(async () => { setGlobalDispatcher(previous); await mock.close(); });

test("collection can read a public source directly without configuring a relay", async () => {
  mock.get("https://example.org").intercept({ path: "/news" }).reply(200, "来源正文");
  const response = await guardedFetch("https://example.org/news");
  assert.equal(response.text(), "来源正文");
});
