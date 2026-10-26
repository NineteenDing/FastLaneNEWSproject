import './setup.ts';
import assert from 'node:assert/strict';import {test}from'node:test';import{spawn,execFile}from'node:child_process';import{promisify}from'node:util';import{mkdtemp,writeFile,mkdir,realpath,rm}from'node:fs/promises';import{createServer}from'node:http';import path from'node:path';import{once}from'node:events';
async function port(){const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const p=(s.address()as{port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return p;}
test('显式服务器模式保留HTTPS域名和可信代理，仍仅回环监听、关收费并以本机地址就绪',async()=>{
 await mkdir('.local',{recursive:true});const folder=await mkdtemp(path.resolve('.local/server-runtime-')),file=path.join(folder,'config.env'),api=await port(),web=await port();
 await writeFile(file,`DATABASE_URL=${process.env.DATABASE_URL}\nADMIN_PASSWORD=server-test-password-12345\nSESSION_SECRET=server-test-secret-1234567890\nIMG_PROXY_SIGN_SECRET=server-test-image-1234567890\nSTUDIO_RUNTIME_MODE=server\nSITE_URL=https://news.fastlane.chat\nAPI_PORT=${api}\nWEB_PORT=${web}\nAIHOT_DATA_DIR=${folder.replaceAll('\\','/')}/data\n`);
 const env: NodeJS.ProcessEnv={...process.env,STUDIO_LOCAL_ENV:file,STUDIO_LOCAL_RUN_DIR:path.join(folder,'run')};delete env.NODE_TEST_CONTEXT;const exec=promisify(execFile),cli=(c:string)=>exec(process.execPath,['scripts/studio-local.ts',c],{env,timeout:20000,windowsHide:true});
 const child=spawn(process.execPath,['scripts/studio-local.ts','start'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stderr.resume();
 try{await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('No ready')),20000);child.stdout.on('data',b=>{output+=String(b);if(output.includes('"state":"running"')){clearTimeout(timer);resolve();}});child.on('exit',()=>{clearTimeout(timer);reject(Error('Exited before ready'));});});
 const status=JSON.parse((await cli('status')).stdout);assert.equal(status.web,`http://127.0.0.1:${web}`);assert.equal(status.worker,'disabled');assert.equal(status.externalActions,'disabled');
 const html=await(await fetch(`http://127.0.0.1:${web}/about`)).text();assert.ok(html.includes('https://news.fastlane.chat/about'));
 assert.equal((await fetch(`http://127.0.0.1:${api}/api/admin/studio/drafts`)).status,401);
 }finally{const exit=once(child,'exit');await cli('stop');await exit;const safe=await realpath(folder);if(!safe.startsWith(path.resolve('.local')+path.sep))throw Error('Unsafe cleanup');await rm(safe,{recursive:true,force:true});}
});
