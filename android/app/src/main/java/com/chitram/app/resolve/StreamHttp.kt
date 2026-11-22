package com.chitram.app.resolve

import com.chitram.app.data.Level
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response

/**
 * A stream resolved on this device. `headers` go on EVERY player request (master,
 * playlists, segments, keys): both providers 403/404 without their Referer and
 * Origin. `segmentToken` (vaplayer only) is appended as ?token= to every request
 * that lacks one: vaplayer segments carry no token and 403 without it.
 */
data class Resolved(
    val provider: String,
    val label: String,
    val url: String,
    val headers: Map<String, String>,
    val segmentToken: String?,
    val audio: List<AudioTrack>,
    val levels: List<Level>,
    val codecs: String?,
    /** Several languages in one TS file (CastleTV muxed): not selectable in the player, swapped by TsAudioSwap. */
    val muxed: Boolean = false,
    val key: String? = null,
    val subtitles: List<com.chitram.app.data.SubtitleRef> = emptyList(),
    val languages: List<String> = emptyList(),
    val catalogLanguages: List<String> = emptyList(),
    val netmirrorCatalog: String? = null,
    val incomplete: Boolean = false,
    /** [url] is a DASH MPD (MultiMovies sacdn `index.mpd`), played with media3 DASH, not HLS. */
    val dash: Boolean = false,
)

/**
 * Puts the provider's headers (and vaplayer's token) on every request. Done as an
 * OkHttp interceptor rather than a media3 ResolvingDataSource: the player uses
 * OkHttpDataSource on top of this client, so every HLS load passes through here,
 * the resolver's own probes use the same path, and it is testable on the JVM
 * (media3's DataSpec needs android.net.Uri).
 *
 * `signedFrom` (DASH rows, 1.2.50): the playing row's signed sacdn MPD url. Its
 * Policy/Signature/Key-Pair-Id go on every sacdn request that lacks them. One
 * interceptor per row, so a query never reaches another row. `audioLang`: the
 * row's language code, written into the MPD's audio `lang` when it disagrees.
 */
class StreamInterceptor(
    private val headers: Map<String, String>,
    private val token: String?,
    private val signedFrom: String? = null,
    private val audioLang: String? = null,
) : Interceptor {
    /** The playing row's signed MPD url, parsed once; null for every other row. */
    private val signer = signedFrom?.toHttpUrlOrNull()?.takeIf { it.host == SACDN && SIGNED.all { k -> it.queryParameter(k) != null } }

    override fun intercept(chain: Interceptor.Chain): Response {
        val req = chain.request()
        val b = req.newBuilder()
        for ((k, v) in headers) b.header(k, v)
        var url = req.url
        if (token != null) url = withToken(url, token)
        if (signer != null) url = withSignature(url, signer)
        b.url(url)
        val res = chain.proceed(b.build())
        if (audioLang == null || signer == null || !res.isSuccessful || !url.encodedPath.endsWith(".mpd")) return res
        val body = res.body ?: return res
        val type = body.contentType()
        val text = body.string()
        val fixed = mpdWithLang(text, audioLang)
        if (fixed != text) android.util.Log.i("Chitram", "[multimovies] dash-direct mpd audio lang ${mpdLangAttr(text) ?: "-"} -> $audioLang (row language)")
        return res.newBuilder().removeHeader("Content-Length").removeHeader("Content-Encoding").body(fixed.toResponseBody(type)).build()
    }

    companion object {
        /** Leaves a url that already has a token (the master) alone. */
        fun withToken(url: HttpUrl, token: String): HttpUrl =
            if (url.queryParameter("token") != null) url else url.newBuilder().addQueryParameter("token", token).build()

        private const val SACDN = "sacdn.hakunaymatata.com"
        private val SIGNED = listOf("Policy", "Signature", "Key-Pair-Id")
        private val AUDIO_SET = Regex("""<AdaptationSet\b[^>]*>""")
        private val AUDIO_KIND = Regex("""contentType="audio"|mimeType="audio/""")
        private val LANG_ATTR = Regex("""\slang="([^"]*)"""")

        /**
         * A sacdn request with no CloudFront signature gets the playing row's
         * (media3 resolves the MPD's relative segment names without its query;
         * unsigned, sacdn answers 403). Another host, or a request that already
         * has a signature, is left alone.
         */
        fun withSignature(url: HttpUrl, mpd: HttpUrl): HttpUrl {
            if (url.host != SACDN || SIGNED.all { url.queryParameter(it) != null }) return url
            val kept = url.newBuilder().apply { SIGNED.forEach { removeAllQueryParameters(it) } }.build()
            val add = SIGNED.joinToString("&") { k -> "$k=" + mpd.encodedQueryParameter(k).orEmpty() }
            return kept.newBuilder().encodedQuery(listOfNotNull(kept.encodedQuery?.takeIf { it.isNotEmpty() }, add).joinToString("&")).build()
        }

        private fun HttpUrl.encodedQueryParameter(name: String): String? =
            encodedQuery?.split('&')?.firstOrNull { it.substringBefore('=') == name }?.substringAfter('=', "")

        /** The row whose MPD signs its segments: a DASH row on sacdn, else null. */
        fun signedFrom(s: com.chitram.app.data.Source): String? = s.url.takeIf { s.dash }

        /**
         * The language code the row's audio carries (MultiMovies mpd-lang plan):
         * the one known language of a DASH row, else null (the MPD tag stands).
         */
        fun audioLangOf(s: com.chitram.app.data.Source): String? {
            if (!s.dash) return null
            val one = (s.audioLanguages ?: s.languages).distinctBy { it.lowercase() }.singleOrNull() ?: return null
            return com.chitram.app.data.Ranking.languageCode(one)
        }

        /** The one audio AdaptationSet `lang`, or null. */
        fun mpdLangAttr(text: String): String? = AUDIO_SET.findAll(text).map { it.value }.filter { AUDIO_KIND.containsMatchIn(it) }
            .mapNotNull { LANG_ATTR.find(it)?.groupValues?.get(1) }.firstOrNull()

        /**
         * The MPD with its audio AdaptationSet `lang` set to [lang] when it names
         * another language or none (the resolver's plan judged `eng`/`und` as no
         * evidence and kept the listed language). Same language: unchanged. Only a
         * single audio set is touched; the video set and every other tag stay.
         */
        fun mpdWithLang(text: String, lang: String): String {
            val sets = AUDIO_SET.findAll(text).filter { AUDIO_KIND.containsMatchIn(it.value) }.toList()
            val set = sets.singleOrNull() ?: return text
            val cur = LANG_ATTR.find(set.value)?.groupValues?.get(1)
            if (cur != null && com.chitram.app.data.Ranking.sameLanguage(com.chitram.app.data.Ranking.languageLabel(cur), com.chitram.app.data.Ranking.languageLabel(lang))) return text
            val tag = if (cur != null) set.value.replace(LANG_ATTR, " lang=\"$lang\"") else set.value.removeSuffix(">").removeSuffix("/") + " lang=\"$lang\"" + (if (set.value.endsWith("/>")) "/>" else ">")
            return text.replaceRange(set.range, tag)
        }

        fun client(base: OkHttpClient, headers: Map<String, String>, token: String?, signedFrom: String? = null): OkHttpClient =
            base.newBuilder().addInterceptor(StreamInterceptor(headers, token, signedFrom)).build()

        /** A row's own client: its headers, token and (DASH) signature. */
        fun forRow(base: OkHttpClient, s: com.chitram.app.data.Source): OkHttpClient = client(base, s.headers, s.segmentToken, signedFrom(s))

        /** The player's client for a row with its own headers; `connectMs` null keeps [base]'s (PlayPolicy.connectTimeoutMs). */
        fun playerClient(base: OkHttpClient, headers: Map<String, String>, token: String?, connectMs: Long?, signedFrom: String? = null, audioLang: String? = null): OkHttpClient =
            base.newBuilder().addInterceptor(StreamInterceptor(headers, token, signedFrom, audioLang))
                .apply { if (connectMs != null) connectTimeout(connectMs, java.util.concurrent.TimeUnit.MILLISECONDS) }.build()
    }
}
