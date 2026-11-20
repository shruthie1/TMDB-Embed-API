package com.chitram.app.resolve

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okio.ByteString.Companion.decodeBase64
import java.util.concurrent.TimeUnit

/** TV API protocol, on the viewer's IP. Credentials never travel to the VM or media CDN. */
class NetmirrorResolver(
    client: OkHttpClient,
    private val otp: () -> String = { "111111" },
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val jar = object : CookieJar {
        private val cookies = mutableListOf<Cookie>()
        override fun saveFromResponse(url: HttpUrl, incoming: List<Cookie>) = synchronized(cookies) {
            for (c in incoming) {
                cookies.removeAll { it.name == c.name && it.domain == c.domain && it.path == c.path }
                if (c.expiresAt > now()) cookies += c
            }
        }
        override fun loadForRequest(url: HttpUrl): List<Cookie> = synchronized(cookies) {
            cookies.removeAll { it.expiresAt <= now() }
            cookies.filter { it.matches(url) }
        }
    }
    private val http = client.newBuilder().cookieJar(jar).followRedirects(false).cache(null).callTimeout(10, TimeUnit.SECONDS).build()
    private val mediaHttp = client.newBuilder().cookieJar(CookieJar.NO_COOKIES).cache(null).callTimeout(12, TimeUnit.SECONDS).build()
    // Serial chains share sessions and metadata; cancelling a resolve releases the lock.
    private val lock = Mutex()
    private var api: String? = null
    private var apiUntil = 0L
    private var discoveryDomains: List<String> = emptyList()
    private var token: String? = null
    private var tokenUntil = 0L
    private var credential: String? = null
    private var blockedUntil = 0L
    private var bucketAt = 0L
    private var calls = 0
    private data class Cached(val value: JsonObject, val until: Long)
    private val metadata = linkedMapOf<String, Cached>()
    private val players = linkedMapOf<String, Pair<List<Resolved>, Long>>()

    suspend fun resolve(cfg: NetmirrorConfig, type: String, title: String, year: Int?, season: Int, episode: Int, fresh: Boolean = false, onRow: (Resolved) -> Unit = {}): List<Resolved> = lock.withLock {
        if (!cfg.enabled || title.isBlank()) return@withLock emptyList()
        if (blockedUntil > now()) throw StepException("netmirror", 0, "cooldown active")
        if (discoveryDomains != cfg.domains) {
            api = null; apiUntil = 0; token = null; tokenUntil = 0; metadata.clear(); players.clear()
            discoveryDomains = cfg.domains.toList()
        }
        val cacheKey = "${cfg.domains}|$type|$title|$year|$season|$episode"
        if (!fresh) players[cacheKey]?.takeIf { it.second > now() }?.let { return@withLock it.first }
        val base = discover(cfg)
        val out = mutableListOf<Resolved>()
        var failed = false
        val catalogs = try {
            val list = objects(json(cfg, base, "nf", "/newtv/ott.php", cache = true), "ott")
                .mapNotNull { str(it, "value")?.takeIf { v -> Regex("[A-Za-z0-9_-]{1,24}").matches(v) } }.distinct()
            if (list.isEmpty()) throw StepException("netmirror catalogs", 0, "no catalogs returned")
            list
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            if (blockedUntil > now() || calls >= cfg.maxCalls) throw e
            failed = true
            listOf("nf", "pv", "hs")
        }
        for (ott in catalogs) {
            try {
                val matches = search(cfg, base, ott, title)
                for (match in matches) {
                    try {
                    val id = str(match, "id") ?: continue
                    val post = json(cfg, base, ott, "/newtv/post.php?id=${enc(id)}", mapOf("Lastep" to ""), cache = true)
                    val postYear = str(post, "year")?.take(4)?.toIntOrNull()
                    if (year != null && postYear != null && kotlin.math.abs(year - postYear) > 1) continue
                    val target = if (type == "tv" || type == "series") episodeId(cfg, base, ott, post, season, episode)
                        else if (str(post, "type") == "t" || objects(post, "episodes").isNotEmpty()) null else str(post, "main_id") ?: id
                    if (target == null) continue
                    val player = json(cfg, base, ott, "/newtv/player.php?id=${enc(target)}")
                    val link = str(player, "video_link") ?: continue
                    val referer = str(player, "referer") ?: "$base/"
                    val headers = mapOf("Referer" to referer, "User-Agent" to UA, "X-Requested-With" to "NetmirrorNewTV v1.0")
                    val reply = mediaHttp.fetch(Request.Builder().url(link).apply { headers.forEach { (k, v) -> header(k, v) } }.build())
                    if (!reply.ok || !reply.body.trimStart().startsWith("#EXTM3U")) throw StepException("netmirror master", reply.code, "unavailable playlist")
                    if (!masterMatchesTitle(reply.body, target)) {
                        blockedUntil = now() + cfg.cooldownMs
                        throw StepException("netmirror master", 0, "substituted video rejected")
                    }
                    val master = Hls.parse(reply.body, link)
                    if (master.empty) throw StepException("netmirror master", 0, "empty playlist")
                    val langs = objects(post, "lang").mapNotNull { str(it, "l") }
                    // Only actual renditions are selectable; post.lang never invents tracks.
                    val audio = master.audio.map { a -> a.copy(name = a.name?.replace(Regex("^\\[\\d+]\\s*"), "")) }
                        .let { a -> if (a.size == 1 && a[0].label == null && langs.size == 1) listOf(a[0].copy(language = langs[0])) else a }
                    val label = when (ott) { "nf" -> "Netflix"; "pv" -> "Prime Video"; "hs" -> "Hotstar"; else -> ott.uppercase() }
                    val subtitles = reply.body.lines().filter { it.startsWith("#EXT-X-MEDIA:") }.mapNotNull { line ->
                        val a = Hls.attrs(line)
                        if (a["TYPE"] != "SUBTITLES") null else a["URI"]?.takeUnless { it.substringBefore('?').endsWith(".m3u8", true) }?.let { uri ->
                            com.chitram.app.data.SubtitleRef(url = Hls.resolve(uri, link), lang = a["LANGUAGE"].orEmpty(), id = a["NAME"].orEmpty())
                        }
                    }
                    out += Resolved("netmirror", "NetMirror | $label", link, headers, null, audio, master.levels, master.codecs,
                        key = "netmirror-$ott-$target", subtitles = subtitles,
                        languages = if (audio.isEmpty() && langs.size == 1) langs else Hls.languages(audio), catalogLanguages = langs).also(onRow)
                    } catch (e: Exception) {
                        if (e is CancellationException) throw e
                        failed = true
                        android.util.Log.i("Chitram", "netmirror $ott catalog row failed: ${e.message}")
                        if (blockedUntil > now() || calls >= cfg.maxCalls) throw e
                    }
                }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                failed = true
                android.util.Log.i("Chitram", "netmirror $ott: ${e.message}")
                if (blockedUntil > now() || calls >= cfg.maxCalls) break
            }
        }
        // Never cache a partial result as a complete answer; a fresh resolve may add languages.
        if (!failed) {
            if (players.size >= 32) players.remove(players.keys.first())
            val until = out.fold(now() + cfg.playerTtlMs) { expiry, row ->
                val u = row.url.toHttpUrlOrNull()
                val value = listOf("e", "exp", "expires").firstNotNullOfOrNull { u?.queryParameter(it)?.toLongOrNull() }
                val stated = value?.let { if (it < 10_000_000_000L) it * 1000 else it }
                if (stated != null) minOf(expiry, stated - 1000) else expiry
            }
            players[cacheKey] = out.toList() to until
        }
        if (out.isEmpty() && failed) throw StepException("netmirror", 0, "upstream resolution failed")
        if (failed) out.map { it.copy(incomplete = true) } else out
    }

    private suspend fun discover(cfg: NetmirrorConfig): String {
        if (apiUntil > now()) api?.let { return it }
        for (domain in cfg.domains) {
            try {
                val r = request(cfg, "$domain/checknewtv.php", emptyMap())
                val data = MappleResolver.obj(r.body) ?: continue
                val decoded = str(data, "token_hash")?.decodeBase64()?.utf8() ?: continue
                val url = decoded.toHttpUrlOrNull() ?: continue
                if ((!url.isHttps && url.host !in listOf("localhost", "127.0.0.1")) || url.username.isNotEmpty() || url.password.isNotEmpty()) continue
                val next = url.toString().trimEnd('/')
                if (api != next) { token = null; tokenUntil = 0; metadata.clear() }
                api = next; apiUntil = now() + cfg.apiTtlMs
                return next
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                if (blockedUntil > now() || calls >= cfg.maxCalls) throw e
            }
        }
        throw StepException("netmirror discovery", 0, "no usable API")
    }

    private suspend fun authenticate(cfg: NetmirrorConfig, base: String): String {
        val entered = otp()
        if (tokenUntil > now() && credential == entered) token?.let { return it }
        token = null; tokenUntil = 0
        val r = request(cfg, "$base/newtv/otp.php", mapOf("Otp" to entered, "User-Agent" to UA.replace("GatuNewTV", "Gatu")))
        val data = MappleResolver.obj(r.body)
        val value = data?.let { str(it, "usertoken") }
        if (data == null || str(data, "status") != "ok" || value.isNullOrBlank()) {
            blockedUntil = now() + cfg.cooldownMs
            throw StepException("netmirror login", r.code, "OTP not accepted")
        }
        token = value; credential = entered; tokenUntil = now() + cfg.sessionTtlMs
        return value
    }

    private suspend fun json(cfg: NetmirrorConfig, base: String, ott: String, path: String, extra: Map<String, String> = emptyMap(), cache: Boolean = false): JsonObject {
        val key = "$base|$ott|$path"
        if (cache) metadata[key]?.takeIf { it.until > now() }?.let { return it.value }
        repeat(2) { attempt ->
            val value = authenticate(cfg, base)
            val r = request(cfg, "$base$path", extra + mapOf("Ott" to ott, "Usertoken" to value))
            val data = MappleResolver.obj(r.body) ?: throw StepException("netmirror API", r.code, "not JSON")
            if (str(data, "status") == "otp") {
                token = null; tokenUntil = 0
                if (attempt == 1) { blockedUntil = now() + cfg.cooldownMs; throw StepException("netmirror login", 0, "session rejected after renewal") }
            } else {
                if (str(data, "status") == "error") throw StepException("netmirror API", r.code, "upstream error")
                if (cache) {
                    if (metadata.size >= 128) metadata.remove(metadata.keys.first())
                    metadata[key] = Cached(data, now() + if (path == "/newtv/ott.php") cfg.apiTtlMs else cfg.metadataTtlMs)
                }
                return data
            }
        }
        error("unreachable")
    }

    private suspend fun search(cfg: NetmirrorConfig, base: String, ott: String, title: String): List<JsonObject> {
        for (q in TitleMatch.spellings(title)) {
            val data = json(cfg, base, ott, "/newtv/search.php?s=${enc(q)}", cache = true)
            val rows = objects(data, "searchResult")
            val matches = rows.filter { TitleMatch.find(listOf(it), title) { r -> str(r, "t") ?: str(r, "title").orEmpty() } != null }
            if (matches.isNotEmpty()) return matches
        }
        return emptyList()
    }

    private suspend fun episodeId(cfg: NetmirrorConfig, base: String, ott: String, post: JsonObject, season: Int, episode: Int): String? {
        fun seasonNumber(row: JsonObject, index: Int): Int? =
            str(row, "s")?.let(::number) ?: if (str(row, "s").isNullOrBlank()) index + 1 else null
        val seasons = objects(post, "season")
        val selectedIndex = seasons.indexOfFirst { str(it, "selected") in listOf("true", "1") }
        val selected = seasons.getOrNull(selectedIndex)?.let { seasonNumber(it, selectedIndex) }
        fun find(data: JsonObject, fallback: Int?) = objects(data, "episodes").firstOrNull { ep ->
            (number(str(ep, "sNum")) ?: fallback) == season &&
                (number(str(ep, "ep")) ?: number(str(ep, "epNum"))) == episode
        }?.let { str(it, "id") }
        find(post, selected)?.let { return it }
        val wanted = seasons.withIndex().firstOrNull { seasonNumber(it.value, it.index) == season }?.value
            ?.let { str(it, "id") } ?: return null
        var data = post
        // The first selected-season page is already in post.php. Other seasons load by their explicit ID.
        if (selected != season) {
            data = json(cfg, base, ott, "/newtv/episodes.php?id=${enc(wanted)}", cache = true)
            find(data, season)?.let { return it }
        }
        val visited = mutableSetOf<String>()
        repeat(20) {
            if (str(data, "nextPageShow") !in listOf("1", "true")) return null
            val cursorSeason = str(data, "nextPageSeason")?.takeIf { it.isNotBlank() } ?: throw StepException("netmirror episodes", 0, "missing season cursor")
            val cursor = str(data, "nextPage")?.takeIf { it.isNotBlank() } ?: throw StepException("netmirror episodes", 0, "missing page cursor")
            val key = "$cursorSeason|$cursor"
            if (!visited.add(key)) throw StepException("netmirror episodes", 0, "repeated page cursor")
            data = json(cfg, base, ott, "/newtv/episodes.php?id=${enc(cursorSeason)}&page=${enc(cursor)}", cache = true)
            find(data, season)?.let { return it }
        }
        throw StepException("netmirror episodes", 0, "page budget spent")
    }

    private suspend fun request(cfg: NetmirrorConfig, url: String, headers: Map<String, String>): Reply {
        if (blockedUntil > now()) throw StepException("netmirror", 0, "cooldown active")
        if (now() - bucketAt >= cfg.budgetWindowMs) { bucketAt = now(); calls = 0 }
        if (calls >= cfg.maxCalls) throw StepException("netmirror", 0, "request budget spent")
        calls++
        val r = http.fetch(Request.Builder().url(url).header("User-Agent", UA)
            .header("X-Requested-With", "NetmirrorNewTV v1.0").header("Cache-Control", "no-cache, no-store, must-revalidate")
            .header("Pragma", "no-cache").header("Expires", "0").apply { headers.forEach { (k, v) -> header(k, v) } }.build())
        if (r.code == 429 || (r.code == 403 && r.body.contains("Page Not Found", true))) blockedUntil = now() + cfg.cooldownMs
        if (!r.ok) throw StepException("netmirror API", r.code, "HTTP ${r.code}")
        return r
    }

    companion object {
        const val UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0 /OS.GatuNewTV v1.0"
        fun masterMatchesTitle(text: String, id: String): Boolean {
            val ids = text.lines().map(String::trim).filter { it.isNotBlank() && !it.startsWith('#') }
                .mapNotNull { Regex("files/(\\d+)").find(it)?.groupValues?.get(1) }.toSet()
            return ids.isEmpty() || id in ids
        }
        private fun str(o: JsonObject, key: String) = (o[key] as? JsonPrimitive)?.contentOrNull
        private fun objects(o: JsonObject, key: String) = (o[key] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
        private fun number(s: String?) = s?.let { Regex("\\d+").find(it)?.value?.toIntOrNull() }
        private fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8")
    }
}
