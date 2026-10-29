import {test} from 'node:test';import assert from 'node:assert/strict';
import {selectCreatorIntake,creatorMediaRelevant} from '../backend/creator-intake.ts';
test('首次仅最近五个，增量不回灌，未来与未知日期不伪装新作品；百万vlog不匹配',()=>{
const now='2026-10-29T10:00:00Z';const posts=Array.from({length:12},(_,i)=>({externalId:String(i),publishedAt:`2026-10-${String(28-i).padStart(2,'0')}T00:00:00Z`,title:'普通日常vlog',text:'影视飓风员工去广西摸鱼',metrics:{views:5000000}}));
assert.deepEqual(selectCreatorIntake(posts,null,now).map(p=>p.externalId),['0','1','2','3','4']);
assert.equal(selectCreatorIntake(posts,'2026-10-28T00:00:00Z',now).length,0);
assert.equal(selectCreatorIntake(posts,'2026-10-20T00:00:00Z',now).length,8);
assert.equal(creatorMediaRelevant(posts[0]),false);assert.equal(creatorMediaRelevant({title:'ComfyUI视频工作流',text:''}),true);assert.equal(creatorMediaRelevant({title:'GPT新模型上线',text:''}),true);
});

test('AI场景一致性与创作Skill进入采集，无关技能及高热日常仍排除',()=>{
 for(const title of ['一招教你精准保持AI场景一致性','AI主体一致性和多视角控制','把AI提示词做成skill，复用创作流程','Agent Skills让智能体复用你的流程','做了上百期ai教程 今天我把小白AI入门讲透了','一个Skill搞定高燃AI打戏！','Ai动画才是新的突破口！','一招教你100%保持场景一致性 #ai技巧','3步教你做出电影级AI短片！'])
  assert.equal(creatorMediaRelevant({title,text:''}),true,title);
 for(const title of ['足球skills集锦','摄影师日常vlog，今天去广西摸鱼','场景一致性：家居装修要点'])
  assert.equal(creatorMediaRelevant({title,text:''}),false,title);
});
