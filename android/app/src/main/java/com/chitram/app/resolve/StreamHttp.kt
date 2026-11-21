package com.chitram.app.resolve

import com.chitram.app.data.Level
import okhttp3.HttpUrl
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
)

/**
 * Puts the provider's headers (and vaplayer's token) on every request. Done as an
 * OkHttp interceptor rather than a media3 ResolvingDataSource: the player uses
 * OkHttpDataSource on top of this client, so every HLS load passes through here,
 * the resolver's own probes use the same path, and it is testable on the JVM
 * (media3's DataSpec needs android.net.Uri).
 */
class StreamInterceptor(private val headers: Map<String, String>, private val token: String?) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val req = chain.request()
        val b = req.newBuilder()
        for ((k, v) in headers) b.header(k, v)
        if (token != null) b.url(withToken(req.url, token))
        return chain.proceed(b.build())
    }

    companion object {
        /** Leaves a url that already has a token (the master) alone. */
        fun withToken(url: HttpUrl, token: String): HttpUrl =
            if (url.queryParameter("token") != null) url else url.newBuilder().addQueryParameter("token", token).build()

        fun client(base: OkHttpClient, headers: Map<String, String>, token: String?): OkHttpClient =
            base.newBuilder().addInterceptor(StreamInterceptor(headers, token)).build()

        /** The player's client for a row with its own headers; `connectMs` null keeps [base]'s (PlayPolicy.connectTimeoutMs). */
        fun playerClient(base: OkHttpClient, headers: Map<String, String>, token: String?, connectMs: Long?): OkHttpClient =
            base.newBuilder().addInterceptor(StreamInterceptor(headers, token))
                .apply { if (connectMs != null) connectTimeout(connectMs, java.util.concurrent.TimeUnit.MILLISECONDS) }.build()
    }
}
