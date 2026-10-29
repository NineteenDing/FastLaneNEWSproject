import {test} from 'node:test';import assert from 'node:assert/strict';
import {selectCreatorIntake,creatorMediaRelevant} from '../backend/creator-intake.ts';
test('首次仅最近五个，增量不回灌，未来与未知日期不伪装新作品；百万vlog不匹配',()=>{
const now='2026-10-29T10:00:00Z';const posts=Array.from({length:12},(_,i)=>({externalId:String(i),publishedAt:`2026-10-${String(28-i).padStart(2,'0')}T00:00:00Z`,title:'普通日常vlog',text:'影视飓风员工去广西摸鱼',metrics:{views:5000000}}));
assert.deepEqual(selectCreatorIntake(posts,null,now).map(p=>p.externalId),['0','1','2','3','4']);
assert.equal(selectCreatorIntake(posts,'2026-10-28T00:00:00Z',now).length,0);
assert.equal(selectCreatorIntake(posts,'2026-10-20T00:00:00Z',now).length,8);
assert.equal(creatorMediaRelevant(posts[0]),false);assert.equal(creatorMediaRelevant({title:'ComfyUI视频工作流',text:''}),true);assert.equal(creatorMediaRelevant({title:'GPT新模型上线',text:''}),true);
});
