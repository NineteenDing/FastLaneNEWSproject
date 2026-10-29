import '../../../tests/setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MockAgent,getGlobalDispatcher,setGlobalDispatcher} from 'undici';
import {config} from '@aihot/backend/config';
import {openPlatformLogin} from '../backend/platform-login-browser.ts';

test('抖音扫码后登录标记和页面存储令牌一起保存，匿名会话不提前成功',async()=>{
 config.allowPrivateNetworkFetch=true;
 const previous=getGlobalDispatcher(),transport=new MockAgent();transport.disableNetConnect();setGlobalDispatcher(transport);
 transport.get('https://www.douyin.com').intercept({path:'/'}).reply(200,
  '<html><body><button style="position:absolute;left:0;top:0;width:100px;height:50px" onclick="document.cookie=\'sessionid=fixture-login; path=/; Secure\';localStorage.setItem(\'xmst\',\'fixture-sdk-token\')">登录</button></body></html>',
  {headers:{'content-type':'text/html'}});
 const controller=new AbortController();let browser;
 try{
  browser=await openPlatformLogin('douyin',controller.signal);
  assert.equal(await browser.session(),'');
  await browser.action({type:'click',x:40,y:20});
  const cookie=await browser.session();
  assert.match(cookie,/sessionid=fixture-login/);
  assert.match(cookie,/msToken=fixture-sdk-token/);
 }finally{controller.abort();await browser?.close();setGlobalDispatcher(previous);await transport.close();}
});
