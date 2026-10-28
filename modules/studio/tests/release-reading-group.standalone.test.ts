import {test} from 'node:test';
import assert from 'node:assert/strict';
import {releaseReadingKey} from '../backend/release-reading-key.ts';
test('同版本模型发布的转述和原始报道合并，真实测评保留第二视角，不合并另一版本或争议',()=>{
 const base:any={aiCentral:true,reportingKind:'original',facts:[{text:'Google发布Genie 4世界模型，提供研究预览。'}],event:{relation:'new',label:'Google 发布世界模型 Genie 4',identity:'Genie 4研究预览'}};
 assert.equal(releaseReadingKey(base),'genie4:release');
 assert.equal(releaseReadingKey({...base,reportingKind:'commentary',event:{...base.event,label:'Genie 4 世界模型发布'}}),'genie4:release');
 assert.equal(releaseReadingKey({...base,reportingKind:'test',facts:[...base.facts,{text:'我们实测Genie 4，长时一致性出现漂移。'}]}),'genie4:test');
 assert.equal(releaseReadingKey({...base,reportingKind:'test',event:{...base.event,label:'Genie 4 实测'},facts:[...base.facts,{text:'我们实测Genie 4，长时一致性出现漂移。'}]}),'genie4:test');
 assert.equal(releaseReadingKey({...base,event:{...base.event,label:'Genie 3 发布'},facts:[{text:'Google发布Genie 3世界模型。'}]}),'genie3:release');
 assert.equal(releaseReadingKey({...base,event:{...base.event,label:'Genie 4 发布传闻遭否认'}}),null);
 assert.equal(releaseReadingKey({...base,event:{...base.event,relation:'development'}}),null);
 assert.notEqual(releaseReadingKey({...base,event:{...base.event,label:'Qwen 3-Coder 发布'},facts:[{text:'Qwen 3-Coder发布。'}]}),releaseReadingKey({...base,event:{...base.event,label:'Qwen 3-VL 发布'},facts:[{text:'Qwen 3-VL发布。'}]}));
 const key=(name:string)=>releaseReadingKey({...base,event:{...base.event,label:name+' 发布'},facts:[{text:name+'发布。'}]});
 assert.notEqual(key('Gemini 2.5 Flash-Lite'),key('Gemini 2.5 Flash'));
 assert.notEqual(key('Claude 4.5 Sonnet'),key('Claude 4.5 Opus'));
 assert.notEqual(key('Qwen 3 Coder'),key('Qwen 3 VL'));
 assert.notEqual(key('Qwen3-8B'),key('Qwen3-32B'));
});
