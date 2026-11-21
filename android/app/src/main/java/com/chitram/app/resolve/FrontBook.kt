package com.chitram.app.resolve

import com.chitram.app.data.KeyValue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * What each mapple front did last, kept on the device ([KeyValue] =
 * SharedPreferences), so a new app start does not relearn it front by front.
 *
 * Order: fronts that last gave the preferred audio (newest first), then fronts
 * that last gave any stream, then the configured order, then fronts that just
 * failed ("last"), then skipped fronts. Skipped = the site said SOURCE_COOLDOWN.
 * A Telugu front moves only on site-wide kinds (see [failed]). A skipped front is started only after every
 * other front has started, never dropped: the race ends at the first Telugu
 * hit, so it costs nothing then, and it can still be the only Telugu front.
 * Every window ends by itself (frontCooldownMs, doubling per repeat, max 10
 * min), and any answer from the front clears it.
 */
class FrontBook(private val kv: KeyValue, private val now: () -> Long = System::currentTimeMillis) {
    private class Entry(
        var okAt: Long = 0, var wantedAt: Long = 0,
        var kind: String? = null, var failAt: Long = 0, var streak: Int = 0,
        var lastUntil: Long = 0, var skipUntil: Long = 0,
    )

    class Plan(val order: List<String>, val last: List<String>, val skipped: List<String>)

    private val entries: MutableMap<String, Entry> = load()

    @Synchronized fun plan(fronts: List<String>): Plan {
        val t = now()
        val all = fronts.distinct()
        val legacy = kv.get(MappleResolver.KEY_FRONT)?.takeIf { it in all }
        val skip = all.filter { (entries[it]?.skipUntil ?: 0L) > t }.let { if (it.size == all.size) emptyList() else it }
        val last = all.filter { it !in skip && (entries[it]?.lastUntil ?: 0L) > t }
        val rest = all.filter { it !in skip && it !in last }
        val wanted = rest.filter { (entries[it]?.wantedAt ?: 0L) > 0 }.sortedByDescending { entries[it]!!.wantedAt }
        val ok = rest.filter { it !in wanted && (entries[it]?.okAt ?: 0L) > 0 }.sortedByDescending { entries[it]!!.okAt }
        val head = (listOfNotNull(legacy?.takeIf { it in rest && wanted.isEmpty() }) + wanted + ok).distinct()
        return Plan(head + rest.filter { it !in head } + last + skip, last, skip)
    }

    @Synchronized fun found(front: String, wanted: Boolean) {
        val e = entries.getOrPut(front) { Entry() }
        clear(e)
        e.okAt = now()
        if (wanted) e.wantedAt = e.okAt
        save()
    }

    /** The front answered (the title is not on it): it is alive. */
    @Synchronized fun notHere(front: String) {
        val e = entries[front] ?: return
        if (e.streak == 0 && e.lastUntil == 0L && e.skipUntil == 0L) return
        clear(e)
        save()
    }

    /**
     * Site-wide kinds (SOURCE_COOLDOWN skips, SOURCE_BUSY goes last) move any front.
     * Per-title kinds (SCRAPE_FAILED, TIMEOUT, SOURCE_TIMEOUT, OTHER) say the title
     * is not on that front: a front that has given Telugu keeps its place, others go
     * last. The streak only grows inside the last window; after it, it starts over.
     */
    @Synchronized fun failed(front: String, kind: String, baseCoolMs: Long) {
        val e = entries.getOrPut(front) { Entry() }
        val t = now()
        val inWindow = t < maxOf(e.lastUntil, e.skipUntil)
        e.streak = if (e.kind == kind && inWindow) e.streak + 1 else 1
        e.kind = kind
        e.failAt = t
        e.lastUntil = 0; e.skipUntil = 0
        val cool = (baseCoolMs shl (e.streak - 1).coerceAtMost(4)).coerceAtMost(MAX_COOL_MS)
        when {
            kind == "SOURCE_COOLDOWN" -> e.skipUntil = t + cool
            kind == "SOURCE_BUSY" -> e.lastUntil = t + cool
            e.wantedAt > 0 -> Unit
            else -> e.lastUntil = t + cool
        }
        save()
    }

    /** Fronts in a window right now (tried last or skipped). */
    @Synchronized fun cooling(): Set<String> {
        val t = now()
        return entries.filter { it.value.lastUntil > t || it.value.skipUntil > t }.keys.toSet()
    }

    private fun clear(e: Entry) { e.kind = null; e.streak = 0; e.lastUntil = 0; e.skipUntil = 0 }

    private fun load(): MutableMap<String, Entry> {
        val root = kv.get(KEY)?.let { runCatching { json.parseToJsonElement(it) as? JsonObject }.getOrNull() } ?: return HashMap()
        val out = HashMap<String, Entry>()
        for ((front, v) in root) {
            val o = v as? JsonObject ?: continue
            fun l(k: String) = (o[k] as? JsonPrimitive)?.longOrNull ?: 0L
            out[front] = Entry(l("ok"), l("te"), (o["fk"] as? JsonPrimitive)?.contentOrNull, l("fa"), l("n").toInt(), l("last"), l("skip"))
        }
        return out
    }

    private fun save() {
        kv.put(KEY, buildJsonObject {
            for ((front, e) in entries) put(front, buildJsonObject {
                if (e.okAt > 0) put("ok", e.okAt)
                if (e.wantedAt > 0) put("te", e.wantedAt)
                e.kind?.let { put("fk", it); put("fa", e.failAt); put("n", e.streak) }
                if (e.lastUntil > 0) put("last", e.lastUntil)
                if (e.skipUntil > 0) put("skip", e.skipUntil)
            })
        }.toString())
    }

    companion object {
        const val KEY = "resolve.mapple.frontbook"
        private const val MAX_COOL_MS = 10 * 60 * 1000L
        private val json = Json { ignoreUnknownKeys = true; isLenient = true }
        private val KIND = Regex("\\b(SOURCE_[A-Z_]+|SCRAPE_[A-Z_]+|UPSTREAM_[A-Z_]+)\\b")

        /** The failure kind in a front's error text: mapple's failureKind, TIMEOUT or OTHER. */
        fun kindOf(message: String?): String = when {
            message == null -> "OTHER"
            KIND.containsMatchIn(message) -> KIND.find(message)!!.value
            message.contains("timed out") -> "TIMEOUT"
            else -> "OTHER"
        }
    }
}
