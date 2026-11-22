package com.chitram.app.player

import com.chitram.app.data.Ranking
import com.chitram.app.data.Source
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * P23 (1.2.51): casting a MultiMovies `/dash/` row. The phone plays the signed
 * sacdn index.mpd and signs each segment itself (StreamInterceptor). A cast
 * receiver fetches segments with no query and gets 403, so the cast is HLS
 * whose segment lines are absolute signed sacdn URLs:
 *
 * 1. The VM route `/mm/hls/<id>/master.m3u8?s=<b64url MPD url>` (server
 *    lib/media/mmDash.js). It keeps no state, so the phone builds the URL.
 * 2. VM paused or its master not 200: the phone's LAN proxy serves the same
 *    playlists, built here from the MPD ([pages]).
 *
 * Either way the receiver fetches video straight from sacdn.
 */
object DashCast {
    private const val SACDN = "sacdn.hakunaymatata.com"
    private val SIGNED = listOf("Policy", "Signature", "Key-Pair-Id")
    const val PROBE_TIMEOUT_MS = 5_000L

    /** A signed sacdn `/dash/<folder>/index.mpd` URL, split up. */
    data class Signed(val id: String, val folder: String, val query: String)

    sealed interface Route {
        data class Vm(val url: String) : Route
        data object Lan : Route
    }

    fun parse(url: String): Signed? {
        val u = url.toHttpUrlOrNull() ?: return null
        if (!u.isHttps || u.host != SACDN) return null
        val m = Regex("""^/dash/([^/]+)/index\.mpd$""").find(u.encodedPath) ?: return null
        val enc = u.encodedQuery.orEmpty().split('&').associate { it.substringBefore('=') to it.substringAfter('=', "") }
        if (SIGNED.any { enc[it].isNullOrEmpty() }) return null
        val f = m.groupValues[1]
        val id = Regex("""^(\d{10,})_""").find(f)?.groupValues?.get(1) ?: f.filter { it.isLetterOrDigit() || it == '_' || it == '-' }.take(64)
        return Signed(id, "https://$SACDN/dash/$f/", SIGNED.joinToString("&") { "$it=${enc[it]}" })
    }

    /** The one known audio language of the row ("Telugu"), or null (the MPD lang stands). */
    fun rowLanguage(s: Source): String? =
        (s.audioLanguages ?: s.languages).mapNotNull { Ranking.languageLabel(it) }.distinctBy { it.lowercase() }.singleOrNull()

    /** The VM master for this signed MPD. `token`: the cast-watch token, or null (the probe). */
    fun vmMasterUrl(vmBase: String, mpdUrl: String, lang: String?, token: String?): String? {
        val sig = parse(mpdUrl) ?: return null
        val s = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(mpdUrl.toByteArray(Charsets.UTF_8))
        val q = buildList {
            add("s=$s")
            lang?.let { add("l=" + java.net.URLEncoder.encode(it, "UTF-8")) }
            token?.let { add("c=$it") }
        }.joinToString("&")
        return "${vmBase.trimEnd('/')}/mm/hls/${sig.id}/master.m3u8?$q"
    }

    /**
     * Where to cast [s] from: the VM route when the VM is up and its master
     * answers ([probe], without the token so the probe is not taken for the
     * receiver), else the LAN pages. Null: not a signed sacdn DASH row.
     */
    suspend fun route(s: Source, vmBase: String, vmUp: Boolean, token: String, probe: suspend (String) -> Boolean): Route? {
        if (!s.dash || parse(s.url) == null) return null
        if (!vmUp) return Route.Lan
        val lang = rowLanguage(s)
        val plain = vmMasterUrl(vmBase, s.url, lang, null) ?: return Route.Lan
        val ok = try { probe(plain) } catch (e: Exception) { false }
        return if (ok) Route.Vm(vmMasterUrl(vmBase, s.url, lang, token)!!) else Route.Lan
    }

    /**
     * The LAN pages for one MPD: "master.m3u8" and "<repId>.m3u8". `pageUrl`
     * gives the phone URL of a page name. Media playlists are built on first ask.
     */
    fun pages(p: MpdHls.Parsed, signed: Signed, codecs: Map<String, String>, language: MpdHls.Language?, pageUrl: (String) -> String): (String) -> MpdHls.Page? {
        val byName = p.reps.associateBy { "${it.id}.m3u8" }
        val built = java.util.concurrent.ConcurrentHashMap<String, MpdHls.Page>()
        return { name ->
            built[name] ?: when (name) {
                "master.m3u8" -> MpdHls.Page(MpdHls.masterPlaylist(p, { pageUrl("${it.id}.m3u8") }, codecs, language), master = true)
                else -> byName[name]?.let { MpdHls.Page(MpdHls.mediaPlaylist(it, signed.folder, signed.query), video = it.kind == "video") }
            }?.also { built[name] = it }
        }
    }
}
