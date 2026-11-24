'use strict';
// Data-only parsers for published embed pages. No eval, Function or remote script execution.
const cheerio=require('cheerio');
const LIMIT=1024*1024, ALPHABET='0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
function stringAt(text,at){
  const quote=text[at];if(quote!=="'"&&quote!=='"')return null;
  let value='';
  for(let i=at+1;i<text.length&&value.length<=LIMIT;i++){
    const c=text[i];if(c===quote)return {value,end:i+1};
    if(c!=='\\'){value+=c;continue;}
    const e=text[++i];if(e===undefined)return null;
    if(e==='u'||e==='x'){const n=e==='u'?4:2,h=text.slice(i+1,i+1+n);if(!new RegExp(`^[a-f0-9]{${n}}$`,'i').test(h))return null;value+=String.fromCharCode(parseInt(h,16));i+=n;}
    else value+=({n:'\n',r:'\r',t:'\t',b:'\b',f:'\f'}[e]??e);
  }
  return null;
}
function token(n,radix){let out='';do{out=ALPHABET[n%radix]+out;n=Math.floor(n/radix);}while(n);return out;}
function unpack(text){
  text=String(text||'');if(text.length>LIMIT)throw new Error('Packed source too large');
  const chunks=[];
  for(const match of text.matchAll(/\}\s*\(\s*(?=['"])/g)){
    if(chunks.length>=8)break;
    let pos=match.index+match[0].length;
    const payload=stringAt(text,pos);if(!payload)continue;pos=payload.end;
    const numbers=/^\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*/.exec(text.slice(pos));if(!numbers)continue;
    const radix=Number(numbers[1]),count=Number(numbers[2]);if(radix<2||radix>62||count>5000)throw new Error('Packed dictionary bounds');
    pos+=numbers[0].length;const words=stringAt(text,pos);if(!words)continue;pos=words.end;
    if(!/^\s*\.split\(\s*['"]\|['"]\s*\)\s*(?:,\s*0\s*,\s*\{\s*\}\s*)?\)/.test(text.slice(pos)))continue;
    const dictionary=words.value.split('|');if(dictionary.length>5000)throw new Error('Packed dictionary too large');
    const mapping=new Map();for(let i=0;i<count;i++)if(dictionary[i])mapping.set(token(i,radix),dictionary[i]);
    let length=payload.value.length;
    chunks.push(payload.value.replace(/\b[0-9A-Za-z]+\b/g,word=>{const value=mapping.get(word)||word;length+=value.length-word.length;if(length>LIMIT)throw new Error('Packed expansion too large');return value;}));
  }
  return chunks.join('\n');
}
function deescape(value){return String(value||'').replace(/\\+u([a-f0-9]{4})/gi,(_,n)=>String.fromCharCode(parseInt(n,16))).replace(/\\+\//g,'/').replace(/&amp;/g,'&');}
function mediaLinks(text,base){
  const source=deescape(text), links=[];
  for(const m of source.matchAll(/(?:https?:\/\/|\/)[^\s"'<>\\]+?(?:\.m3u8|\/master\.txt)(?:\?[^\s"'<>\\]*)?/gi)){
    try{const u=new URL(m[0],base);if(/^https?:$/.test(u.protocol))links.push(u.href);}catch{}
  }
  return [...new Set(links)].sort((a,b)=>{const rank=u=>/\/hls4\//.test(u)?0:/\/hls3\//.test(u)?1:/\/hls2\//.test(u)?2:3;return rank(a)-rank(b);});
}
function embedLinks(text,base){
  const $=cheerio.load(String(text||'')),out=[];
  $('[src],[data-src],[data-link],[data-url],[href]').each((_i,el)=>{
    for(const field of ['src','data-src','data-link','data-url','href']){
      const raw=$(el).attr(field);if(!raw||raw==='#'||/^(?:javascript|data):/i.test(raw))continue;
      try{const url=new URL(raw,base);if(!/^https?:$/.test(url.protocol))continue;url.hash='';out.push({url:url.href,label:$(el).text().trim().slice(0,100),platform:$(el).attr('data-platform')||null,kind:['iframe','video','source'].includes(el.name)||field.startsWith('data-')?'embed':'link'});}catch{}
    }
  });
  return [...new Map(out.map(x=>[x.url,x])).values()];
}
function serverItems(text,base){
  const $=cheerio.load(String(text||'')),out=[];
  $('.srv-item[data-url]').each((_i,el)=>{const e=$(el);try{out.push({url:new URL(e.attr('data-url'),base).href,label:e.text().trim(),platform:e.attr('data-platform')||null});}catch{}});
  for(const m of String(text||'').matchAll(/switchServer\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g)){
    const url=new URL('/proxy.php',base);url.searchParams.set('p',m[1]);url.searchParams.set('c',m[2]);url.searchParams.set('noredirect','1');out.push({url:url.href,platform:m[1],label:m[1]});
  }
  return [...new Map(out.map(x=>[x.url,x])).values()].slice(0,8);
}
module.exports={stringAt,unpack,deescape,mediaLinks,embedLinks,serverItems};
