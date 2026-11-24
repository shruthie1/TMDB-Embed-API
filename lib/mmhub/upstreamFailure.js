'use strict';
const {explain}=require('../selfheal/classify');

// Preserve cooldown instructions as seconds, including HTTP-date headers.
function retryAfterSeconds(value, now=Date.now()) {
 if(value==null||String(value).trim()==='')return null;
 const text=String(value).trim();
 const seconds=/^\d+$/.test(text)?Number(text):Math.ceil((Date.parse(text)-now)/1000);
 return Number.isSafeInteger(seconds)&&seconds>0?seconds:null;
}

function quotaError(response,label='MultiMovies',now=Date.now()) {
 const result=explain({status:response.status,body:response.text});
 if(result.rule!=='quota'&&result.rule!=='throttle')return null;
 const retryAfter=retryAfterSeconds(response.retryAfter,now)||(result.rule==='quota'?3600:900);
 return Object.assign(new Error(`${label} upstream ${result.rule==='quota'?'quota reached':'rate limited'}`),
  {status:429,upstreamStatus:response.status,retryAfter,retryable:true,...result});
}
module.exports={quotaError,retryAfterSeconds};
