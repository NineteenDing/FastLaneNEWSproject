import {groundBodyQuoteTypography} from './material-quote-grounding.ts';
export function groundDraftQuotes(value:unknown,bodies:Map<string,string>):unknown{
 if(!value||typeof value!=='object'||!Array.isArray((value as any).recommendation?.directions))return value;
 const root=value as any;return{...root,recommendation:{...root.recommendation,directions:root.recommendation.directions.map((direction:any)=>({...direction,
  references:Array.isArray(direction.references)?direction.references.map((ref:any)=>{const body=bodies.get(ref?.materialId);return body&&typeof ref?.quote==='string'?{...ref,quote:groundBodyQuoteTypography({quote:ref.quote},body).quote}:ref;}):direction.references
 }))}};
}
/** Optional support citations may be absent; they must never turn an unsupported claim into a verified fact. */
export function groundResolutionQuotes(value:unknown,bodies:Map<string,string>):unknown{
 if(!value||typeof value!=='object'||!Array.isArray((value as any).resolutions))return value;
 return {...value,resolutions:(value as any).resolutions.map((row:any)=>{
  if(!Array.isArray(row?.quotes))return row;
  let missing=0;const quotes=row.quotes.flatMap((item:any)=>{
   if(typeof item?.materialId!=='string'||typeof item?.quote!=='string'||!item.quote.trim()){missing++;return[];}
   const body=bodies.get(item.materialId),quote=body?groundBodyQuoteTypography({quote:item.quote},body).quote:item.quote;
   if(!body?.includes(quote)){missing++;return[];}return[{...item,quote}];
  });
  return missing?{...row,quotes,decision:'partial',reason:String(row.reason??'').slice(0,1000)+'；部分引句未核验，已剔除，不可据此认定事实已证实'}:{...row,quotes};
 })};
}
