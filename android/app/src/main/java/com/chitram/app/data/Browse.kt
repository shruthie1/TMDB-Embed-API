package com.chitram.app.data

/** Port of web/components/Filters.jsx lists and the browse page's query. */
object BrowseOptions {
    data class Opt<T>(val id: T, val name: String)

    val GENRES = listOf(
        Opt(28, "Action"), Opt(12, "Adventure"), Opt(35, "Comedy"), Opt(80, "Crime"),
        Opt(18, "Drama"), Opt(14, "Fantasy"), Opt(27, "Horror"), Opt(9648, "Mystery"),
        Opt(10749, "Romance"), Opt(878, "Sci-Fi"), Opt(53, "Thriller"), Opt(10751, "Family"),
    )
    val DECADES = listOf(Opt("2020-2029", "2020s"), Opt("2010-2019", "2010s"), Opt("2000-2009", "2000s"), Opt("1990-1999", "90s"))
    val SORTS = listOf(
        Opt("popularity.desc", "Popular"), Opt("vote_average.desc", "Top rated"),
        Opt("primary_release_date.desc", "Newest"), Opt("title.asc", "A–Z"),
    )
    val RATINGS = listOf(7, 8)
}

data class BrowseFilters(
    val type: String = "movie",
    val langs: List<String> = emptyList(),
    val genres: List<Int> = emptyList(),
    val decade: String? = null,
    val minRating: Int? = null,
    val sort: String = "popularity.desc",
) {
    /** /api/discover query, as web/app/browse/page.jsx builds it (decade -> from/to). */
    fun apiQuery(page: Int): String = buildList {
        add("type=$type")
        if (langs.isNotEmpty()) add("lang=${langs.joinToString(",")}")
        if (genres.isNotEmpty()) add("genre=${genres.joinToString(",")}")
        decade?.split("-")?.takeIf { it.size == 2 }?.let { (f, t) -> add("from=$f"); add("to=$t") }
        minRating?.let { add("min=$it") }
        if (sort != "popularity.desc") add("sort=$sort")
        add("page=$page")
    }.joinToString("&")

    /** Active filters as removable chips (web FilterBar). */
    fun active(): List<Pair<String, BrowseFilters>> = buildList {
        langs.forEach { c -> add(LanguagePrefs.label(c) to copy(langs = langs - c)) }
        genres.forEach { g -> add((BrowseOptions.GENRES.firstOrNull { it.id == g }?.name ?: "$g") to copy(genres = genres - g)) }
        decade?.let { d -> add((BrowseOptions.DECADES.firstOrNull { it.id == d }?.name ?: d) to copy(decade = null)) }
        minRating?.let { add("★ $it+" to copy(minRating = null)) }
    }

    fun cleared() = copy(langs = emptyList(), genres = emptyList(), decade = null, minRating = null)
}

/** Recent searches, newest first, max 8 (web/lib/recent.js). */
class RecentSearchStore(private val kv: KeyValue) {
    private val KEY = "recent:v1"
    fun all(): List<String> = kv.get(KEY)?.split('\n')?.filter { it.isNotBlank() } ?: emptyList()
    fun add(q: String) {
        val t = q.trim()
        if (t.length < 2) return
        kv.put(KEY, (listOf(t) + all().filter { !it.equals(t, ignoreCase = true) }).take(MAX).joinToString("\n"))
    }
    fun remove(q: String) = kv.put(KEY, all().filter { it != q }.joinToString("\n").ifEmpty { null })
    fun clear() = kv.put(KEY, null)
    companion object { const val MAX = 8 }
}
