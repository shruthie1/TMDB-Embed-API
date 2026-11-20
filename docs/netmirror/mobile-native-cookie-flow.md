# Does the phone APK import cookies from an external browser?

Static result: no such import or token handoff was found in this APK. Its inspected app code opens a server-provided page in an Android WebView. The obtained website forwards the same server-issued challenge to an external verification link, while the original WebView polls the server. That provides a way for an external browser action to affect the app without copying any browser cookies.

This is static evidence combined with the earlier HTTP trace, not a successful on-device verification capture.

## App-specific JavaScript wiring

- App function #5439 is /tmp/netmirror-analysis/netmirror-decompiled.js:208743 onward.
- Bootstrap function #5444 at :208940–209065 requests /check.php and Base64-decodes token_hash into its WebView URL.
- WebView instance at :210524–210612 passes source.uri, X-Requested-With, JavaScript/DOM storage enabled, user agent, onMessage, load-start/load-end/error callbacks, and a ref.
- No app onOpenWindow, onShouldStartLoadWithRequest, sharedCookiesEnabled, cookie read/import, AppState change listener, Linking URL listener, or resume/reload callback is wired at that instance or the app module inspected.
- Function #5501 (:210534 onward; disassembly /tmp/netmirror-analysis/netmirror.hasm:223600 onward) handles WebView messages. It logs/stores data and handles downloadStart=, not a login-cookie payload.
- App's only Linking.openURL call is function #5456 (/tmp/netmirror-analysis/netmirror.hasm:222549–222565; JS:209327–209339), opening response.data.dlUrl after a download request. This is not the ad-authentication flow.
- Function #5505 (:210304–210330) injects pressfromAPP() on hardware back. It does not read cookies or import browser state.
- App event listeners are Dimensions change, NetInfo connectivity, and hardwareBackPress. AppState appears only in framework exports/implementation elsewhere in the bundle.

## Native app-specific code

Decompiled read-only with apktool into /tmp/netmirror-mobile-research/apk-smali.

- app/netmirror/nmv2/MainActivity.smali:21 onCreate configures orientation, insets, navigation/status bars.
- :155 onWindowFocusChanged reapplies immersive UI flags only. No cookie work.
- Its remaining methods create the RN delegate and return netmirror_beta. No app-specific onResume/onNewIntent cookie callback.
- MainApplication uses the normal React Native host and loader; no browser-cookie import.
- Decoded manifest: /tmp/netmirror-mobile-research/manifest-tree.txt:39–51. MainActivity has only MAIN/LAUNCHER intent filter. No VIEW/BROWSABLE custom URL-scheme/App Link callback was declared. Receiver filters elsewhere are Android profile-installer operations.

## Framework code is not an app browser-cookie bridge

- React Native WebView wrapper function #7086 defaults thirdPartyCookiesEnabled=true (:256059), setSupportMultipleWindows=true (:256111), and sets hasOnOpenWindowEvent based on whether an app prop exists (:256722). The actual app supplies no onOpenWindow prop.
- Generic native popup implementation com/reactnativecommunity/webview/c.smali:771 onCreateWindow creates an Android WebView. If an onOpenWindow handler exists, c$a.shouldOverrideUrlLoading emits targetUrl. This is framework popup routing; it does not copy cookies from Chrome.
- Generic navigation functions #7129/#7130 (hasm:277380–277453) use Linking.canOpenURL/openURL for URLs outside WebView's origin whitelist. Those are framework paths, not a custom token callback.
- com/reactnativecommunity/webview/i.smali:341–378 onPageFinished reads Android WebView CookieManager for the just-finished URL and flushes it to persistent storage. It does not receive cookies from a separate browser.
- com/facebook/react/modules/network/d.smali:300–342 get() and :422 put() use Android WebView CookieManager for React Native HTTP requests. This shares cookies within the app's WebView/native-networking environment; it does not read another app's Chrome database.
- com/reactnativecommunity/webview/m.smali:443 copies that same app CookieManager cookie into a DownloadManager request's Cookie header. Download handling, not external authentication.
- WebView module o.smali:2028 onNewIntent is a no-op.

## How an external browser can still unlock the app

The observed website flow is:

WebView retains addhash cookie + body challenge
→ opens external URL carrying that challenge
→ first-party verifier records server state for the challenge
→ WebView polls verify2.php with that same challenge
→ when server reports All Done, page reloads in its own WebView session.

Our HTTP measurement proved the first-party entry changed c=n to c=y without setting any cookies. This is consistent with server-side correlation via the hash, not browser-cookie transfer. However c=y still reported Waiting for your ads click after 25 seconds, and reloading remained gated. The full completion mechanism and any later verified cookie were not captured.

Conclusion for Chitram: do not implement Chrome-cookie extraction. A mobile session adapter would need the existing WebView session plus the service's actual verification completion contract. It cannot assume a close-browser event creates a TV-style usertoken.
