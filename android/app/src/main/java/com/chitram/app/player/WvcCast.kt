package com.chitram.app.player

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import com.chitram.app.data.Api
import com.chitram.app.data.Source

/**
 * Cast to TV through Web Video Caster (WVC). The owner's Hisense VIDAA TV runs
 * the WVC receiver, so the phone hands WVC the stream that is playing now.
 *
 * Intent contract from https://www.webvideocaster.com/integrations (Android
 * Intents): ACTION_VIEW with data + type, package com.instantbits.cast.webvideo,
 * String extras "title" and "poster", headers as a Bundle under
 * "android.media.intent.extra.HTTP_HEADERS". WVC documents no start-position
 * extra, so none is sent.
 *
 * Backend rows are already proxied by the VM and need no headers. On-device rows
 * (mapple, vaplayer) need Referer/Origin/User-Agent; a TV browser cannot send
 * Referer, so they work only when WVC routes the video through the phone.
 */
object WvcCast {
    const val PACKAGE = "com.instantbits.cast.webvideo"
    const val EXTRA_HEADERS = "android.media.intent.extra.HTTP_HEADERS"
    const val ROUTE_HINT = "Turn on 'Route through phone' in Web Video Caster if it fails"
    private const val STORE_MARKET = "market://details?id=$PACKAGE"
    private const val STORE_WEB = "https://play.google.com/store/apps/details?id=$PACKAGE"
    const val HLS_MIME = "application/x-mpegurl"
    /** WVC 6.2.0 matches no activity for this type (nor for mixed-case x-mpegURL). Never sent. */
    const val DASH_MIME = "application/dash+xml"
    private val NEEDED = listOf("Referer", "Origin", "User-Agent")

    data class Spec(
        val url: String,
        val mime: String,
        val title: String,
        val poster: String?,
        val headers: Map<String, String>,
        /** One line to show on the phone, or null. */
        val hint: String?,
    )

    sealed interface Launch {
        data class Wvc(val spec: Spec) : Launch
        data class Store(val uri: String) : Launch
    }

    /**
     * `lanUrl` (C5): the phone's LAN proxy URL for an on-device row. The phone
     * then adds the headers and vaplayer's token itself, so the TV needs neither
     * the headers nor WVC's phone routing.
     *
     * `castUrl` (P23): an HLS master built for a MultiMovies DASH row (the VM
     * route or the phone's LAN pages). Its segment lines are signed sacdn URLs,
     * so the receiver needs no headers.
     */
    fun spec(row: Source, r: PlayRequest, lanUrl: String? = null, castUrl: String? = null): Spec {
        val title = if (r.type == "tv" && r.season > 0) "${r.title} S${r.season} E${r.episode}" else r.title
        if (castUrl != null) return Spec(castUrl, HLS_MIME, title, Api.image(r.poster, "w500"), emptyMap(), null)
        // WVC 6.2.0 has no activity for application/dash+xml (measured on the owner's phone,
        // 2026-11-22): a DASH row always casts the VM HLS route, with the HLS type.
        if (row.dash) DashCast.vmMasterUrl(Api.VM, row.url, DashCast.rowLanguage(row), null)?.let {
            return Spec(it, HLS_MIME, title, Api.image(r.poster, "w500"), emptyMap(), null)
        }
        // A TV gets no provider headers from WVC: cast a direct row's proxied url.
        val s = DirectRoute.proxyOf(row)
        val viaPhone = lanUrl != null && s.onDevice != null
        val headers = if (s.onDevice == null || viaPhone) emptyMap()
        else NEEDED.mapNotNull { k -> s.headers.entries.firstOrNull { it.key.equals(k, ignoreCase = true) }?.let { k to it.value } }.toMap()
        return Spec(
            url = if (viaPhone) lanUrl!! else s.url,
            // Lowercase: Android matches intent MIME types case-sensitively, and
            // WVC registers application/x-mpegurl. "x-mpegURL" found no activity
            // and fell through to the Play Store (owner report, 1.2.0).
            mime = if (s.progressive) "video/mp4" else HLS_MIME,
            title = title,
            poster = Api.image(r.poster, "w500"),
            headers = headers,
            hint = if (s.onDevice != null && !viaPhone) ROUTE_HINT else null,
        )
    }

    /**
     * Tries WVC, then the Play Store app, then the Play Store website. `start`
     * throws ActivityNotFoundException when nothing handles a target.
     * Returns the target that opened.
     */
    fun launch(spec: Spec, start: (Launch) -> Unit): Launch? {
        for (t in listOf(Launch.Wvc(spec), Launch.Store(STORE_MARKET), Launch.Store(STORE_WEB))) {
            try {
                start(t); return t
            } catch (e: ActivityNotFoundException) {
                android.util.Log.w("Chitram", "[cast] no activity for ${if (t is Launch.Wvc) "WVC ${t.spec.mime}" else "store"}: ${e.message}")
            }
        }
        return null
    }

    fun intent(t: Launch): Intent = when (t) {
        is Launch.Wvc -> Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(Uri.parse(t.spec.url), t.spec.mime)
            setPackage(PACKAGE)
            putExtra("title", t.spec.title)
            t.spec.poster?.let { putExtra("poster", it) }
            if (t.spec.headers.isNotEmpty()) {
                putExtra(EXTRA_HEADERS, Bundle().apply { t.spec.headers.forEach { (k, v) -> putString(k, v) } })
            }
        }
        is Launch.Store -> Intent(Intent.ACTION_VIEW, Uri.parse(t.uri))
    }.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    fun open(ctx: Context, spec: Spec): Launch? = launch(spec) { ctx.startActivity(intent(it)) }
}
