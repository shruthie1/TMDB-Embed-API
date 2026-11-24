'use strict';
const {resolveLinked}=require('../lib/mmhub/linkedResolver');
const page=require('../lib/mmhub/page');
const _deps={read:page.read,resolveLinked,imdbOf:(type,id)=>require('../utils/tmdb').resolveImdbId(type,id)};
async function getGdMirrorStreams(tmdbId,mediaType='movie',season=null,episode=null){
 if(mediaType!=='movie'&&!(season&&episode))return Object.assign([],{notListed:true});
 const signal=AbortSignal.timeout(16000);
 const ctx={tmdbId:String(tmdbId),type:mediaType==='movie'?'movie':'tv',season,episode};
 const catalog=await _deps.read(ctx,{signal});
 if(!catalog)throw new Error('GD mirror: catalog lookup unavailable');
 const server=catalog.servers.find(s=>/^gd mirror$/i.test(s.name));
 if(!server)return Object.assign([],{notListed:true});
 ctx.imdbId=await _deps.imdbOf(ctx.type,ctx.tmdbId);
 return _deps.resolveLinked(server.url,ctx,{provider:'gdmirror',display:'GD mirror',signal});
}
module.exports={getGdMirrorStreams,_deps,CANARY_TITLE:{tmdbId:'579974',mediaType:'movie'}};
