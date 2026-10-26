import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { collectMediaCreator } from "../backend/mediacrawler.ts";
import { xhsVideoDetailFixture } from "./mediacrawler-fixture.ts";

const previous = getGlobalDispatcher(), transport = new MockAgent();
transport.disableNetConnect(); setGlobalDispatcher(transport); config.allowPrivateNetworkFetch = true;
after(async () => { setGlobalDispatcher(previous); await transport.close(); });

test("小红书指定作品省略来源使用pc_feed，显式空来源沿用原SDK的pc_search，父子校验保持一致", async () => {
  for (const [context, source] of [[{ xsec_token: "private-note-token" }, "pc_feed"], [{ xsec_token: "private-note-token", xsec_source: "" }, "pc_search"]] as const) {
    xhsVideoDetailFixture(transport, { source });
    const result = await collectMediaCreator({ platform: "xhs", locator: "5eb8e1d400000000010075ae", videoId: "670000000000000001234567",
      cookie: "a1=refresh-context-fixture; web_session=context-session", context });
    assert.equal(result.posts[0].externalId, "670000000000000001234567");
    assert.deepEqual(result.posts[0].media?.videoUrls, ["https://sns-video-bd.xhscdn.com/fixture-origin.mp4"]);
  }
  transport.assertNoPendingInterceptors();
});
