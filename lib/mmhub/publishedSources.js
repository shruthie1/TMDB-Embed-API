'use strict';
// Bounded GET/POST to public https hosts only: DNS checked and pinned, redirects returned as data.
const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');
const fetch = require('node-fetch');
const UA = 'Mozilla/5.0';
function publicBase(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port && u.port !== '443' || u.search || u.hash) return null;
    if (u.pathname !== '/' || net.isIP(u.hostname.replace(/^\[|\]$/g, '')) || !u.hostname.includes('.') || /\.(?:localhost|local|internal)$/i.test(u.hostname)) return null;
    return u.origin;
  } catch { return null; }
}
function publicAddress(ip) {
  if (net.isIP(ip) === 4) {
    const [a,b,c] = ip.split('.').map(Number);
    return !(a===0 || a===10 || a===127 || a>=224 || a===169&&b===254 || a===172&&b>=16&&b<=31 || a===192&&b===168 || a===100&&b>=64&&b<=127 || a===192&&b===0 || a===198&&(b===18||b===19) || a===198&&b===51&&c===100 || a===203&&b===0&&c===113);
  }
  if (net.isIP(ip) !== 6) return false;
  const first = parseInt(ip.split(':')[0],16);
  return (first & 0xe000)===0x2000 && !/^2001:(?:db8|0):|^2002:/i.test(ip);
}
/** DNS is validated and pinned for this request; redirects are returned as data. */
async function fetchPublic(url, { signal, maxBytes=1024*1024, headers={}, method='GET', body }={}) {
  const u = new URL(url);
  if (!publicBase(u.origin) || u.username || u.password) throw new Error('Untrusted discovery URL');
  const addresses = await dns.lookup(u.hostname,{all:true});
  if (!addresses.length || addresses.some(a=>!publicAddress(a.address))) throw new Error('Non-public discovery address');
  const agent = new https.Agent({keepAlive:false,lookup: (_host,options,cb)=> options.all ? cb(null,addresses) : cb(null,addresses[0].address,addresses[0].family)});
  try {
    const res=await fetch(u.href,{agent,redirect:'manual',method,body,headers:{'User-Agent':UA,Accept:'application/json,text/html,text/plain',...headers},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000),size:maxBytes});
    return {status:res.status,text:await res.text(),location:res.headers.get('location'),retryAfter:res.headers.get('retry-after')};
  } finally { agent.destroy(); }
}
module.exports={publicBase,publicAddress,fetchPublic};
