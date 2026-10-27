import {parseHTML} from 'linkedom';
/** Read only publisher-declared article payloads. Never evaluate script or pick arbitrary related-story text. */
export function declaredArticleHtml(html:string,url:string):string|null{
 const {document}=parseHTML(html),host=new URL(url).hostname;
 const title=document.querySelector('meta[property="og:title"]')?.getAttribute('content')??document.querySelector('h1')?.textContent??document.title;
 const canonical=(value:unknown)=>{try{const parsed=new URL(String(value),url);parsed.hash='';return parsed.href.replace(/\/$/,'');}catch{return null;}};
 const expected=canonical(document.querySelector('link[rel="canonical"]')?.getAttribute('href')??url);
 for(const script of document.querySelectorAll('script[type="application/ld+json"]'))try{
  const raw=JSON.parse(script.textContent??'null'),entries=Array.isArray(raw)?raw:Array.isArray(raw?.['@graph'])?raw['@graph']:[raw];
  for(const entry of entries){const types=Array.isArray(entry?.['@type'])?entry['@type']:[entry?.['@type']];
   if(!types.some((t:unknown)=>['NewsArticle','Article','BlogPosting'].includes(String(t)))||typeof entry.articleBody!=='string')continue;
   const identities=[entry.url,entry['@id'],typeof entry.mainEntityOfPage==='string'?entry.mainEntityOfPage:entry.mainEntityOfPage?.['@id']].filter(Boolean);
   const matchesTitle=typeof entry.headline==='string'&&!!title&&(title.includes(entry.headline)||entry.headline.includes(title));
   if(identities.length ? !identities.some(value=>canonical(value)===expected) : !matchesTitle)continue;
   if(entry.headline&&title&&!matchesTitle)continue;
   return '<article><p>'+entry.articleBody.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'</p><p>')+'</p></article>';
  }
 }catch{}
 if(/(^|\.)ifeng\.com$/.test(host))for(const script of document.querySelectorAll('script')){
  const text=script.textContent??'',match=/\bvar\s+allData\s*=\s*/.exec(text);if(!match)continue;
  try{const start=match.index+match[0].length;let end=start,depth=0,quote=false,escape=false;
   for(;end<text.length;end++){const c=text[end];if(quote){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quote=false;}else if(c==='"')quote=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){end++;break;}}
   const data=JSON.parse(text.slice(start,end)),parts=data.docData?.contentData?.contentList;
   if(Array.isArray(parts))return parts.filter(p=>p.type==='text'&&typeof p.data==='string').map(p=>p.data).join('\n');
  }catch{}
 }
 const article=document.querySelector('article .entry-content, article [itemprop="articleBody"], main article .post-content');
 return article?.innerHTML??null;
}
