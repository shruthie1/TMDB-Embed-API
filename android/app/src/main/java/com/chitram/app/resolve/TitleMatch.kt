package com.chitram.app.resolve

import java.text.Normalizer

/**
 * Port of utils/titleMatch.js (searchSpellings, findTitleMatch): which search
 * spellings to try, and which result row is the same title. Strict on purpose:
 * a wrong film is worse than no row.
 */
object TitleMatch {
    private val ORDINALS = mapOf(
        "i" to 1, "ii" to 2, "iii" to 3, "iv" to 4, "v" to 5,
        "one" to 1, "two" to 2, "three" to 3, "four" to 4, "five" to 5,
        "first" to 1, "second" to 2, "third" to 3, "fourth" to 4, "fifth" to 5,
    )
    private val SUFFIX_NOISE = Regex("""^(?:part|chapter|vol|volume|book|season|pt)?\s*\d*\s*$""")
    private val PART_SUFFIX = Regex("""^(?:part|chapter|vol|volume|book|season|pt)\s*([0-9]+|[a-z]+)\b(.*)$""")
    private const val LANG_WORDS = "hindi|telugu|tamil|malayalam|kannada|english|bengali|marathi|punjabi|gujarati|urdu|odia|assamese|bhojpuri|dubbed|dub"
    private const val EDITION_WORDS = "reloaded|extended|uncut|remastered|restored|theatrical|director's|directors|special|deluxe|final"
    private val LANGUAGE_TAG = Regex(
        """\s*[\(\[]\s*(?:$LANG_WORDS|(?:[a-z']+\s+)?(?:$EDITION_WORDS)(?:\s+(?:version|cut|edition))?|(?:$EDITION_WORDS)?\s*(?:version|cut|edition))\s*[\)\]]\s*$|\s*\b(?:$LANG_WORDS)\s*$""",
        RegexOption.IGNORE_CASE,
    )
    private val LEADING_ARTICLE = Regex("""^(?:the|a|an)\s+""")

    private fun partNumber(rest: String): Int? {
        val m = PART_SUFFIX.find(rest.trim()) ?: return null
        val tok = m.groupValues[1]
        return tok.toIntOrNull() ?: ORDINALS[tok]
    }

    fun stripLanguageTag(v: String): String {
        var out = v
        while (true) { val next = out.replace(LANGUAGE_TAG, "").trim(); if (next == out) return out; out = next }
    }

    fun deaccent(v: String): String = Normalizer.normalize(v, Normalizer.Form.NFD).replace(Regex("[\\u0300-\\u036f]"), "")

    fun normalize(v: String): String = deaccent(v).lowercase().replace("&", " and ").replace(Regex("[^a-z0-9]+"), " ").trim()

    private fun loose(v: String) = normalize(v).replace(Regex("([aeiou])\\1+"), "$1")
    private fun withoutArticle(v: String) = v.replace(LEADING_ARTICLE, "").trim()

    private fun isPrefixWithSuffixNoise(row: String, want: String): Boolean {
        if (row.isEmpty() || want.isEmpty()) return false
        val (short, long) = if (row.length <= want.length) row to want else want to row
        if (short.length < 4) return false // "RRR" must match exactly
        if (short == long) return true
        if (!long.startsWith("$short ")) return false
        val rest = long.substring(short.length).trim()
        return SUFFIX_NOISE.matches(rest) || partNumber(rest) != null
    }

    private fun splitPart(v: String): Pair<String, Int?> {
        val m = Regex("""^(.*?)\s+((?:part|chapter|vol|volume|book|season|pt)\s+(?:[0-9]+|[a-z]+))(?:\s+.*)?$""").find(v.trim())
            ?: return v.trim() to null
        val part = partNumber(m.groupValues[2]) ?: return v.trim() to null
        return m.groupValues[1].trim() to part
    }

    private fun samePart(a: String, b: String): Boolean {
        val (ba, pa) = splitPart(a)
        val (bb, pb) = splitPart(b)
        if (pa == null || pb == null || pa != pb || ba.length < 4) return false
        return ba == bb
    }

    private fun conflictingParts(a: String, b: String): Boolean {
        val shorter = if (a.length <= b.length) a else b
        val pa = partNumber(if (a.startsWith(shorter)) a.substring(shorter.length).trim() else "")
        val pb = partNumber(if (b.startsWith(shorter)) b.substring(shorter.length).trim() else "")
        return pa != null && pb != null && pa != pb
    }

    /** Search spellings, most specific first (searchSpellings). */
    fun spellings(title: String, year: Int? = null): List<String> {
        val raw = title.trim()
        if (raw.isEmpty()) return emptyList()
        val out = ArrayList<String>()
        fun add(v: String) { val t = v.trim(); if (t.isNotEmpty() && t !in out) out += t }
        val plain = deaccent(raw)
        fun depunct(v: String) = v.replace(Regex("[-\\u2013\\u2014:]"), " ").replace(Regex("\\s+"), " ").trim()
        if (year != null) { add("$raw $year"); add("$plain $year") }
        add(raw); add(plain); add(depunct(raw)); add(depunct(plain))
        val headRaw = raw.split(Regex("[:\\u2013\\u2014]"))[0].trim()
        val headPlain = deaccent(headRaw)
        add(depunct(headRaw)); add(headRaw); add(headPlain)
        if (headPlain.isNotEmpty() && Regex("^[a-z]+$", RegexOption.IGNORE_CASE).matches(headPlain)) {
            Regex("^([b-df-hj-np-tv-z]*)([aeiou])(.*)$", RegexOption.IGNORE_CASE).find(headPlain)?.let { m ->
                add(m.groupValues[1] + m.groupValues[2] + m.groupValues[2] + m.groupValues[3])
            }
        }
        return out
    }

    /** Title with every space and punctuation mark gone: "Ala Vaikunthapurramuloo" = "Alavaikunthapurramuloo". */
    private fun compact(v: String) = normalize(stripLanguageTag(v)).replace(" ", "")

    /**
     * Telugu transliteration fold on top of [compact]: a glide y before i drops
     * ("Mirayi" = "Mirai") and doubled vowels collapse ("Baahubali" = "Bahubali").
     * Narrow on purpose: "Maya" stays "maya", never "ma".
     */
    private fun fold(v: String) = compact(v).replace(Regex("([aeiou])y(i)"), "$1$2").replace(Regex("([aeiou])\\1+"), "$1")

    /**
     * The row that is the same title, or null. First the strict server passes
     * on the title ([strict], findTitleMatch). Then, only among rows whose year
     * is within one of [year] (when both are known): the [alternates] (original
     * title) through the strict passes, then a [compact] compare, then a [fold]
     * compare, for the title and each alternate. Shorter than 4 letters never
     * matches loosely.
     */
    fun <T> find(
        rows: List<T>,
        title: String,
        alternates: List<String> = emptyList(),
        year: Int? = null,
        getYear: (T) -> Int? = { null },
        getTitle: (T) -> String,
    ): T? {
        strict(rows, title, getTitle)?.let { return it }
        val near = rows.filter { r -> val y = getYear(r); year == null || y == null || kotlin.math.abs(y - year) <= 1 }
        if (near.isEmpty()) return null
        val names = (listOf(title) + alternates).map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        for (n in names.drop(1)) strict(near, n, getTitle)?.let { return it }
        for (key in listOf(::compact, ::fold)) {
            for (n in names) {
                val want = key(n)
                if (want.length < 4) continue
                near.firstOrNull { key(getTitle(it)) == want }?.let { return it }
            }
        }
        return null
    }

    /** The server's passes (findTitleMatch). */
    private fun <T> strict(rows: List<T>, title: String, getTitle: (T) -> String): T? {
        val want = normalize(title)
        if (rows.isEmpty() || want.isEmpty()) return null
        val wantLoose = loose(title)
        val wantBare = withoutArticle(want)
        fun rowNorm(r: T) = normalize(stripLanguageTag(getTitle(r)))
        fun rowLoose(r: T) = loose(stripLanguageTag(getTitle(r)))
        val passes: List<(T) -> Boolean> = listOf(
            { r -> rowNorm(r) == want },
            { r -> rowLoose(r) == wantLoose },
            { r -> withoutArticle(rowNorm(r)) == wantBare },
            { r -> samePart(rowNorm(r), want) },
            { r -> !conflictingParts(rowNorm(r), want) && isPrefixWithSuffixNoise(rowNorm(r), want) },
            { r -> !conflictingParts(rowLoose(r), wantLoose) && isPrefixWithSuffixNoise(rowLoose(r), wantLoose) },
        )
        for (p in passes) rows.firstOrNull(p)?.let { return it }
        return null
    }
}
