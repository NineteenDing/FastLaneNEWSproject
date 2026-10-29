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
test('通过预筛的指定作品继续取得评论和播放量；同页无关vlog不会请求评论',async()=>{
const api=agent.get('https://api.bilibili.com');api.intercept({path:'/x/web-interface/nav'}).reply(200,{code:0,data:{wbi_img:{img_url:'https://i0.hdslb.com/7cd084941338484aae1ad9425b84077c.png',sub_url:'https://i0.hdslb.com/4932caff0ff746eab6f01bf08b70ac45.png'}}});
api.intercept({path:/^\/x\/space\/wbi\/acc\/info\?/}).reply(200,{code:0,data:{mid:946974,name:'影视飓风',sign:'摄影',face:null}});
api.intercept({path:/^\/x\/space\/wbi\/arc\/search\?/}).reply(200,{code:0,data:{page:{count:900},list:{vlist:[{aid:123,bvid:'BVAItest',title:'AI短片',description:'ComfyUI',created:1793232000,play:2000000,comment:80},{aid:124,bvid:'BVvlogtest',title:'日常vlog',description:'广西摸鱼',created:1793231000,play:8000000,comment:800}]}}});
api.intercept({path:/^\/x\/v2\/reply\/wbi\/main\?/}).reply(200,{code:0,data:{cursor:{is_end:true},replies:[{rpid:99,ctime:1793232200,like:8,content:{message:'人物一致性怎么做？'}}]}});
const result=await collectMediaCreator({platform:'bilibili',locator:'946974',onlyIds:['BVAItest'],metadataLimit:5});assert.equal(result.posts.length,1);assert.equal(result.posts[0].metrics.views,2000000);assert.equal(result.posts[0].comments[0].text,'人物一致性怎么做？');agent.assertNoPendingInterceptors();
});
