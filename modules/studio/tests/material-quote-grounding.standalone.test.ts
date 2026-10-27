import test from "node:test";
import assert from "node:assert/strict";
import { groundBodyQuoteTypography } from "../backend/material-quote-grounding.ts";

test("model evidence is restored to the unique literal source span when only hyphen typography differs", () => {
 const body="已保留 GPT‑6 Astra 的防护措施。";
 const result=groundBodyQuoteTypography({shared:{facts:[{quotes:["已保留 GPT-6 Astra 的防护措施。"]}]}},body);
 assert.deepEqual(result,{shared:{facts:[{quotes:["已保留 GPT‑6 Astra 的防护措施。"]}]}});
});
test('引号与不换行空格的排版差异只能恢复到唯一原文，不更改数字与原始事实',()=>{
 const result=groundBodyQuoteTypography({evidenceQuotes:['“AI film” uses 32 GB']},'"AI film" uses 32\u00a0GB');
 assert.deepEqual(result.evidenceQuotes,['"AI film" uses 32\u00a0GB']);
});

test("changed claims, numbers and mathematical dash characters remain ungrounded", () => {
 const body="销量为 100，区间 1–2，亏损 −5。";
 const output={evidenceQuotes:["销量为 1000","区间 1-2","亏损 -5","销量达到 100"]};
 assert.deepEqual(groundBodyQuoteTypography(output,body),output);
 for(const quote of output.evidenceQuotes)assert.equal(body.includes(quote),false);
});
test("ambiguous source spans are not selected and original exact quotations remain intact", () => {
 const body="GPT‐6 发布。GPT‑6 发布。";
 assert.deepEqual(groundBodyQuoteTypography({scopeQuotes:["GPT-6 发布。","GPT‑6 发布。"]},body),
  {scopeQuotes:["GPT-6 发布。","GPT‑6 发布。"]});
});
test("comment citations are never reanchored to the article body", () => {
 const output={insights:{commentFocus:[{evidence:[{commentId:"comment-1",quote:"GPT-6 已发布"}]}],impacts:[{evidenceQuotes:["GPT-6 已发布"]}]}};
 const result=groundBodyQuoteTypography(output,"GPT‑6 已发布");
 assert.equal(result.insights.commentFocus[0]!.evidence[0]!.quote,"GPT-6 已发布");
 assert.equal(result.insights.impacts[0]!.evidenceQuotes[0],"GPT‑6 已发布");
 assert.equal(output.insights.impacts[0]!.evidenceQuotes[0],"GPT-6 已发布");
});
