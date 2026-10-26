import { randomUUID } from "node:crypto";
import { load } from "cheerio";
import { sql } from "@aihot/backend/db";
import { defineQueue } from "@aihot/backend/modules";
import { ensureQueue, enqueueOn, QueueDeferred, shutdownSignal } from "@aihot/backend/jobs/queue";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { identityKeyForUrl } from "@aihot/backend/lib/url";
import { readable } from "@aihot/backend/content/extract";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { createSource } from "@aihot/backend/admin/sources";
import { collectionEnabled } from "@aihot/backend/operations/collection-control";
import { createCollectionAdmission } from "./collection-admission.ts";
import { sameTrendHeadline } from "./platform-attention.ts";
import { refreshTrendEventLinks } from "./trend-links.ts";

const SOURCE="studio-platform-trend-news";
type Job={signalId:string;key:string;token:string};
const searchPage=(url:URL)=>/\/search(?:\/|$)|\/weibo\/?$|\/hot\/?$|\/top\/?$/.test(url.pathname)||url.hostname==='www.baidu.com'&&url.pathname==='/s';

async function publicPage(url:string,title:string){
  const get=(href:string)=>guardedFetch(href,{timeoutMs:15000,maxBytes:4*1024**2,signal:shutdownSignal.signal,
    headers:{"user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/119.0.0.0 Safari/537.36"}});
  let response=await get(url);
  if(response.status!==200||!/html/.test(response.headers.get('content-type')??''))throw new Error('public_page_unavailable');
  let $=load(response.text());
  if(searchPage(new URL(response.url))){
    // One strongly matching original article only; never ingest a search-result page as news body.
    const candidate=$('a[href]').toArray().map(element=>({title:$(element).text().trim(),href:$(element).attr('href')!}))
      .find(row=>sameTrendHeadline(row.title,title)&&/^https:\/\//.test(row.href)&&!searchPage(new URL(row.href)));
    if(!candidate)throw new Error('awaiting_original_article');
    response=await get(candidate.href);if(response.status!==200)throw new Error('public_page_unavailable');$=load(response.text());
  }
  const pageTitle=($('meta[property="og:title"]').attr('content')??$('title').text()).trim();
  if(!pageTitle||/安全验证|人机验证|访问验证|登录后|请登录|Access denied|Just a moment|Captcha|验证码/i.test(pageTitle))throw new Error('public_page_unavailable');
  const body=readable(response.text(),response.url);
  if(!body||body.text.trim().length<80)throw new Error('awaiting_original_article');
  return{url:response.url,title:pageTitle,body:body.text,html:body.html,publishedAt:body.publishedAt};
}

/** Platform discovery enters ordinary news storage after obtaining actual public text. No title-only facts. */
export const trendNewsQueue=defineQueue<Job>({name:"studio.trends.news",options:{policy:"short",retryLimit:0,expireInSeconds:180},
  worker:{localConcurrency:1,batchSize:1,pollingIntervalSeconds:2,groupConcurrency:1},admission:createCollectionAdmission(),
  async run(jobs){for(const job of jobs){
    if(!collectionEnabled())throw new QueueDeferred("热榜正文采集已暂停");
    const [signal]=await sql<{title:string;url:string;platform:string}[]>`SELECT s.title,s.url,s.platform FROM studio_trend_signals s
      JOIN studio_trend_relevance r ON r.signal_id=s.id AND r.context_key=s.relevance_key JOIN studio_trend_boards b ON b.platform=s.platform
      JOIN sources source ON source.id=b.source_id JOIN studio_trend_news n ON n.signal_id=s.id AND n.relevance_key=s.relevance_key
      WHERE s.id=${job.signalId} AND s.relevance_key=${job.key} AND n.run_token=${job.token} AND source.enabled AND NOT source.archived
        AND r.state='completed' AND r.result->>'decision'='relevant'`;
    if(!signal)continue;
    try{
      let article: {url:string;title:string;body:string;html?:string|null;publishedAt?:Date|null}|null=null;
      // Reuse a collected public trend representative, never a random followed creator or private comments.
      const [representative]=await sql<{url:string;title:string;content:Record<string,unknown>;publishedAt:Date|null;body:string|null}[]>`
        SELECT p.content->>'url' AS url,p.content->>'title' AS title,p.content,(p.content->>'publishedAt')::timestamptz AS "publishedAt",t.result->>'text' AS body FROM studio_trend_deep_reads d
        JOIN studio_content_imports i ON i.id=d.import_id JOIN studio_creator_posts p ON p.id=i.post_id
        LEFT JOIN studio_media_transcripts t ON t.post_id=p.id AND t.source_fingerprint=p.content_fingerprint
        WHERE d.signal_id=${job.signalId} AND d.relevance_key=${job.key} AND i.state='ready'`;
      if(representative){
        const text=representative.body??(typeof representative.content.text==='string'?representative.content.text:typeof representative.content.description==='string'?representative.content.description:null);
        if(text&&text.trim().length>=80&&representative.publishedAt)article={url:representative.url,title:representative.title,
          body:`平台热榜发现的公开作品正文/字幕，作者观点需明确归因，榜单只说明关注程度：\n${text}`,publishedAt:representative.publishedAt};
      }
      if(!article)article=await publicPage(signal.url,signal.title);
      await sql.begin(async db=>{
        const [board]=await db`SELECT source.id FROM studio_trend_boards b JOIN sources source ON source.id=b.source_id
          WHERE b.platform=${signal.platform} AND source.enabled AND NOT source.archived FOR SHARE OF source`;
        const [current]=await db`SELECT s.id FROM studio_trend_signals s JOIN studio_trend_news n ON n.signal_id=s.id AND n.relevance_key=s.relevance_key
          WHERE s.id=${job.signalId} AND s.relevance_key=${job.key} AND s.title=${signal.title} AND s.url=${signal.url} AND n.run_token=${job.token} FOR UPDATE OF s,n`;
        if(!board||!current||!collectionEnabled())return;
        await db`SELECT pg_advisory_xact_lock(hashtext('studio-platform-trend-news-source'))`;
        const [source]=await db`SELECT id,participation_mode FROM sources WHERE id=${SOURCE}`;
        if(source&&source.participation_mode!=='editorial')throw new Error('source_isolated');
        if(!source)await createSource({id:SOURCE,name:"平台热榜发现",kind:"external",config:{},enabled:false,participation_mode:"editorial"},"system:trend-news",db);
        const [known]=await db<{id:string}[]>`SELECT id FROM articles WHERE identity_key=${identityKeyForUrl(article!.url)!}`;
        const articleId=known?.id??(await upsertMaterial({sourceId:SOURCE,url:article!.url,title:article!.title,bodyText:article!.body,
          bodyHtml:article!.html??null,bodyStatus:"ok",publishedAt:article!.publishedAt??null,media:[],via:"platform-trend"},db)).articleId;
        await db`UPDATE studio_trend_news SET state='ready',article_id=${articleId},error_code=NULL,updated_at=now()
          WHERE signal_id=${job.signalId} AND relevance_key=${job.key} AND run_token=${job.token}`;
      });
    }catch(error){
      if(error instanceof QueueDeferred)throw error;
      await sql`UPDATE studio_trend_news SET state='awaiting_content',error_code='awaiting_public_original',updated_at=now()
        WHERE signal_id=${job.signalId} AND relevance_key=${job.key} AND run_token=${job.token}`;
    }
  }},
});

export async function scheduleTrendNews(){
  if(!collectionEnabled())return{queued:0};await ensureQueue(trendNewsQueue.name,trendNewsQueue.options);
  const rows=await sql<{id:string;key:string;state:string|null;updatedAt:Date|null;representativeReady:boolean}[]>`SELECT s.id,s.relevance_key AS key,n.state,n.updated_at AS "updatedAt",
    EXISTS(SELECT 1 FROM studio_trend_deep_reads d JOIN studio_content_imports i ON i.id=d.import_id WHERE d.signal_id=s.id AND d.relevance_key=s.relevance_key AND i.state='ready') AS "representativeReady"
    FROM studio_trend_signals s JOIN studio_trend_relevance r ON r.signal_id=s.id AND r.context_key=s.relevance_key
    JOIN studio_trend_boards b ON b.platform=s.platform JOIN sources source ON source.id=b.source_id
    LEFT JOIN studio_trend_news n ON n.signal_id=s.id AND n.relevance_key=s.relevance_key
    WHERE source.enabled AND NOT source.archived AND r.state='completed' AND r.result->>'decision'='relevant'
      AND s.last_seen_at>=now()-interval '2 hours' AND NOT EXISTS(SELECT 1 FROM studio_trend_event_links l WHERE l.signal_id=s.id)
      AND (n.signal_id IS NULL OR n.state='awaiting_content' AND (n.updated_at<now()-interval '6 hours' OR n.error_code='awaiting_public_original' AND EXISTS(SELECT 1 FROM studio_trend_deep_reads d JOIN studio_content_imports i ON i.id=d.import_id WHERE d.signal_id=s.id AND d.relevance_key=s.relevance_key AND i.state='ready' AND i.updated_at>n.updated_at))) ORDER BY s.last_seen_at DESC LIMIT 20`;
  let queued=0;
  for(const row of rows){
    if(row.state==='ready')continue;
    const token=randomUUID();
    queued+=await sql.begin(async db=>{
      const [pending]=await db`INSERT INTO studio_trend_news(signal_id,relevance_key,state,run_token) VALUES(${row.id},${row.key},'queued',${token})
        ON CONFLICT(signal_id,relevance_key) DO UPDATE SET state='queued',run_token=EXCLUDED.run_token,updated_at=now()
        WHERE studio_trend_news.state<>'queued' RETURNING signal_id`;
      if(!pending)return 0;const id=await enqueueOn(trendNewsQueue,{signalId:row.id,key:row.key,token},{singletonKey:`${row.id}:${row.key}`},db);
      if(id)await db`UPDATE studio_trend_news SET job_id=${id} WHERE signal_id=${row.id} AND relevance_key=${row.key}`;return id?1:0;
    });
  }
  await refreshTrendEventLinks();return{queued};
}
