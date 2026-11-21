package com.chitram.app.resolve

import com.chitram.app.resolve.MappleResolver.Companion.obj
import com.chitram.app.resolve.MappleResolver.Companion.str
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/**
 * vaplayer on the device. Chain from providers/vaplayer.js, proved end to end
 * from a residential IP on 2026-11-20 (Interstellar tt0816692):
 *   1. GET vaplayer.ru/embed/va_src.php?path=/embed/<type>/<imdb>[/s/e] -> {src}
 *   2. GET src (player page)                -> "apiToken" (SINGLE USE)
 *   3. GET api.php?...&stream_urls&api_token -> stream_urls (base64, encrypted) + wasm_url
 *   4. decrypt in the module at wasm_url     -> one master url per line
 *   5. GET <origin>/generate.php?api_token   -> host token (JWT, ip_cidr = caller /24, 4 h)
 * Every request needs Referer/Origin. The host token goes on the master and on
 * EVERY segment (segments carry none and 403 without it).
 *
 * The token is bound to this device's /24. A phone behind carrier NAT can come
 * out of a different address for the video host, so the first segment is fetched
 * once here: a 403 fails the resolve (SegmentForbidden) and the player never
 * starts a source that cannot play.
 */
class VaplayerResolver(
    client: OkHttpClient,
    private val hosts: HostBook,
    /** The bundled module (assets/va.wasm), used only when wasm_url cannot be fetched. */
    private val bundledWasm: () -> ByteArray?,
) {
    private val follow = client
    private val noFollow = client.newBuilder().followRedirects(false).followSslRedirects(false).build()

    /** null: vaplayer does not have this title. Throws when the chain failed. */
    suspend fun resolve(cfg: VaplayerConfig, imdb: String, type: String, season: Int = 0, episode: Int = 0): Resolved? {
        val tv = type == "tv" || type == "series"
        val apiType = if (tv) "tv" else "movie"
        val path = if (tv) cfg.embedTvPath.replace("{imdb}", imdb).replace("{season}", "$season").replace("{episode}", "$episode")
                   else cfg.embedMoviePath.replace("{imdb}", imdb)
        val probe = noFollow.newBuilder().callTimeout(cfg.stepTimeoutMs, TimeUnit.MILLISECONDS).build()
        val http = follow.newBuilder().callTimeout(cfg.stepTimeoutMs, TimeUnit.MILLISECONDS).build()

        // 1. va_src on the wrapper host, healed like the backend's upstreamBase.
        val (wrapper, src) = hosts.heal(NAME, cfg.wrapperBases) { b -> vaSrc(cfg, probe, b, path) }

        // 2. The player page carries the single-use apiToken.
        val page = http.fetch(Request.Builder().url(src).header("User-Agent", cfg.userAgent).header("Referer", "$wrapper/").build())
        if (!page.ok) throw StepException("vaplayer player", page.code, "player page HTTP ${page.code}")
        // The page's `const CONFIG = {...}` (server twin: lib/selfheal/keys.js parseVaConfig)
        // backs up the regex and names api.php; rateLimited:true is an IP gate.
        val conf = parseConfig(page.body)
        if ((conf?.get("rateLimited") as? JsonPrimitive)?.booleanOrNull == true) {
            android.util.Log.i("Chitram", "vaplayer: player page says rateLimited:true for $imdb")
            throw StepException("vaplayer", 429, "rateLimited")
        }
        val fromRegex = Regex(cfg.apiTokenRegex).find(page.body)?.groupValues?.getOrNull(1)
        val fromConf = (conf?.get("apiToken") as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.takeIf { it.isNotEmpty() }
        if (fromRegex == null && fromConf != null) android.util.Log.i("Chitram", "vaplayer: token via CONFIG for $imdb (regex missed)")
        val apiToken = fromRegex ?: fromConf
            ?: throw StepException("vaplayer player", page.code, "no apiToken on the player page (IP blocked?)")

        // 3. api.php: the page's CONFIG.streamDataApiUrl when it names one; else the
        // configured url, or streamdata.<new host> after a wrapper heal.
        val pageApi = (conf?.get("streamDataApiUrl") as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
            ?.takeIf { Regex("^https://[^/\\s]+/\\S*$").matches(it) }
        val api = pageApi
            ?: if (wrapper == cfg.wrapperBases.first().trimEnd('/')) cfg.apiUrl
               else "https://streamdata.${wrapper.toHttpUrlOrNull()!!.host}/api.php"
        val qs = buildString {
            append("imdb=").append(enc(imdb)).append("&type=").append(apiType)
            if (tv) append("&season=$season&episode=$episode")
            append("&stream_urls&api_token=").append(enc(apiToken))
        }
        val r = http.fetch(Request.Builder().url("$api?$qs").headers(apiHeaders(cfg)).build())
        if (!r.ok) throw StepException("vaplayer api", r.code, "api.php HTTP ${r.code}")
        val j = obj(r.body) ?: throw StepException("vaplayer api", r.code, "api.php not JSON")
        val status = (j["status_code"] as? JsonPrimitive)?.contentOrNull
        // {"status_code":404} is the only clean "not here"; 403 "invalid api token" is a failure.
        if (status == "404") return null
        if (status != "200") throw StepException("vaplayer api", r.code, "status_code=$status ${j.str("error").orEmpty()}")
        val data = j["data"] as? JsonObject ?: throw StepException("vaplayer api", r.code, "no data")
        val raw = data["stream_urls"]
        val urls: List<String> = when (raw) {
            is JsonPrimitive -> decrypt(cfg, http, raw.contentOrNull.orEmpty(), (j["va"] ?: j["vp"]) as? JsonObject)
            is JsonArray -> raw.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
            else -> emptyList()
        }
        if (urls.isEmpty()) return null

        // 5. One host token per stream origin.
        val tokens = HashMap<String, String>()
        var lastError: Exception? = null
        for (u in urls) {
            val origin = originOf(u) ?: continue
            val token = tokens[origin] ?: hostToken(cfg, http, origin, apiToken).also { tokens[origin] = it }
            if (token.isEmpty()) { lastError = StepException("vaplayer generate", 0, "no host token from $origin"); continue }
            val master = applyToken(u, token, cfg.tokenPlaceholder)
            try {
                val m = check(cfg, master, token)
                return Resolved(NAME, "VaPlayer", master, streamHeaders(cfg), token, m.audio, m.levels, m.codecs)
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                lastError = e
                android.util.Log.i("Chitram", "vaplayer: ${originOf(u)} unusable: ${e.message}")
                if (e is SegmentForbidden) break // same token, same /24: the other urls fail the same way
            }
        }
        throw lastError ?: StepException("vaplayer", 0, "no usable stream url")
    }

    private suspend fun vaSrc(cfg: VaplayerConfig, http: OkHttpClient, b: String, path: String): HostBook.Probe<String> {
        val url = "$b${cfg.vaSrcPath}?path=${enc(path)}"
        val r = http.fetch(Request.Builder().url(url).header("User-Agent", cfg.userAgent).header("Referer", "$b$path").build())
        if (r.code in 300..399) {
            val to = r.location()?.let { resolveAgainst(url, it) }?.let(::originOf)
            if (to != null && to != b) return HostBook.Probe.Moved(to)
        }
        if (!r.ok) return HostBook.Probe.Dead(StepException("vaplayer va_src", r.code, "HTTP ${r.code} from $b"))
        val src = obj(r.body)?.str("src") ?: return HostBook.Probe.Dead(StepException("vaplayer va_src", r.code, "no src from $b"))
        return HostBook.Probe.Ok(resolveAgainst(url, src) ?: src)
    }

    /** The module named by THIS response, cached by url: a rotated module is fetched once. */
    private suspend fun decrypt(cfg: VaplayerConfig, http: OkHttpClient, enc: String, va: JsonObject?): List<String> {
        val wasmUrl = va?.str("wasm_url")
        var fetchError: Exception? = null
        if (wasmUrl != null) {
            val module = try { module(cfg, http, wasmUrl) } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                fetchError = e; null
            }
            if (module != null) return VaDecrypt.decrypt(module, enc, cfg.plaintextOffset)
        }
        // Last resort: the copy shipped in the APK (right only until the key rotates;
        // VaDecrypt refuses output that is not a url list).
        val bundled = bundledWasm() ?: throw fetchError ?: StepException("vaplayer wasm", 0, "no wasm_url")
        android.util.Log.i("Chitram", "vaplayer: wasm fetch failed (${fetchError?.message}), trying bundled module")
        return VaDecrypt.decrypt(WasmModule.parse(bundled), enc, cfg.plaintextOffset)
    }

    private suspend fun module(cfg: VaplayerConfig, http: OkHttpClient, url: String): WasmModule {
        synchronized(cache) { cache[url] }?.let { return it }
        val r = http.fetch(Request.Builder().url(url).headers(apiHeaders(cfg)).build(), asBytes = true)
        if (!r.ok) throw StepException("vaplayer wasm", r.code, "wasm HTTP ${r.code}")
        val m = WasmModule.parse(r.bytes ?: ByteArray(0))
        synchronized(cache) {
            cache[url] = m
            while (cache.size > CACHE_MAX) cache.remove(cache.keys.first())
        }
        return m
    }

    private suspend fun hostToken(cfg: VaplayerConfig, http: OkHttpClient, origin: String, apiToken: String): String = try {
        val r = http.fetch(Request.Builder().url("$origin${cfg.generatePath}?api_token=${enc(apiToken)}").headers(apiHeaders(cfg)).build())
        val t = if (r.ok) r.body.trim() else ""
        if (t.startsWith("{")) obj(t)?.let { it.str("token") ?: it.str("data") ?: it.str("string") ?: it.str("result") }.orEmpty()
        else if (t.startsWith("\"")) runCatching { Json.parseToJsonElement(t) as? JsonPrimitive }.getOrNull()?.contentOrNull.orEmpty()
        else t
    } catch (e: Exception) {
        if (e is kotlinx.coroutines.CancellationException) throw e
        ""
    }

    /** Master answers, and its first segment answers with the token: else this source cannot play here. */
    private suspend fun check(cfg: VaplayerConfig, master: String, token: String): Master {
        val c = StreamInterceptor.client(follow, streamHeaders(cfg), token).newBuilder()
            .callTimeout(cfg.stepTimeoutMs, TimeUnit.MILLISECONDS).build()
        val m = c.fetch(Request.Builder().url(master).build())
        if (m.code == 401 || m.code == 403) throw SegmentForbidden("vaplayer master HTTP ${m.code}")
        if (!m.ok) throw StepException("vaplayer master", m.code, "master HTTP ${m.code}")
        val parsed = Hls.parse(m.body, master)
        if (parsed.empty) throw StepException("vaplayer master", m.code, "empty master")
        if (!cfg.probeSegment) return parsed
        val media = parsed.firstVariant?.let { v ->
            val r = c.fetch(Request.Builder().url(v).build())
            if (r.code == 401 || r.code == 403) throw SegmentForbidden("vaplayer playlist HTTP ${r.code}")
            if (!r.ok) throw StepException("vaplayer playlist", r.code, "playlist HTTP ${r.code}")
            r.body to v
        } ?: (m.body to master)
        val seg = Hls.firstSegment(media.first, media.second) ?: return parsed
        val s = c.fetch(Request.Builder().url(seg).header("Range", "bytes=0-1023").build(), asBytes = true)
        if (s.code == 401 || s.code == 403) throw SegmentForbidden("vaplayer segment HTTP ${s.code} (token bound to another IP?)")
        if (!s.ok) throw StepException("vaplayer segment", s.code, "segment HTTP ${s.code}")
        return parsed
    }

    companion object {
        const val NAME = "VaPlayer"

        /**
         * Body of `<const|let|var> CONFIG = {...}` on the player page as JSON, or
         * null. Port of lib/selfheal/keys.js parseVaConfig: brace match outside
         * strings, then JSON, then a plain object literal (bare keys quoted,
         * single-quoted strings converted, trailing commas dropped). No code runs.
         */
        fun parseConfig(html: String): JsonObject? {
            val m = Regex("""\b(?:const|let|var)\s+CONFIG\s*=\s*\{""").find(html) ?: return null
            val start = m.range.last
            var depth = 0
            var quote: Char? = null
            var end = -1
            var i = start
            while (i < html.length) {
                val c = html[i]
                if (quote != null) { if (c == '\\') i++ else if (c == quote) quote = null }
                else if (c == '"' || c == '\'' || c == '`') quote = c
                else if (c == '{') depth++
                else if (c == '}' && --depth == 0) { end = i; break }
                i++
            }
            if (end < 0) return null
            val src = html.substring(start, end + 1)
            runCatching { Json.parseToJsonElement(src) as? JsonObject }.getOrNull()?.takeIf(::strictJson)?.let { return it }
            return runCatching {
                val json = Regex(""""(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^"']+""").findAll(src).joinToString("") { t ->
                    val v = t.value
                    when (v[0]) {
                        '"' -> v
                        '\'' -> kotlinx.serialization.json.JsonPrimitive(v.substring(1, v.length - 1).replace("\\'", "'")).toString()
                        else -> v.replace(Regex("""([{,]\s*)([A-Za-z_$][\w$]*)\s*:"""), "$1\"$2\":").replace(Regex(""",(\s*[}\]])"""), "$1")
                    }
                }
                Json.parseToJsonElement(json) as? JsonObject
            }.getOrNull()?.takeIf(::strictJson)
        }

        /** kotlinx reads an unquoted `fn()` as a literal; JSON.parse (the server) rejects it. */
        private fun strictJson(e: kotlinx.serialization.json.JsonElement): Boolean = when (e) {
            is JsonObject -> e.values.all(::strictJson)
            is JsonArray -> e.all(::strictJson)
            is JsonPrimitive -> e.isString || e is kotlinx.serialization.json.JsonNull || e.content == "true" || e.content == "false" ||
                Regex("""-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?""").matches(e.content)
        }
        private const val CACHE_MAX = 4
        private val cache = LinkedHashMap<String, WasmModule>()

        fun streamHeaders(cfg: VaplayerConfig) =
            mapOf("User-Agent" to cfg.userAgent, "Referer" to "${cfg.playerOrigin}/", "Origin" to cfg.playerOrigin)

        private fun apiHeaders(cfg: VaplayerConfig) = okhttp3.Headers.headersOf(
            "User-Agent", cfg.userAgent, "Referer", "${cfg.playerOrigin}/", "Origin", cfg.playerOrigin,
        )

        fun applyToken(url: String, token: String, placeholder: String = "__TOKEN__"): String = when {
            token.isEmpty() -> url
            url.contains(placeholder) -> url.replace(placeholder, token)
            else -> url + (if (url.contains('?')) "&" else "?") + "token=" + token
        }

        private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

        /** Test seam: drop cached modules. */
        internal fun clearCache() = synchronized(cache) { cache.clear() }
        internal fun cachedUrls(): Set<String> = synchronized(cache) { cache.keys.toSet() }
    }
}
