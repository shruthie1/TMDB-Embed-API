'use strict';
const {resolveLinked}=require('../lib/mmhub/linkedResolver');
const page=require('../lib/mmhub/page');
const _deps={read:page.read,resolveLinked};
async function getCineverseStreams(tmdbId,mediaType='movie',season=null,episode=null){
 if(mediaType!=='movie'&&!(season&&episode))return Object.assign([],{notListed:true});
 const signal=AbortSignal.timeout(16000);
 const ctx={tmdbId:String(tmdbId),type:mediaType==='movie'?'movie':'tv',season,episode};
 const catalog=await _deps.read(ctx,{signal});
 if(!catalog)throw new Error('Cineverse: catalog lookup unavailable');
 const server=catalog.servers.find(s=>/^cineverse$/i.test(s.name));
 if(!server)return Object.assign([],{notListed:true});
 return _deps.resolveLinked(server.url,ctx,{provider:'cineverse',display:'Cineverse',signal});
}
module.exports={getCineverseStreams,_deps,CANARY_TITLE:{tmdbId:'579974',mediaType:'movie'}};
