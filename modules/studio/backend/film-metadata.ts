import { randomUUID } from "node:crypto";
import { load } from "cheerio";
import { sql } from "@aihot/backend/db";
import { defineQueue } from "@aihot/backend/modules";
import { ensureQueue, enqueueOn, QueueDeferred, shutdownSignal } from "@aihot/backend/jobs/queue";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { sha256 } from "@aihot/backend/lib/ids";
import { collectionEnabled } from "@aihot/backend/operations/collection-control";
import type { FilmBoardItem, FilmBoardSnapshot } from "../film-boards-contracts.ts";
import { filmBoardCatalog } from "./film-board-catalog.ts";
import { createCollectionAdmission } from "./collection-admission.ts";
import { submitFilmTranslation } from "./film-translation.ts";

type Metadata = Pick<FilmBoardItem,"sourceSummary"|"productionCountries"|"countryStatus"|"summaryKind"|"summaryStatus">;
type Job = { boardId: string; version: number; snapshotAt: string; item: FilmBoardItem; key: string; token: string };
const metadataKey = (boardId: string, item: FilmBoardItem) => sha256(JSON.stringify([boardId.startsWith("hongguo-") ? "hongguo" : boardId, item.id, item.url]));
const clean = (value: unknown) => typeof value === "string" && value.trim() ? load(`<div>${value}</div>`).text().replace(/\s+/g," ").trim().slice(0,1600) : null;
const object = (value: unknown): Record<string,unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string,unknown> : {};
const countryNames: Record<string,string> = { US:"美国",USA:"美国","United States":"美国",CN:"中国",China:"中国",UK:"英国",GB:"英国","United Kingdom":"英国",CA:"加拿大",Canada:"加拿大",KR:"韩国","South Korea":"韩国",JP:"日本",Japan:"日本" };
const countries = (value: unknown): string[] => [...new Set((Array.isArray(value) ? value : value ? [value] : []).flatMap(entry => {
  const name = clean(typeof entry === "string" ? entry : object(entry).name);
  return name && name.length <= 80 ? [countryNames[name] ?? name] : [];
}))];

/** Target-scoped JSON/SSR only: never read the first recommended video's description or execute JS. */
export async function readFilmMetadata(boardId: string, item: FilmBoardItem): Promise<Metadata> {
  const board = filmBoardCatalog.find(row => row.id === boardId);
  if (!board?.supported || board.retired || !board.sourceUrl) throw new Error("retired_board");
  const url = new URL(item.url), origin = new URL(board.sourceUrl).origin;
  if (url.origin !== origin || url.username || url.password || url.protocol !== "https:") throw new Error("invalid_work_url");
  const response = await guardedFetch(url.href,{timeoutMs:12000,maxBytes:4*1024**2,redirect:"error",signal:shutdownSignal.signal,
    headers:{"user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/119.0.0.0 Safari/537.36"}});
  if (response.status !== 200) throw new Error("detail_unavailable");
  const $ = load(response.text());
  let summary: string|null = null, kind: Metadata["summaryKind"] = "missing", productionCountries: string[] = [];
  if (boardId === "verticalcharts-52") {
    const canonical = (value: unknown) => { try { const u = new URL(String(value),origin); return u.origin+u.pathname.replace(/\/$/,""); } catch { return ""; } };
    const entries: Record<string,unknown>[] = [];
    for (const element of $("script[type='application/ld+json']").toArray()) {
      let parsed: unknown; try { parsed=JSON.parse($(element).text()); } catch { continue; }
      const roots = Array.isArray(parsed) ? parsed : [parsed];
      for (const root of roots) { const row=object(root); entries.push(...(Array.isArray(row["@graph"]) ? row["@graph"].map(object) : [row])); }
    }
    const target = entries.find(row => ["TVSeries","Movie","CreativeWork"].includes(String(row["@type"])) && canonical(row.url ?? row["@id"]) === canonical(item.url));
    if (!target) throw new Error("target_metadata_missing");
    summary=clean(target.description);kind=summary?"work":"missing";
    productionCountries=countries(target.countryOfOrigin ?? target.countryOfProduction ?? target.productionCountry);
  } else if (boardId.startsWith("aitop100-")) {
    const match=/\/aivlogdetail\/(group|works)\/([^/.]+)\.html$/.exec(url.pathname);
    if (!match || match[2] !== item.id) throw new Error("work_identity_mismatch");
    let state: Record<string,unknown>|null=null;
    for (const element of $("script:not([src])").toArray()) {
      const script=$(element).text(), prefix=/window\.__INITIAL_STATE__\s*=\s*/.exec(script);
      if (!prefix) continue;
      try { state=object(JSON.parse(script.slice(prefix.index+prefix[0].length).trim().replace(/;\s*$/,""))); } catch { continue; }
    }
    const store=object(state?.aicreationStore), group=match[1] === "group";
    const possible=group ? [object(store.shortDetailGroupView)] : [object(store.shortVideoWorksView),object(store.shortDetailWorksView),object(store.shortVideoView)];
    const target=possible.find(row => String(row.id) === item.id);
    if (!target) throw new Error("work_identity_mismatch");
    summary=clean(target.groupIntro ?? target.details ?? target.worksIntro ?? target.description);kind=summary ? group?"collection":"work" : "missing";
    if (!summary && group && Array.isArray(target.groupWorks)) {
      const episode=target.groupWorks.map(object).sort((a,b)=>Number(a.idx)-Number(b.idx)).find(row=>clean(row.worksIntro));
      summary=clean(episode?.worksIntro);if(summary)kind="representative_episode";
    }
    productionCountries=countries(target.countryOfOrigin ?? target.productionCountry);
  } else {
    // Current Hongguo lists already provide verified target summaries. Never copy recommendations.
    summary=item.sourceSummary??null;kind=summary?"work":"missing";
  }
  return { sourceSummary:summary,summaryKind:kind,summaryStatus:summary?"ready":"source_missing",productionCountries,
    countryStatus:productionCountries.length?"verified":"not_provided" };
}

async function mergeMetadata(job: Job, metadata: Metadata) {
  await sql.begin(async db => {
    const [current]=await db<{ snapshot:FilmBoardSnapshot;version:number;definition:{enabled:boolean} }[]>`SELECT snapshot,version,definition FROM studio_film_boards WHERE id=${job.boardId} FOR UPDATE`;
    if (!current?.definition.enabled || current.version !== job.version || current.snapshot?.fetchedAt !== job.snapshotAt) return;
    const items=current.snapshot.items.map(item=>item.id===job.item.id && item.url===job.item.url ? {...item,...metadata,
      sourceSummary:metadata.sourceSummary??item.sourceSummary??null,
      summaryKind:metadata.sourceSummary?metadata.summaryKind:item.sourceSummary?(item.summaryKind??"work"):metadata.summaryKind,
      summaryStatus:metadata.sourceSummary||item.sourceSummary?"ready":metadata.summaryStatus} : item);
    await db`UPDATE studio_film_boards SET snapshot=${db.json({...current.snapshot,items} as never)},updated_at=now() WHERE id=${job.boardId}`;
  });
}

export async function filmMetadataPending(boardId:string){
  const [row]=await sql<{snapshot:FilmBoardSnapshot|null}[]>`SELECT snapshot FROM studio_film_boards WHERE id=${boardId}`;
  const keys=(row?.snapshot?.items??[]).map(item=>metadataKey(boardId,item));
  return !!(keys.length&&(await sql`SELECT 1 FROM studio_film_metadata WHERE cache_key=ANY(${keys}::text[]) AND state='queued' AND expires_at>now() LIMIT 1`).length);
}

/** Only a small text cache is persisted. Public GETs never request detail pages or models. */
export async function submitFilmMetadata(boardId: string) {
  const board=filmBoardCatalog.find(row=>row.id===boardId);
  if (!collectionEnabled() || !board?.supported || board.retired || boardId === "lvpaopao") return {queued:0};
  const [row]=await sql<{version:number;snapshot:FilmBoardSnapshot;definition:{enabled:boolean}}[]>`SELECT version,snapshot,definition FROM studio_film_boards WHERE id=${boardId}`;
  if (!row?.definition.enabled || !row.snapshot?.items.length) return {queued:0};
  await ensureQueue(filmMetadataQueue.name,filmMetadataQueue.options);
  let queued=0;
  for (const item of row.snapshot.items.slice(0,board.limit??20)) {
    if (board.region === "domestic" && item.sourceSummary) continue;
    const key=metadataKey(boardId,item),token=randomUUID(),job:Job={boardId,version:row.version,snapshotAt:row.snapshot.fetchedAt,item,key,token};
    const [cached]=await sql<{payload:Metadata|null;state:string;expires_at:Date}[]>`SELECT payload,state,expires_at FROM studio_film_metadata WHERE cache_key=${key}`;
    if (cached && cached.expires_at.getTime()>Date.now()) { if(cached.state==='ready'&&cached.payload)await mergeMetadata(job,cached.payload);continue; }
    queued+=await sql.begin(async db=>{
      const [claim]=await db`INSERT INTO studio_film_metadata(cache_key,state,run_token,expires_at) VALUES(${key},'queued',${token},now()+interval '15 minutes')
        ON CONFLICT(cache_key) DO UPDATE SET state='queued',run_token=EXCLUDED.run_token,expires_at=EXCLUDED.expires_at,updated_at=now()
        WHERE studio_film_metadata.expires_at<=now() RETURNING cache_key`;
      if(!claim)return 0;
      const id=await enqueueOn(filmMetadataQueue,job,{singletonKey:key},db);return id?1:0;
    });
  }
  return {queued};
}

export const filmMetadataQueue=defineQueue<Job>({name:"studio.film.metadata",options:{policy:"short",retryLimit:0,expireInSeconds:60},
  worker:{localConcurrency:1,batchSize:1,pollingIntervalSeconds:2,groupConcurrency:1},admission:createCollectionAdmission(),
  async run(jobs){for(const job of jobs){
    if(!collectionEnabled())throw new QueueDeferred("榜单详情采集已暂停");
    const board=filmBoardCatalog.find(row=>row.id===job.boardId);if(!board?.supported||board.retired)continue;
    const [current]=await sql`SELECT id FROM studio_film_boards WHERE id=${job.boardId} AND version=${job.version}
      AND snapshot->>'fetchedAt'=${job.snapshotAt} AND (definition->>'enabled')::boolean`;
    if(!current){
      await sql`UPDATE studio_film_metadata SET state='failed',expires_at=now(),updated_at=now()
        WHERE cache_key=${job.key} AND run_token=${job.token} AND state='queued'`;
      continue;
    }
    try{
      const metadata=await readFilmMetadata(job.boardId,job.item);
      if(!collectionEnabled())throw new QueueDeferred("榜单详情采集已暂停");
      const saved=await sql`UPDATE studio_film_metadata SET state='ready',payload=${sql.json(metadata as never)},expires_at=now()+interval '7 days',updated_at=now()
        WHERE cache_key=${job.key} AND run_token=${job.token} RETURNING cache_key`;
      if(saved.length){await mergeMetadata(job,metadata);if(!await filmMetadataPending(job.boardId))await submitFilmTranslation(job.boardId);}
    }catch(error){
      if(error instanceof QueueDeferred)throw error;
      await sql`UPDATE studio_film_metadata SET state='failed',expires_at=now()+interval '6 hours',updated_at=now() WHERE cache_key=${job.key} AND run_token=${job.token}`;
      if(!await filmMetadataPending(job.boardId))await submitFilmTranslation(job.boardId);
    }
  }},
});

export async function scheduleFilmMetadata(){
  await sql`UPDATE studio_film_metadata metadata SET state='failed',expires_at=now(),updated_at=now()
    WHERE state='queued' AND updated_at<now()-interval '1 minute' AND NOT EXISTS(SELECT 1 FROM pgboss.job job
      WHERE job.name=${filmMetadataQueue.name} AND job.state IN ('created','retry','active') AND job.data->>'key'=metadata.cache_key AND job.data->>'token'=metadata.run_token)`;
  let queued=0;for(const board of filmBoardCatalog.filter(row=>row.supported&&!row.retired))queued+=(await submitFilmMetadata(board.id)).queued;return{queued};
}
