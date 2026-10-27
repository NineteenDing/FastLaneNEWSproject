import {test} from 'node:test';
import assert from 'node:assert/strict';
import {declaredArticleHtml} from '../packages/backend/src/content/article-data.ts';
test('declared article payload belongs to the current article, not a related graph entry',()=>{
 const html='<title>Current story</title><script type="application/ld+json">'+JSON.stringify({'@graph':[
 {'@type':'Article',url:'https://example.com/other',articleBody:'Other facts'},
 {'@type':'NewsArticle',url:'https://example.com/current',headline:'Current story',articleBody:'Current facts\nSecond paragraph'}]})+'</script>';
 const result=declaredArticleHtml(html,'https://example.com/current');assert.match(result!,/Current facts/);assert.doesNotMatch(result!,/Other facts/);
 assert.equal(declaredArticleHtml('<script type="application/ld+json">{"@type":"Article","articleBody":"Unidentified facts"}</script>','https://example.com/current'),null);
});
test('publisher JSON is parsed as data without evaluating scripts',()=>{
 const html='<script>var allData = '+JSON.stringify({docData:{contentData:{contentList:[{type:'text',data:'<p>Publisher facts</p>'},{type:'image',data:'ignored'}]}}})+'; throw Error("must not execute")</script>';
 assert.equal(declaredArticleHtml(html,'https://news.ifeng.com/c/123'),'<p>Publisher facts</p>');
});
