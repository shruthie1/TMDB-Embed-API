# Why vercel.json looks like this

Vercel rejects a `"//"` key in vercel.json ("should NOT have additional
property"), so the reasoning lives here instead.

- Everything is one Express app (apiServer.js) behind api/index.js.
- public/ is served BY Express, not by Vercel's static layer: apiServer.js
- sets etag:false + Cache-Control:no-store there on purpose, and Vercel's
- own static serving would send its own cached/ETagged copy instead. So
- outputDirectory points at an empty dir to keep Vercel out of the way and
- let the catch-all rewrite hand every path to Express.
- maxDuration: a cold /api/streams fan-out measured 4.8-6.9s locally, and
- NetMirror alone 5.4-7.8s cold because it probes netflix -> primevideo ->
- hotstar SEQUENTIALLY with a 15s abort each. The default 10s (Hobby) limit
- killed that mid-flight and returned a 504 with zero streams, which looked
- like 'NetMirror is broken on Vercel'. 60s covers the sequential worst case.
- Note NetMirror's in-process 25-min streamCache mostly MISSES on serverless
- (new instance per invocation), so the cold path is the normal path there.
