package com.chitram.app.player

import com.chitram.app.data.Ranking
import com.chitram.app.data.Source
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * Owner request 2026-11-21: the Server menu's nested rows of one provider
 * ("multimovies 1..6, 1080p · Unknown audio") must be told apart. Each row
 * gets a short tag for the host its stream really comes from ("bridge",
 * "rousav"); rows whose tag, languages and quality still match are numbered.
 */
object ServerTag {
    /** Hosting suffixes where the first label, not the domain, names the service. */
    private val SHARED = listOf("workers.dev", "pages.dev", "vercel.app", "netlify.app", "herokuapp.com", "sslip.io", "nip.io")
    /**
     * Longest host tag shown. 12 cut "hakunaymatata" (13, review R2-M3). The
     * longest name label among the providers/ hosts is "nextgencloudfabric" (18).
     */
    internal const val MAX = 18

    /** The upstream of a VM proxy url (/m3u8-proxy?url=); any other url unchanged. A provider's own wrapper (a bridge) is kept: it is the tag. */
    private fun upstream(url: String): String {
        val u = url.toHttpUrlOrNull() ?: return url
        if (!u.encodedPath.endsWith("-proxy")) return url
        return u.queryParameter("url")?.takeIf { it.startsWith("http") } ?: url
    }

    /** Short name for the host the stream comes from (inside the VM proxy), or null. */
    fun host(url: String?): String? {
        if (url.isNullOrBlank()) return null
        val h = runCatching { java.net.URI(upstream(url)).host }.getOrNull()?.lowercase()?.removePrefix("www.") ?: return null
        val labels = h.split('.').filter { it.isNotEmpty() }
        if (labels.size < 2) return labels.firstOrNull()?.take(MAX)
        val shared = SHARED.firstOrNull { h.endsWith(".$it") }
        val name = if (shared != null) labels.first().substringAfterLast('-') else labels[labels.size - 2]
        return name.take(MAX).ifEmpty { null }
    }

    /**
     * Tag per row id for rows of ONE provider. Empty for a single row (its
     * entry needs nothing). The tag uses the direct url when the row has one.
     */
    fun tags(rows: List<Source>): Map<String, String> {
        if (rows.size < 2) return emptyMap()
        val base = rows.associate { it.id to (host(it.directUrl ?: it.url) ?: "") }
        val sameAs = rows.groupBy { Triple(base[it.id], AudioChoice.languages(it), Ranking.height(it)) }
        val out = LinkedHashMap<String, String>()
        for (s in rows) {
            val tag = base[s.id].orEmpty()
            val twins = sameAs.getValue(Triple(base[s.id], AudioChoice.languages(s), Ranking.height(s)))
            val n = if (twins.size > 1) " ${twins.indexOfFirst { it.id == s.id } + 1}" else ""
            val t = (tag + n).trim()
            if (t.isNotEmpty()) out[s.id] = t
        }
        return out
    }
}
