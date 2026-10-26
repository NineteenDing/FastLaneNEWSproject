// Server-only initialization. Refuses existing clusters/configuration and never touches the developer instance.
import { writeEnvironment } from './write-environment.mjs';
import path from 'node:path';import {fileURLToPath}from'node:url';import{randomBytes}from'node:crypto';import{mkdir,readFile,writeFile,access,unlink,cp}from'node:fs/promises';import{execFileSync}from'node:child_process';import{createRequire}from'node:module';
const bundle=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),app=path.join(bundle,'app'),require=createRequire(path.join(app,'package.json')),postgres=require('postgres');
const args=Object.fromEntries(process.argv.slice(2).map(value=>value.split('=')));
const url=new URL(args['--url']||'https://news.fastlane.chat');if(url.protocol!=='https:'||url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw Error('Expected HTTPS origin');
function port(key,fallback){const n=Number(args[key]||fallback);if(!Number.isInteger(n)||n<1024||n>65535)throw Error('Invalid port');return n;}
const dbPort=port('--db-port',55432),webPort=port('--web-port',4310),apiPort=port('--api-port',4311);if(new Set([dbPort,webPort,apiPort]).size!==3)throw Error('Ports must differ');
const local=path.join(app,'.local'),pg=path.join(local,'pgdata'),envFile=path.join(app,'.env');
for(const file of [envFile,path.join(pg,'PG_VERSION')])if(await access(file).then(()=>true,()=>false))throw Error('Existing configuration/cluster: preserve it and follow upgrade procedure');
await mkdir(local,{recursive:true});const pgBin=path.join(bundle,'tools/postgresql/bin'),node=path.join(bundle,'tools/node/node.exe');const pgPassword=randomBytes(32).toString('hex'),appPassword=randomBytes(32).toString('hex'),pwFile=path.join(local,'pg-init-password.txt');
const secretFile=path.join(bundle,'data-export/restore-secrets.env');let saved={};try{const{parseEnv}=await import('node:util');saved=parseEnv(await readFile(secretFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const adminPassword=saved.ADMIN_PASSWORD||randomBytes(20).toString('hex');
const values={SITE_URL:url.origin,STUDIO_RUNTIME_MODE:'server',API_PORT:String(apiPort),WEB_PORT:String(webPort),DATABASE_URL:`postgres://studio_app:${appPassword}@127.0.0.1:${dbPort}/studio_local`,AIHOT_DATA_DIR:'.local/data',ADMIN_USERNAME:saved.ADMIN_USERNAME||'admin',ADMIN_PASSWORD:adminPassword,SESSION_SECRET:saved.SESSION_SECRET||randomBytes(32).toString('hex'),IMG_PROXY_SIGN_SECRET:saved.IMG_PROXY_SIGN_SECRET||randomBytes(32).toString('hex'),STUDIO_LOCAL_WORKER_ENABLED:'false',COLLECT_ENABLED:'false',MODEL_CALLS_ENABLED:'false',STUDIO_MEDIA_ENABLED:'false',FEISHU_CONTENT_PUSH_ENABLED:'false',FEISHU_INTERNAL_ENABLED:'false',INDEXNOW_SUBMIT_ENABLED:'false',LLM_BASE_URL:'https://api.deepseek.com/v1',LLM_MODEL:'deepseek-flash',LLM_API_KEY:'',LLM_EXTRA_JSON:'{"thinking":{"type":"disabled"}}',STUDIO_RSSHUB_NATIVE_DIRECTORY:'runtime/rsshub',STUDIO_MEDIACRAWLER_PYTHON:'runtime/mediacrawler-env/Scripts/python.exe',STUDIO_MEDIACRAWLER_SOURCE:'runtime/mediacrawler-source',STUDIO_ASR_PYTHON:'runtime/asr-env/Scripts/python.exe',STUDIO_ASR_MODEL_DIRECTORY:'runtime/asr-model-large-v3-turbo-int8',PLAYWRIGHT_BROWSERS_PATH:'runtime/browsers'};
await writeFile(pwFile,pgPassword+'\n',{flag:'wx',mode:0o600});
const baseEnv={...process.env,PATH:path.dirname(node)+';'+pgBin+';'+process.env.PATH};
function pgRun(exe,arguments_,extra={}){return execFileSync(path.join(pgBin,exe+'.exe'),arguments_,{env:{...baseEnv,...extra},windowsHide:true,encoding:'utf8',stdio:'ignore',timeout:120000});}
try{pgRun('initdb',['-D',pg,'-U','postgres','--pwfile',pwFile,'--encoding=UTF8','--locale=C','--auth=scram-sha-256']);}finally{await unlink(pwFile);}
await writeFile(path.join(pg,'postgresql.auto.conf'),`listen_addresses = '127.0.0.1'\nport = ${dbPort}\nmax_connections = 40\nshared_buffers = '256MB'\nwork_mem = '4MB'\nmaintenance_work_mem = '64MB'\nmax_wal_size = '1GB'\nmin_wal_size = '80MB'\nlogging_collector = on\nlog_filename = 'postgresql-%a.log'\nlog_rotation_age = '1d'\nlog_rotation_size = '10MB'\nlog_truncate_on_rotation = on\n`);
pgRun('pg_ctl',['-D',pg,'-l',path.join(local,'postgres-start.log'),'-w','start']);
const sql=postgres(`postgres://postgres:${pgPassword}@127.0.0.1:${dbPort}/postgres`,{max:1});
try{await sql.unsafe(`CREATE ROLE studio_app LOGIN PASSWORD '${appPassword}'`);await sql.unsafe('CREATE DATABASE studio_local OWNER studio_app');}finally{await sql.end();}
await writeEnvironment(envFile,values);
await writeFile(path.join(local,'administrator-access.txt'),`URL: ${url.origin}/admin/login\nUsername: ${values.ADMIN_USERNAME}\nPassword: ${adminPassword}\nPostgreSQL administrator password: ${pgPassword}\nKeep this file private; do not paste into chat or publish.\n`,{mode:0o600,flag:'wx'});
const data=path.join(local,'data');await mkdir(data,{recursive:true});
try{await cp(path.join(bundle,'data-export/data'),data,{recursive:true,force:false});}catch(e){if(e.code!=='ENOENT')throw e;}
const dump=path.join(bundle,'data-export/database.dump');
if(await access(dump).then(()=>true,()=>false)){
 pgRun('pg_restore',['--exit-on-error','--no-owner','--no-privileges','--host=127.0.0.1','--port='+dbPort,'--username=studio_app','--dbname=studio_local',dump],{PGPASSWORD:appPassword});
 const db=postgres(values.DATABASE_URL,{max:1});try{const info=JSON.parse(await readFile(path.join(bundle,'data-export/data-root.json'),'utf8'));const next=path.join(data,'studio/image-assets').toLowerCase();await db`UPDATE studio_image_assets SET storage_root=${next} WHERE storage_root=${info.imageStorageRoot}`;}finally{await db.end();}
}
execFileSync(node,['--env-file=.env','scripts/migrate.ts'],{cwd:app,env:baseEnv,windowsHide:true,stdio:'inherit'});
console.log(JSON.stringify({ok:true,database:'initialized_loopback_only',publicUrl:url.origin,webPort,apiPort,paidAndCollection:'off',next:'read .local/administrator-access.txt privately; verify login through HTTPS then enable chosen tasks'}));
