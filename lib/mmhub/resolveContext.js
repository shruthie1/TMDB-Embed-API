'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');
const scope=new AsyncLocalStorage();
const inflight=new Map();
function run(name,ctx,fn){
 const parent=scope.getStore();
 const stack=parent?.stack||[];
 if(stack.includes(name))return Promise.reject(new Error('MultiMovies mirror cycle'));
 return scope.run({ctx,stack:[...stack,name],resolve:ctx.resolveService||parent?.resolve},fn);
}
async function resolve(name,ctx){
 const active=scope.getStore();
 if(active?.stack.includes(name))throw new Error('MultiMovies mirror cycle');
 if(active?.resolve)return active.resolve(name);
 const key=JSON.stringify([name,ctx.tmdbId,ctx.type,ctx.season||0,ctx.episode||0]);
 if(inflight.has(key))return inflight.get(key);
 const promise=Promise.resolve().then(()=>{
  const p=require('../../providers/registry').getProvider(name);
  if(!p?.enabled)return [];
  return run(name,ctx,()=>p.fetch(ctx));
 }).finally(()=>{if(inflight.get(key)===promise)inflight.delete(key);});
 inflight.set(key,promise);return promise;
}
module.exports={run,resolve};
