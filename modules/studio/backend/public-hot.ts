import { sql } from "@aihot/backend/db";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { listedCondition } from "@aihot/backend/publication/scope";
import { storedHotRanking, type HotEntry } from "@aihot/backend/events/hot";
import { sharedEventObservations } from "./shared-events.ts";
import { currentFilterPolicy } from "./filter-settings.ts";

export const PUBLIC_HOT_VERSION="studio-shared-heat-v3-retained";
type Report={storyId:number;publicId:string;eventId:string;id:string;title:string;sourceName:string;tier:string;sourceId:string;participant:string;url:string;publishedAt:Date;selected:boolean;score:number|null};

/** New candidates plus previous top ten compete by decayed observations; no 48-hour removal. */
export async function calculatePublicHot(at=new Date(),storyIds?:number[]){
  return sql.begin("isolation level repeatable read read only",async db=>{
    const policy=await currentFilterPolicy(db), previous=await storedHotRanking(db);
    const retained=previous?.entries.map(entry=>entry.storyId)??[];
    const reports=await db<Report[]>`SELECT p.story_id AS "storyId",st.public_id AS "publicId",m.event_id AS "eventId",
      p.article_id AS id,p.title,s.name AS "sourceName",s.tier,s.id AS "sourceId",coalesce('entity:'||s.owner_entity_id,'group:'||s.signal_group_id,'source:'||s.id) AS participant,
      p.url,coalesce(p.published_at,p.discovered_at) AS "publishedAt",p.selected,p.score
      FROM publications p JOIN stories st ON st.id=p.story_id JOIN sources s ON s.id=p.source_id
      JOIN studio_history_index h ON h.article_id=p.article_id
      JOIN studio_shared_event_members m ON m.material_id=h.material_id AND m.source_key=h.knowledge->>'sourceKey'
      WHERE ${listedCondition(at)} AND coalesce(p.published_at,p.discovered_at)<=${at} AND h.collected_at<=${at}
        AND (coalesce(p.published_at,p.discovered_at)>=${new Date(at.getTime()-120*3600000)} OR p.story_id=ANY(${retained}::bigint[]))
        AND (${storyIds===undefined} OR p.story_id=ANY(${storyIds??[]}::bigint[]))
      ORDER BY p.published_at DESC,p.article_id LIMIT 1000`;
    const ids=[...new Set(reports.map(row=>row.eventId))];
    const observations=await sharedEventObservations(db,ids,at,policy,"public",true);
    const scope=await db`SELECT id,participation_mode,owner_entity_id,signal_group_id FROM sources WHERE enabled AND NOT archived ORDER BY id`;
    const observationKey=sha256(stableJson({scope,policy:policy.editorial,version:PUBLIC_HOT_VERSION}));
    const [comparison]=await db<{entries:HotEntry[]}[]>`SELECT entries FROM hot_rankings WHERE published AND rule_version=${PUBLIC_HOT_VERSION}
      AND computed_at<=${new Date(at.getTime()-6*3600000)} AND computed_at>=${new Date(at.getTime()-6.5*3600000)} ORDER BY computed_at DESC LIMIT 1`;
    const previousEntries=comparison?.entries??[];
    const groups=new Map<number,Report[]>();for(const report of reports)groups.set(Number(report.storyId),[...(groups.get(Number(report.storyId))??[]),report]);
    const entries:HotEntry[]=[], newsValues=new Map<number,number>();
    for(const [storyId,members]of groups){
      const ordered=[...members].sort((a,b)=> (observations.get(b.eventId)?.heatV2.observed??-1)-(observations.get(a.eventId)?.heatV2.observed??-1)
        ||Number(b.selected)-Number(a.selected)||(b.score??0)-(a.score??0)||b.publishedAt.getTime()-a.publishedAt.getTime()||a.id.localeCompare(b.id));
      const rep=ordered[0]!, observation=observations.get(rep.eventId),heat=observation?.heatV2.observed;
      if(heat===null||heat===undefined||heat<=0)continue;
      const reporters=[...new Map(members.map(row=>[row.participant,row])).values()];
      const platforms=(observation?.heatV2.channels.trends??[]).filter(row=>row.freshValue!==null);
      const channels=observation!.heatV2.channels;
      const dominant=[{key:"reports",value:channels.reports.value??-1},...channels.video.map(channel=>({key:"video:"+channel.platform,value:channel.value??-1})),
        ...channels.trends.map(channel=>({key:"trend:"+channel.board,value:channel.value??-1}))].sort((a,b)=>b.value-a.value||a.key.localeCompare(b.key))[0]!.key;
      const comparableKey=sha256(stableJson({scope:observationKey,event:rep.eventId,representative:rep.id,members:observation!.heatV2.memberVersion,dominant,
        platforms:platforms.map(row=>row.board).sort()}));
      const prior=previousEntries.find(entry=>entry.storyId===storyId&&entry.observationKey===comparableKey);
      newsValues.set(storyId,rep.score??0);
      const pct=prior&&prior.heat>0?(heat-prior.heat)/prior.heat:null;
      const latest=Math.max(...members.map(row=>row.publishedAt.getTime()));
      entries.push({rank:0,storyId,storyPublicId:rep.publicId,title:rep.title,heatBasis:channels.reports.participants<=1&&!channels.video.some(channel=>channel.value!==null)&&!channels.trends.some(channel=>channel.value!==null)?"single_source":"observed",heat:Math.round(heat*100)/100,
        trend:pct===null?"unknown":pct>.1?"up":pct<-.1?"down":"flat",trendPct:pct===null?null:Math.round(pct*1000)/10,
        badges:at.getTime()-Math.min(...members.map(row=>row.publishedAt.getTime()))<6*3600000?["new"]:[],
        participantCount:reporters.length+platforms.length,sourceCount:new Set(members.map(row=>row.sourceId)).size,
        signalCount:platforms.length,reportCount:members.length,sourceNames:[...new Set(members.map(row=>row.sourceName))].slice(0,8),
        latestAt:new Date(latest).toISOString(),firstReportAt:new Date(Math.min(...members.map(row=>row.publishedAt.getTime()))).toISOString(),
        representativeItemId:rep.id,representativeUrl:rep.url,representativeSource:rep.sourceName,observationKey:comparableKey,
        participants:[...reporters.slice(0,30).map(row=>({name:row.sourceName,kind:"editorial" as const,tier:row.tier})),
          ...platforms.map(row=>({name:row.board,kind:"signal" as const}))]});
    }
    // Fixed five-point bands avoid pretending sparse observations are precise to a point.
    entries.sort((a,b)=>Math.floor(b.heat/5)-Math.floor(a.heat/5)||(newsValues.get(b.storyId)??0)-(newsValues.get(a.storyId)??0)||b.heat-a.heat||b.latestAt.localeCompare(a.latestAt)||a.storyId-b.storyId);
    return{entries:entries.slice(0,10).map((entry,index)=>({...entry,rank:index+1})),coverage:{retention:"rank_competition",halfLifeHours:policy.editorial?.heat.halfLifeHours??24,
      minParticipants:1,rankingBandWidth:5,candidates:entries.length,observationKey,observedScope:"public",heatMeaning:"max of independent reports, observed video metrics and verified platform ranks; not global views"}};
  });
}

/** Saved observations only, under the same source cohort and rule. Never fabricate the missing past. */
export async function publicHeatSeries(storyId:number,now=new Date(),days=7){
  const rows=await sql<{at:Date;entry:HotEntry}[]>`SELECT r.computed_at AS at,entry FROM hot_rankings r CROSS JOIN LATERAL jsonb_array_elements(r.entries) entry
    WHERE r.published AND r.rule_version=${PUBLIC_HOT_VERSION} AND r.computed_at<=${now}
      AND r.computed_at>=${new Date(now.getTime()-days*86400000)} AND (entry->>'storyId')::bigint=${storyId} ORDER BY r.computed_at`;
  const key=rows.at(-1)?.entry.observationKey;
  const compatible=rows.filter(row=>row.entry.observationKey===key);
  return compatible.map(row=>({hour:row.at,heat:row.entry.heat,participants:row.entry.participantCount}));
}
