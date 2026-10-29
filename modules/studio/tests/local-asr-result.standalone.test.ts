import '../../../tests/setup.ts';
import {test} from 'node:test';import assert from 'node:assert/strict';
import {parseLocalAsrRecognition} from '../backend/local-asr-result.ts';
test('本地ASR保留全部文字，小幅尾部时间误差收至真实时长，严重越界仍拒绝',()=>{
 const value={language:'zh',model:'local-asr',durationSeconds:219.766667,segments:[{start:0,end:3,text:'AI入门'},{start:218,end:220.08,text:'保持场景一致性'}]};
 const parsed=parseLocalAsrRecognition(value);
 assert.equal(parsed.segments[1].end,219.766667);assert.equal(parsed.segments[1].text,'保持场景一致性');assert.equal(value.segments[1].end,220.08);
 assert.throws(()=>parseLocalAsrRecognition({...value,segments:[{start:218,end:222,text:'严重越界'}]}));
 assert.throws(()=>parseLocalAsrRecognition({...value,segments:[{start:220,end:220.2,text:'完全超出媒体'}]}));
});
