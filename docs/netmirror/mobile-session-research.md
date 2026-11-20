# NetMirror mobile session trace

Observed local date: 2026-11-21, approximately 00:07–00:08 IST. Server and tool UTC timestamps are retained in evidence.json.

## Result

The inspected phone APK does not compute an ad-session hash or a TV usertoken. It Base64-decodes the configuration's token_hash into a starting URL and opens that URL in its WebView. The website creates an opaque addhash challenge and tracks verification on the server.

A fresh session remained blocked both immediately and after waiting 21.267 seconds without opening an ad. There is no demonstrated automatic, ad-free mobile playback session and no evidence that mobile cookies can produce the TV API's usertoken. Do not implement a fabricated hash generator or treat addhash as a playback credential.

## Measured sequence

1. GET https://mobiledetects.com/check.php returned 200 and token_hash decoding to https://net52.cc/mobile/home?app=1.
2. GET that URL using mobile UA ending /OS.Gatu v3.1 returned 200 and an ad-verification HTML page.
3. Server supplied an addhash cookie and body data-addhash. URL-decoding the cookie yields exactly the body challenge.
4. Challenge shape: 32 lowercase hex characters :: 32 lowercase hex characters :: 10-digit Unix timestamp :: 2-character marker. The third component equals body data-time.
5. Cookie: domain .net52.cc, path /, SameSite=Lax, HttpOnly=false, Secure=false, approximately five-minute expiry. These attributes describe the challenge cookie, not proof of an authorized session.
6. POST /mobile/verify2.php form verify=<server challenge> with that cookie returned HTTP 200, {"c":"n","statusup":"Waiting for your ads click."}; no Set-Cookie.
7. Reloading retained the same challenge and the same gate.
8. A separate fresh session waited 21.267 seconds without opening the support URL. One verifier POST still returned the same Waiting response. Thus wall-clock waiting alone is insufficient in this measured flow.

## Client producers and consumers

- Configuration producer: bootstrap server /check.php.
- Phone consumer: decoded bundle function #5444, /tmp/netmirror-analysis/netmirror-decompiled.js:208965–209065. It Base64-decodes token_hash, stape, and retains u.
- Browser producer: home response server produces Set-Cookie addhash and body data-addhash/data-time.
- Browser client consumer: inline checkadd reads body data-addhash and sends it unchanged as form verify to /mobile/verify2.php.
- Support-link consumer: the click handler puts the same hash into a first-party support URL (userver.net52.cc). It reads data-time but does not use it in the active URL.
- Completion consumer: when polling returns statusup === "All Done", the client reloads. That is the only active completion behavior in the obtained script.
- APK WebView bridge function #5501 accepts downloadStart= messages for a separate download flow. The observed bridge does not hash cookies or derive TV usertoken.
- Error/retry branch: AJAX errors show "Loading Failed, Internet ERROR, Wait Re-Checking"; a page-load timer polls every 2 seconds for seven repetitions. Clicking the gate also starts interval polling.
- No MD5/SHA/CryptoJS or equivalent hash construction was present in the returned inline gate code or the inspected APK application flow. 32 hex characters alone do not establish the algorithm, secret inputs, signature validity, or server implementation.

## Reliability implications for Chitram

Prefer the TV session adapter already being implemented: its explicit OTP response yields an actual usertoken with a clear content-request header contract.

A legitimate mobile fallback would need a user-completed verification session on the same device, proper cookie-jar/domain/expiry handling, and re-verification when upstream rejects or expires it. Keep it independent of TV authentication: mobile URL bootstrap token_hash, addhash challenge, browser session cookies, and TV usertoken are different states.

Not verified: advertiser/completion path, cookies set after successful verification, playback authorization response, IP/UA binding, eventual lifetime of a verified session, and any interoperability with TV APIs. No ads, completion claims, or third-party advertiser requests were generated.

## Artifacts

- evidence.json: redacted live summaries and timer test.
- gate-inline.js: website's returned inline scripts, no challenge/cookie values.
- mobile-session-probe.playwright.js: reproducible router Playwright function, HTTP only, fresh context, cookie values omitted. Discover browser_run_code with the local MCP router and supply this function as code. It does not execute gate scripts or open support/advertiser URLs.



## Follow-up: opening the first-party verification link (00:10–00:11 IST)

User clarified that opening a browser, waiting, and closing it works. The earlier wait-only test did not visit the first-party verification entry. This follow-up separates those steps.

- Fresh session verifier before navigation: c=n, statusup="Waiting for your ads click."
- GET the exact first-party support entry generated by the gate, with its own server-issued challenge: HTTP 301 to a third-party advertiser. Redirect following was disabled. Response body empty, no scripts, no Set-Cookie.
- Verifier immediately afterwards: c=y, statusup still "Waiting for your ads click."
- After 25 seconds without following the advertiser redirect: verifier remained c=y and the same Waiting message. Home reload remained ad-gated, no usertoken, only addhash cookie.

This proves the first-party entry records a server-side state transition. The initial browser page does not compute a hash or run a timer callback because it is an empty redirect response. It does not prove the full session is obtained by visiting that entry: the measured first-party visit + waiting was insufficient. The missing step may be in the advertiser redirect chain, a server callback, or another condition; this was not inspected or simulated.

No third-party advertiser URL was fetched and no guessed completion endpoint was called. Since the first-party landing sets no cookies, its observed c transition is not a fresh browser-cookie handoff. It is state correlated through the issued hash (and may also be IP/UA-bound; not established).

For implementation, keep mobile as an optional user-completed verification/session flow until an authorized successful browser trace identifies the true cookie/session completion contract. Do not infer that c=y means verified: in this measurement it still had the gate and Waiting status.
