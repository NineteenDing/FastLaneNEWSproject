import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeMaterialOutput,parseMaterialJson,MATERIAL_OUTPUT_TEMPLATE} from '../backend/material-wire.ts';
import {assessment} from '../backend/material-assessment.ts';
import {historyEntitySchema} from '../backend/history-entities.ts';
import {materialInsightsSchema} from '../backend/material-insights.ts';
import {sharedMaterialSchema} from '../backend/shared-material.ts';
test('模型契约兼容额外字段、数字布尔、根层v2与已知别名，不为额外字段整份重试',()=>{
 const raw=structuredClone(MATERIAL_OUTPUT_TEMPLATE);
 const value:any={...raw,gates:{audience:1,evidence:'true',benefit:'通过'},shared:{...raw.shared,eventCandidates:[],eventTime:null,publicSummaryFactIds:[0]}};
 value.shared.reportingKind='original_report';value.shared.aiCentral=1;value.shared.filmRelevant=1;
 delete value.shared.summaryFactIds;
 const result=assessment.extend({shared:sharedMaterialSchema,entities:historyEntitySchema,insights:materialInsightsSchema}).safeParse(normalizeMaterialOutput(value));
 assert.equal(result.success,true);if(result.success){assert.equal(result.data.gates.audience,true);assert.equal(result.data.shared.reportingKind,'original');assert.deepEqual(result.data.shared.summaryFactIds,[0]);}
});
test('JSON围栏和尾逗号可无损接收，字符串中的逗号与括号不能改变',()=>{
 assert.deepEqual(parseMaterialJson('```json\n{"summary":"保留 , } 原句", "facts":[],}\n```'),{summary:'保留 , } 原句',facts:[]});
});
test('冲突相关性不得强行补真值；非法分数和虚构引用仍交给严格校验',()=>{
 const raw:any=structuredClone(MATERIAL_OUTPUT_TEMPLATE);raw.shared.aiCentral=false;raw.shared.filmRelevant=false;
 const normalized:any=normalizeMaterialOutput(raw);assert.equal(normalized.shared.editorialScope,'uncertain');assert.equal(normalized.shared.aiCentral,false);
 raw.dimensions.audience=120;assert.equal(assessment.safeParse(normalizeMaterialOutput(raw)).success,false);
});
