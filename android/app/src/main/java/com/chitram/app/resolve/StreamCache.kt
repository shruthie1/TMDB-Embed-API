package com.chitram.app.resolve

import com.chitram.app.data.KeyValue
import com.chitram.app.data.Source
import com.chitram.app.data.StreamsResponse
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

/**
 * Resolved stream rows kept on the device for [TTL_MS], so reopening a title or
 * pressing Play again reuses them with no new fetch (owner, 2026-11-22).
 *
 * One entry per title (type/id/season/episode). Inside it, one slot per source:
 * each on-device provider (per audio language asked, as the resolvers pick by it)
 * and the VM's /api/streams answer (first and ?full=1). Rows are stored whole,
 * every language/audio/video field included.
 *
 * A slot lives [TTL_MS], or less when a row's url states an earlier expiry: then
 * the whole slot ends at the earliest one (a slot never comes back with a row
 * missing, which could hide a language). Memory first, also written to the
 * device kv so a restart inside the TTL keeps it. At most [MAX_TITLES] titles;
 * the oldest written goes first.
 */
class StreamCache(private val kv: KeyValue?, private val now: () -> Long = System::currentTimeMillis) {

    @Serializable
    internal data class Slot(val at: Long, val until: Long, val rows: List<Source> = emptyList(), val vm: StreamsResponse? = null,
                             /** Rows of a partial answer (a sub-lookup failed): kept [PARTIAL_TTL_MS], replaced by a complete one. */
                             val partial: Boolean = false, val configFingerprint: String? = null)

    @Serializable
    internal data class Title(val at: Long, val slots: Map<String, Slot> = emptyMap())

    private val ser = kotlinx.serialization.builtins.MapSerializer(String.serializer(), Title.serializer())
    private val lock = Any()
    private var loaded = false
    /** Insertion order = write order: the first entry is the oldest. */
    private val titles = LinkedHashMap<String, Title>()

    /** Fresh rows this provider resolved for [title] in [preferred], or null. */
    fun device(title: String, name: String, preferred: String): List<Source>? =
        live(title, deviceSlot(name, preferred))?.rows?.takeIf { it.isNotEmpty() }

    /** The kept rows came from a partial answer: a fresh resolve may add rows (OnDevice refreshes in the background). */
    fun devicePartial(title: String, name: String, preferred: String): Boolean = live(title, deviceSlot(name, preferred))?.partial == true

    fun deviceFingerprint(title: String, name: String, preferred: String): String? = live(title, deviceSlot(name,preferred))?.configFingerprint

    fun hasDevice(title: String, name: String, preferred: String): Boolean = device(title, name, preferred) != null

    /**
     * Keeps a provider's rows. An empty answer is not kept. 1.2.52: a partial answer
     * (any row `incomplete`: one catalog or dub failed, or the budget ran out) is kept
     * too, for [PARTIAL_TTL_MS], so Play reuses its real rows with no request (it was
     * never kept before, so every Play resolved NetMirror again). A complete answer
     * replaces kept rows; a partial one never drops a kept row: rows it lacks stay, and
     * on top of a complete slot it only adds rows (the slot keeps its own end).
     */
    fun putDevice(title: String, name: String, preferred: String, rows: List<Source>, configFingerprint: String? = null) {
        if (rows.isEmpty()) return
        val slot = deviceSlot(name, preferred)
        if (rows.none { it.incomplete }) { put(title, slot, rows = rows, vm = null, expiry = expiryOf(rows), configFingerprint = configFingerprint); return }
        val at = now()
        val old = live(title, slot)
        val ids = rows.map { it.id }.toSet()
        if (old != null && !old.partial && old.configFingerprint == configFingerprint) {
            val add = rows.filter { r -> old.rows.none { it.id == r.id } }
            if (add.isEmpty()) return
            put(title, slot, rows = old.rows + add, vm = null, expiry = expiryOf(add), ttlMs = old.until - at, configFingerprint = configFingerprint)
            return
        }
        val merged = rows + old?.rows.orEmpty().filter { it.id !in ids }
        put(title, slot, rows = merged, vm = null, expiry = expiryOf(merged), ttlMs = PARTIAL_TTL_MS, partial = true, configFingerprint = configFingerprint)
    }

    private fun expiryOf(rows: List<Source>): Long? = rows.flatMap { listOfNotNull(it.url, it.directUrl) }.mapNotNull { UrlExpiry.at(it, now()) }.minOrNull()

    /** The VM answer for [title]: the ?full=1 one when kept ([full] false takes it over the first answer too). */
    fun vm(title: String, full: Boolean): StreamsResponse? =
        live(title, VM_FULL)?.vm ?: if (full) null else live(title, VM)?.vm

    fun putVm(title: String, full: Boolean, resp: StreamsResponse) {
        if (resp.streams.isEmpty()) return
        val expiry = resp.streams.flatMap { listOfNotNull(it.url, it.directUrl) }.mapNotNull { UrlExpiry.at(it, now()) }.minOrNull()
        put(title, if (full) VM_FULL else VM, rows = emptyList(), vm = resp, expiry = expiry)
    }

    /** A row from this provider failed in playback: drop its rows for this title (every language). */
    fun evictDevice(title: String, name: String) = edit(title) { slots -> slots.filterKeys { !it.startsWith("d:$name:") } }

    /** A VM row failed in playback, or the VM was asked to refresh: drop both VM answers for this title. */
    fun evictVm(title: String) = edit(title) { slots -> slots - VM - VM_FULL }

    /** "Refresh sources": drop every slot of this title (all providers, all languages, both VM answers). */
    fun evictTitle(title: String) = synchronized(lock) {
        load()
        if (titles.remove(title) != null) save()
    }

    /** Urls of every live row kept for [title] (device and VM): what a refresh compares against. */
    fun urls(title: String): Set<String> = synchronized(lock) {
        load()
        val at = now()
        titles[title]?.slots?.values.orEmpty().filter { it.until > at }
            .flatMap { s -> s.rows.map { it.url } + s.vm?.streams.orEmpty().mapNotNull { it.url } }.toSet()
    }

    private fun live(title: String, slot: String): Slot? = synchronized(lock) {
        load()
        val s = titles[title]?.slots?.get(slot) ?: return null
        if (s.until > now()) s else null
    }

    private fun put(title: String, slot: String, rows: List<Source>, vm: StreamsResponse?, expiry: Long?, ttlMs: Long = TTL_MS, partial: Boolean = false, configFingerprint: String? = null) {
        val at = now()
        val until = minOf(at + ttlMs, (expiry ?: Long.MAX_VALUE) - EXPIRY_SKEW_MS)
        if (until <= at) return
        synchronized(lock) {
            load()
            val old = titles.remove(title)?.slots.orEmpty()
            titles[title] = Title(at, old + (slot to Slot(at, until, rows, vm, partial, configFingerprint)))
            prune(at)
            save()
        }
    }

    private fun edit(title: String, change: (Map<String, Slot>) -> Map<String, Slot>) = synchronized(lock) {
        load()
        val t = titles[title] ?: return@synchronized
        val slots = change(t.slots)
        if (slots.size == t.slots.size) return@synchronized
        if (slots.isEmpty()) titles.remove(title) else titles[title] = t.copy(slots = slots)
        save()
    }

    /** Drops ended slots and titles, then the oldest titles past [MAX_TITLES]. Caller holds [lock]. */
    private fun prune(at: Long) {
        val it = titles.entries.iterator()
        while (it.hasNext()) {
            val e = it.next()
            val keep = e.value.slots.filterValues { s -> s.until > at }
            if (keep.isEmpty()) it.remove() else if (keep.size != e.value.slots.size) e.setValue(e.value.copy(slots = keep))
        }
        while (titles.size > MAX_TITLES) titles.remove(titles.keys.first())
    }

    private fun load() {
        if (loaded) return
        loaded = true
        val raw = kv?.get(KV_KEY) ?: return
        val stored = runCatching { json.decodeFromString(ser, raw) }.getOrNull() ?: return
        stored.entries.sortedBy { it.value.at }.forEach { (k, v) -> titles[k] = v }
        prune(now())
    }

    private fun save() {
        val store = kv ?: return
        runCatching { store.put(KV_KEY, if (titles.isEmpty()) null else json.encodeToString(ser, titles)) }
    }

    /** Titles held now (tests). */
    internal fun titleKeys(): List<String> = synchronized(lock) { load(); titles.keys.toList() }

    companion object {
        /** How long resolved rows are reused on this device (owner: at least 20-30 min). */
        const val TTL_MS = 30 * 60 * 1000L
        /** A partial answer's rows are reused this long (coordinator 2026-11-22: 5 min). */
        const val PARTIAL_TTL_MS = 5 * 60 * 1000L
        const val MAX_TITLES = 50
        /** A row is treated as dead this long before its url's stated expiry (lib/urlExpiry.js DEFAULT_SKEW_MS). */
        const val EXPIRY_SKEW_MS = 30_000L
        const val KV_KEY = "streamCache.v1"
        const val PREFS_FILE = "chitram.streams"
        private const val VM = "vm"
        private const val VM_FULL = "vm:full"
        private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

        fun key(type: String, id: Long, season: Int, episode: Int): String =
            "${if (type == "tv" || type == "series") "tv" else "movie"}:$id:$season:$episode"

        private fun deviceSlot(name: String, preferred: String) = "d:$name:${preferred.lowercase()}"
    }
}

/**
 * Port of lib/urlExpiry.js urlExpiresAt, with the `exp`/`expires` names the
 * NetMirror and OneTouchTV resolvers already read. Epoch ms at which the url
 * stops working, or null when it states none. Proxied urls are decoded so the
 * upstream's own expiry is found; the earliest candidate wins. A number outside
 * 30 days back .. 366 days ahead is not an expiry.
 */
object UrlExpiry {
    /** Names read case-insensitively, as lib/urlExpiry.js does (`/gi`): CastleTV signs with `Expires=`. */
    private val PARAM = Regex("""(?:^|[?&#;])(?:e|exp|expire|expires)=(\d{9,13})(?=$|[&#;])""", RegexOption.IGNORE_CASE)
    private val TOKEN = Regex("""internal_token=v\d+\.(\d{13})(?!\d)""")
    private const val MAX_PAST_MS = 30L * 24 * 60 * 60 * 1000
    private const val MAX_FUTURE_MS = 366L * 24 * 60 * 60 * 1000

    fun at(url: String, now: Long): Long? {
        if (url.isEmpty()) return null
        var best: Long? = null
        fun consider(digits: String) {
            val n = digits.toLongOrNull() ?: return
            val ms = if (digits.length >= 12) n else n * 1000
            if (ms < now - MAX_PAST_MS || ms > now + MAX_FUTURE_MS) return
            if (best == null || ms < best!!) best = ms
        }
        for (s in decodedForms(url)) {
            Regex("https?://", RegexOption.IGNORE_CASE).findAll(s).forEach { start ->
                runCatching { java.net.URI(s.substring(start.range.first).substringBefore(' ').substringBefore('\"').substringBefore(39.toChar())) }.getOrNull()?.let { uri ->
                    if (uri.host?.let { it.equals("interkh.com", true) || it.lowercase().endsWith(".interkh.com") } == true) {
                        uri.rawQuery.orEmpty().split('&').firstOrNull { it.startsWith("t=") }?.removePrefix("t=")?.let(::consider)
                    }
                }
            }
            PARAM.findAll(s).forEach { consider(it.groupValues[1]) }
            TOKEN.findAll(s).forEach { consider(it.groupValues[1]) }
        }
        cloudFrontPolicyExpiry(url)?.let { consider(it.toString()) }
        return best
    }

    /**
     * CloudFront custom policy (MultiMovies sacdn, 1.2.50): `Policy=` is the
     * policy JSON in CloudFront base64 (`-` `_` `~` for `+` `=` `/`); its
     * DateLessThan AWS:EpochTime is when the signature stops working.
     */
    private fun cloudFrontPolicyExpiry(url: String): Long? {
        val raw = CF_POLICY.find(url)?.groupValues?.get(1) ?: return null
        val b64 = java.net.URLDecoder.decode(raw, "UTF-8").replace('-', '+').replace('_', '=').replace('~', '/')
        val json = runCatching { okio.ByteString.Companion.run { b64.decodeBase64() }?.utf8() }.getOrNull() ?: return null
        return CF_EPOCH.find(json)?.groupValues?.get(1)?.toLongOrNull()
    }
    private val CF_POLICY = Regex("""[?&]Policy=([^&#]+)""")
    private val CF_EPOCH = Regex(""""DateLessThan"\s*:\s*\{\s*"AWS:EpochTime"\s*:\s*(\d{9,13})""")

    private fun decodedForms(url: String): List<String> {
        val forms = mutableListOf(url)
        var cur = url
        repeat(3) {
            val next = runCatching { java.net.URLDecoder.decode(cur, "UTF-8") }.getOrNull() ?: return forms
            if (next == cur) return forms
            forms += next
            cur = next
        }
        return forms
    }
}
