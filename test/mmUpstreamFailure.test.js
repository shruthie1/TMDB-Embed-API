'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {quotaError,retryAfterSeconds}=require('../lib/mmhub/upstreamFailure');
test('Retry-After handles seconds, HTTP dates and malformed/missing values',()=>{
 const now=Date.UTC(2026,10,24);
 assert.equal(retryAfterSeconds('7200',now),7200);
 assert.equal(retryAfterSeconds(new Date(now+7200_000).toUTCString(),now),7200);
 for(const v of [undefined,'','invalid','-1',new Date(now-1000).toUTCString()])assert.equal(retryAfterSeconds(v,now),null);
 assert.equal(quotaError({status:429,text:'',retryAfter:'bad'}).retryAfter,900);
 assert.equal(quotaError({status:503,text:'Error 1027'}).retryAfter,3600);
});
test('response classification separates quota, rate limits, challenges and transport failures',()=>{
 const quota=quotaError({status:503,text:'Error 1027: The owner has reached their plan limits.'},'Nexus');
 assert.equal(quota.rule,'quota');assert.equal(quota.status,429);assert.equal(quota.upstreamStatus,503);
 assert.equal(quotaError({status:429,text:''}).rule,'throttle');
 for(const response of [{status:200,text:'#EXTM3U\n'}, {status:403,text:'Just a moment'}, {status:503,text:'Service unavailable'}])assert.equal(quotaError(response),null);
});
test('a 2xx page body mentioning throttle or quota is not an upstream failure',()=>{
 for(const text of ['<script>function throttle(fn){}</script>','<p>storage quota daily limit</p>'])assert.equal(quotaError({status:200,text}),null);
});
