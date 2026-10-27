export function cutoffPreparationDue(endsAt:string,now:string){const left=Date.parse(endsAt)-Date.parse(now);return left>0&&left<=2*3600000;}
export function usableForTopic(row:{state?:string;material:{body:string;bodyState:string};analysis:{gates?:{evidence?:boolean};shared?:{scope?:string}}|null}){
 return row.state==='completed'&&!!row.analysis&&row.analysis.gates?.evidence===true&&row.analysis.shared?.scope!=='unrelated'
  &&['ok','collected','transcribed'].includes(row.material.bodyState)&&!!row.material.body.trim();
}
