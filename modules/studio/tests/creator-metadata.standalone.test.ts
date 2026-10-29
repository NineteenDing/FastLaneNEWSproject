import {config} from "@aihot/backend/config";
import '../../../tests/setup.ts';import {test,after} from 'node:test';import assert from 'node:assert/strict';import {MockAgent,getGlobalDispatcher,setGlobalDispatcher} from 'undici';import {collectMediaCreator} from '../backend/mediacrawler.ts';
config.allowPrivateNetworkFetch=true;
const old=getGlobalDispatcher(),agent=new MockAgent();agent.disableNetConnect();setGlobalDispatcher(agent);after(async()=>{setGlobalDispatcher(old);await agent.close();});
test('关注B站首批仅请求5条元数据，不请求评论或视频下载，平台总数不触发历史分页',async()=>{
const api=agent.get('https://api.bilibili.com');api.intercept({path:'/x/web-interface/nav'}).reply(200,{code:0,data:{wbi_img:{img_url:'https://i0.hdslb.com/7cd084941338484aae1ad9425b84077c.png',sub_url:'https://i0.hdslb.com/4932caff0ff746eab6f01bf08b70ac45.png'}}});
api.intercept({path:/^\/x\/space\/wbi\/acc\/info\?/}).reply(200,{code:0,data:{mid:946974,name:'影视飓风',sign:'摄影',face:null}});
api.intercept({path:value=>{const u=new URL(value,'https://api.bilibili.com');return u.pathname==='/x/space/wbi/arc/search'&&u.searchParams.get('ps')==='5'&&u.searchParams.get('pn')==='1';}}).reply(200,{code:0,data:{page:{count:900},list:{vlist:Array.from({length:6},(_,i)=>({aid:123+i,bvid:'BV1test'+i,title:'普通vlog',description:'广西摸鱼',created:1793232000-i,play:5000000,comment:800}))}}});
const result=await collectMediaCreator({platform:'bilibili',locator:'946974',metadataOnly:true,metadataLimit:5});assert.equal(result.posts.length,5);assert.ok(result.posts.every(p=>p.comments.length===0&&!p.media));agent.assertNoPendingInterceptors();
});
