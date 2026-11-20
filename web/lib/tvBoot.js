/**
 * Sets html[data-tv="true"] before the first paint.
 *
 * Dpad sets the same flag, but in a useEffect, so only after hydration. Until
 * then every TV rule in nav.css is off: the first paint is the desktop layout
 * (top bar links, no left rail, content at the screen edge) and everything
 * jumps right by --rail-w when the flag lands. Measured on a VIDAA UA at
 * 1920x1080 with slow JS: content at x=20 before hydration, x=108 after. On a
 * real TV the JS takes seconds, so the loading skeleton was the frame that
 * showed without the rail.
 *
 * This runs inline in <head>, so the very first frame already has the rail.
 * It mirrors isTv() (lib/dpad.js readOverride + isTvDevice in
 * lib/player/hlsConfig.js) but only READS the override: isTv() still owns
 * writing and expiring it. test/tvBoot.test.js keeps the two in step.
 */
export const TV_BOOT_SCRIPT = `(function(){try{
var tv=null,q=new URLSearchParams(location.search).get('tv');
if(q==='1'||q==='0')tv=q==='1';
else{try{var raw=localStorage.getItem('chitram.tv');
if(raw==='1'||raw==='0')tv=raw==='1';
else if(raw){var o=JSON.parse(raw);if(isFinite(o.until)&&o.until>Date.now())tv=o.v==='1';}
}catch(e){}}
if(tv===null){var ua=navigator.userAgent||'';
tv=/\\b(smart-?tv|smarttv|googletv|android\\s*tv|appletv|hbbtv|netcast|viera|aquos|bravia|webos|web0s|tizen|crkey|chromecast|firetv|aft[a-z]|silk|dtv|philipstv|opera\\s*tv|large\\s*screen|vidaa|hisense)\\b|\\bodin\\//i.test(ua)
||(typeof navigator.deviceMemory==='number'&&navigator.deviceMemory<=2);}
if(tv)document.documentElement.setAttribute('data-tv','true');
}catch(e){}})();`;
