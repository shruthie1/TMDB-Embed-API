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
/** Gap 13.9: a prewarm spent its half of the window budget; Play keeps the rest. Not a provider failure. */
class PrewarmShareSpent : java.io.IOException("netmirror: prewarm share of the window budget spent"), SelfImposedSkip

class NetmirrorResolver(
    client: OkHttpClient,
    private val otp: () -> String = { "111111" },
    private val now: () -> Long = System::currentTimeMillis,
    /**
     * Keeps the otp.php session (token, the OTP it was issued for, expiry and the
     * API base it belongs to) across process death, so a cold start does not call
     * otp.php again. Null: memory only. The token is never logged.
     */
    private val kv: com.chitram.app.data.KeyValue? = null,
    /** Decision log sink; never given a token or an OTP. */
    private val log: (String) -> Unit = { android.util.Log.i("Chitram", it) },
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
    /**
     * The API base that last accepted [token]. After a base change the token is still
     * tried there first: it is not bound to the base (upstream keeps one global token),
     * and only a `status:"otp"` answer costs an otp.php call.
     */
    private var tokenBase: String? = null
    /** When [token] was issued, for the `token rejected age=` log line only. */
    private var tokenIssuedAt = 0L
    private var blockedUntil = 0L

    /** True while a 429/403, a substituted clip or a refused OTP holds every request back. */
    val throttled: Boolean get() = blockedUntil > now()

    /** Ms left in the pause [throttled] reports; 0 when not paused. */
    fun pausedForMs(): Long = (blockedUntil - now()).coerceAtLeast(0)

    /** Ms until the request window resets, when this window's whole budget is spent; else 0. */
    fun budgetSpentForMs(cfg: NetmirrorConfig): Long =
        if (now() - bucketAt < cfg.budgetWindowMs && calls >= cfg.maxCalls) bucketAt + cfg.budgetWindowMs - now() else 0

    /** One bad answer pauses every title (the guard stays); the log says why and for how long. */
    private fun pause(cfg: NetmirrorConfig, reason: String) {
        blockedUntil = now() + cfg.cooldownMs
        log("[netmirror] paused ${cfg.cooldownMs / 1000}s after $reason")
    }

    init {
        kv?.let { s ->
            val t = s.get(KV_TOKEN); val c = s.get(KV_CREDENTIAL); val b = s.get(KV_BASE); val u = s.get(KV_UNTIL)?.toLongOrNull()
            if (!t.isNullOrBlank() && c != null && !b.isNullOrBlank() && u != null && u > now()) {
                token = t; credential = c; tokenBase = b; tokenUntil = u
                tokenIssuedAt = s.get(KV_ISSUED)?.toLongOrNull() ?: issuedAtOf(t) ?: 0L
            }
        }
    }

    private fun clearToken() {
        token = null; tokenUntil = 0; tokenBase = null; tokenIssuedAt = 0
        kv?.let { s -> listOf(KV_TOKEN, KV_CREDENTIAL, KV_BASE, KV_UNTIL, KV_ISSUED).forEach { s.put(it, null) } }
    }

    private fun saveToken(value: String, entered: String, base: String, ttlMs: Long) {
        token = value; credential = entered; tokenBase = base; tokenUntil = now() + ttlMs; tokenIssuedAt = now()
        kv?.let { s -> s.put(KV_TOKEN, value); s.put(KV_CREDENTIAL, entered); s.put(KV_BASE, base); s.put(KV_UNTIL, tokenUntil.toString()); s.put(KV_ISSUED, tokenIssuedAt.toString()) }
    }

    /** The token was accepted on [base]: remember that base so a cold start knows where it last worked. */
    private fun acceptedOn(base: String) {
        if (token == null || tokenBase == base) return
        tokenBase = base
        kv?.put(KV_BASE, base)
    }
    private var bucketAt = 0L
    private var calls = 0
    /** The resolve holding [lock] is a prewarm (gap 13.9). */
    @Volatile private var prewarmCall = false

    /** Requests this resolve may reach in the window: a prewarm stops at half, so Play keeps the rest. */
    private fun limit(cfg: NetmirrorConfig): Int = if (prewarmCall) cfg.maxCalls / 2 else cfg.maxCalls

    /** Gap 13.9: the prewarms' half of this window's requests is spent. */
    fun prewarmShareSpent(cfg: NetmirrorConfig): Boolean = now() - bucketAt < cfg.budgetWindowMs && calls >= cfg.maxCalls / 2
    private data class Cached(val value: JsonObject, val until: Long)
    private val metadata = linkedMapOf<String, Cached>()
    private val players = linkedMapOf<String, Pair<List<Resolved>, Long>>()

    /**
     * `tap`: the viewer asked for NetMirror now (a row pick, Check, Refresh). It
     * tries past this resolver's own cooldown; a new 403/429 starts a new one.
     */
    suspend fun resolve(cfg: NetmirrorConfig, type: String, title: String, year: Int?, season: Int, episode: Int, fresh: Boolean = false, prewarm: Boolean = false, tap: Boolean = false, onRow: (Resolved) -> Unit = {}): List<Resolved> = lock.withLock {
        if (!cfg.enabled || title.isBlank()) return@withLock emptyList()
        if (blockedUntil > now()) {
            if (!tap || prewarm) throw NetmirrorSkip("cooldown active, ${(blockedUntil - now()) / 1000}s left")
            log("[netmirror] cooldown skipped for tap (${(blockedUntil - now()) / 1000}s left)")
            blockedUntil = 0
        }
        prewarmCall = prewarm
        if (discoveryDomains != cfg.domains) {
            // A new discovery list may point at a new API base. The token stays: it is
            // tried on the new base first and renewed only on a `status:"otp"` answer.
            api = null; apiUntil = 0; metadata.clear(); players.clear()
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
            if (blockedUntil > now() || calls >= limit(cfg)) throw e
            failed = true
            listOf("nf", "pv", "hs")
        }
        // Cheapest plan first: Netflix, Prime, Hotstar (any new catalogue after), one spelling at a
        // time across them; a catalogue is not searched again once it matched or failed. Play stops
        // once a catalogue gives a Telugu row; a tap (Check, row pick) asks every catalogue.
        val order = catalogs.sortedBy { PLAN.indexOf(it).let { i -> if (i < 0) PLAN.size else i } }
        val spellings = TitleMatch.spellings(title)
        val done = mutableSetOf<String>()
        plan@ for ((n, q) in spellings.withIndex()) {
            for (ott in order) {
                if (ott in done) continue
                try {
                    val matches = search(cfg, base, ott, q, title)
                    if (matches.isEmpty()) continue
                    done += ott
                    val before = out.size
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
                                pause(cfg, "substituted video")
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
                                languages = if (audio.isEmpty() && langs.size == 1) langs else Hls.languages(audio), catalogLanguages = langs, netmirrorCatalog = label).also(onRow)
                            } catch (e: Exception) {
                                if (e is CancellationException) throw e
                                failed = true
                                android.util.Log.i("Chitram", "netmirror $ott catalog row failed: ${e.message}")
                                if (blockedUntil > now() || calls >= limit(cfg)) throw e
                            }
                        }
                    if (out.size > before && !tap) {
                        // 1.2.67: Play stops only once a row carries Telugu (from the file's audio tags);
                        // else it asks the next catalogue, one search at a time, each catalogue once.
                        if (out.any(::hasTelugu)) {
                            log("[netmirror] plan: $ott matched on spelling ${n + 1}/${spellings.size} with a Telugu row, other catalogues not asked")
                            break@plan
                        }
                        val heard = out.subList(before, out.size).flatMap { it.languages }.distinctBy { it.lowercase() }.joinToString(",").ifEmpty { "no tags" }
                        log("[netmirror] plan: $ott matched on spelling ${n + 1}/${spellings.size} with no Telugu row ($heard), asking the next catalogue")
                    }
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
                    failed = true
                    done += ott
                    android.util.Log.i("Chitram", "netmirror $ott: ${e.message}")
                    if (blockedUntil > now() || calls >= limit(cfg)) break@plan
                }
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
        if (out.isEmpty() && failed) throw if (prewarm && calls >= limit(cfg) && calls < cfg.maxCalls) PrewarmShareSpent() else StepException("netmirror", 0, "upstream resolution failed")
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
                if (api != next) metadata.clear()
                api = next; apiUntil = now() + cfg.apiTtlMs
                return next
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                if (blockedUntil > now() || calls >= limit(cfg)) throw e
            }
        }
        throw StepException("netmirror discovery", 0, "no usable API")
    }

    private suspend fun authenticate(cfg: NetmirrorConfig, base: String): String {
        val entered = otp()
        if (tokenUntil > now() && credential == entered) token?.let { return it }
        clearToken()
        val r = request(cfg, "$base/newtv/otp.php", mapOf("Otp" to entered, "User-Agent" to UA.replace("GatuNewTV", "Gatu")))
        val data = MappleResolver.obj(r.body)
        val value = data?.let { str(it, "usertoken") }
        if (data == null || str(data, "status") != "ok" || value.isNullOrBlank()) {
            pause(cfg, "OTP not accepted")
            throw StepException("netmirror login", r.code, "OTP not accepted")
        }
        saveToken(value, entered, base, cfg.sessionTtlMs)
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
                val age = if (tokenIssuedAt > 0) (now() - tokenIssuedAt) / 60_000 else -1
                log("[netmirror] token rejected age=${if (age >= 0) "$age" else "?"}m")
                clearToken()
                if (attempt == 1) { pause(cfg, "session rejected after renewal"); throw StepException("netmirror login", 0, "session rejected after renewal") }
            } else {
                acceptedOn(base)
                if (str(data, "status") == "error") throw StepException("netmirror API", r.code, "upstream error")
                if (cache) {
                    if (metadata.size >= 128) metadata.remove(metadata.keys.first())
                    val ttl = when {
                        path == "/newtv/ott.php" -> cfg.apiTtlMs
                        // One transient empty answer must not hide a title for days (server: NEWTV_EMPTY_TTL_MS).
                        path.startsWith("/newtv/search.php") && objects(data, "searchResult").isEmpty() -> EMPTY_SEARCH_TTL_MS
                        else -> cfg.metadataTtlMs
                    }
                    metadata[key] = Cached(data, now() + ttl)
                }
                return data
            }
        }
        error("unreachable")
    }

    /** One spelling [q] on one catalogue: the rows whose title matches [title]. */
    private suspend fun search(cfg: NetmirrorConfig, base: String, ott: String, q: String, title: String): List<JsonObject> {
        val data = json(cfg, base, ott, "/newtv/search.php?s=${enc(q)}", cache = true)
        return objects(data, "searchResult").filter { TitleMatch.find(listOf(it), title) { r -> str(r, "t") ?: str(r, "title").orEmpty() } != null }
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
        if (blockedUntil > now()) throw NetmirrorSkip("cooldown active, ${(blockedUntil - now()) / 1000}s left")
        if (now() - bucketAt >= cfg.budgetWindowMs) { bucketAt = now(); calls = 0 }
        if (calls >= limit(cfg)) throw if (calls < cfg.maxCalls) PrewarmShareSpent() else NetmirrorSkip("request budget spent")
        calls++
        val r = http.fetch(Request.Builder().url(url).header("User-Agent", UA)
            .header("X-Requested-With", "NetmirrorNewTV v1.0").header("Cache-Control", "no-cache, no-store, must-revalidate")
            .header("Pragma", "no-cache").header("Expires", "0").apply { headers.forEach { (k, v) -> header(k, v) } }.build())
        if (r.code == 429 || (r.code == 403 && r.body.contains("Page Not Found", true))) pause(cfg, "HTTP ${r.code}")
        if (!r.ok) throw StepException("netmirror API", r.code, "HTTP ${r.code}")
        return r
    }

    companion object {
        private const val KV_TOKEN = "netmirror.session.token"
        private const val KV_CREDENTIAL = "netmirror.session.otp"
        private const val KV_BASE = "netmirror.session.base"
        private const val KV_UNTIL = "netmirror.session.until"
        private const val KV_ISSUED = "netmirror.session.issued"
        /** Part 3 of `<hex>::<hex>::<epoch s>::ni` is the issue time (POC 2026-11-22). */
        internal fun issuedAtOf(token: String): Long? =
            token.split("::").getOrNull(2)?.takeIf { it.length == 10 && it.all(Char::isDigit) }?.toLongOrNull()?.times(1000)
        /** Catalogue order of the cheapest plan: Netflix, Prime Video, Hotstar. */
        internal val PLAN = listOf("nf", "pv", "hs")
        /** A row whose audio tags (or single catalogue language) say Telugu; post.lang alone never counts. */
        internal fun hasTelugu(r: Resolved): Boolean = r.languages.any { com.chitram.app.data.Ranking.languageLabel(it).equals("Telugu", true) }
        /** An empty search answer is kept 30 min, as on the server (NEWTV_EMPTY_TTL_MS). */
        const val EMPTY_SEARCH_TTL_MS = 30 * 60 * 1000L
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
