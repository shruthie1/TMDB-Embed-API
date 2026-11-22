package com.chitram.app.ui.common

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.chitram.app.App
import com.chitram.app.data.BrowseFilters
import com.chitram.app.data.Episode
import com.chitram.app.data.LanguagePrefs
import com.chitram.app.data.PersonResponse
import com.chitram.app.data.Progress
import com.chitram.app.data.SeasonInfo
import com.chitram.app.data.Title
import com.chitram.app.data.TitleFull
import com.chitram.app.player.PlayRequest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * One home row. `progress` is set only on Continue watching. `thin` hides a
 * row that has fewer titles than that after cross-row dedupe (web homeRows).
 */
data class Row(
    val kind: String,
    val label: String,
    val titles: List<Title> = emptyList(),
    val progress: Map<String, Progress> = emptyMap(),
    val loading: Boolean = true,
    val ranked: Boolean = false,
    val thin: Int = 1,
    val error: Boolean = false,
    val rec: Boolean = false,
    /** "See all" target; null for rows without one. */
    val seeAll: BrowseFilters? = null,
    /** Shown once loaded this session: stays on Home so rows never collapse under the viewer. */
    val keep: Boolean = false,
) {
    val personal: Boolean get() = kind == "continue" || kind == "list"

    /** Web Home: hide an empty personal row, a thin row, and an empty row. */
    val shown: Boolean get() = when {
        keep -> true
        error -> !rec
        loading -> !personal
        else -> titles.size >= maxOf(thin, 1)
    }
}

object HomeRows {
    /** Genre rows on Home (web GENRE_ROWS). */
    val GENRES = listOf(28 to "Action", 53 to "Thrillers", 35 to "Comedy", 10749 to "Romance", 10751 to "Family")

    /**
     * Port of web/lib/homeRows.js: Continue watching, Top 10, New on OTT,
     * Trending, then per language "Latest X movies" and "Popular X shows",
     * genre rows, My list, Coming soon. `chosen` empty means every language.
     */
    fun plan(chosen: List<String>): List<Row> {
        val langs = chosen.ifEmpty { LanguagePrefs.LANGS.map { it.code } }
        return buildList {
            add(Row("continue", "Continue watching", loading = false))
            add(Row("top10", "Top 10 in India today", ranked = true, thin = 5))
            add(Row("recent", "New on OTT", thin = 4, seeAll = BrowseFilters(langs = langs, sort = "primary_release_date.desc")))
            add(Row("trending", "Trending now", thin = 4, seeAll = BrowseFilters()))
            for (c in langs) {
                val l = LanguagePrefs.label(c)
                add(Row(c, "Latest $l movies", thin = 4, seeAll = BrowseFilters(langs = listOf(c))))
                add(Row("series-$c", "Popular $l shows", thin = 6, seeAll = BrowseFilters(type = "tv", langs = listOf(c))))
            }
            for ((id, l) in GENRES) add(Row("genre-$id", l, thin = 6, seeAll = BrowseFilters(langs = langs, genres = listOf(id))))
            add(Row("list", "My list", loading = false))
            add(Row("upcoming", "Coming soon", thin = 4))
        }
    }

    /**
     * "Because you watched" rows: the first after Trending now, the next ones
     * after the first and second "Popular X shows" rows (web Home `display`).
     */
    fun withRecs(base: List<Row>, recs: List<Row>): List<Row> {
        val anchors = listOf("trending") + base.filter { it.kind.startsWith("series-") }.map { it.kind }
        val out = ArrayList<Row>()
        for (r in base) {
            out += r
            val at = anchors.indexOf(r.kind)
            if (at >= 0 && at < recs.size) out += recs[at]
        }
        return out
    }

    /**
     * Each title shows once, in the first row that has it (web dedupeRows).
     * Personal rows and the ranked Top 10 keep every title but still claim them.
     */
    fun dedupe(rows: List<Row>, raw: Map<String, List<Title>>): List<Row> {
        val seen = HashSet<String>()
        return rows.map { r ->
            val src = if (r.personal) r.titles else raw[r.kind] ?: return@map r
            val out = if (r.personal || r.ranked) src else src.filter { it.key !in seen }
            out.forEach { seen += it.key }
            r.copy(titles = out)
        }
    }

    /**
     * Home must not move under the viewer. A row that showed loaded stays shown
     * for the session, even when Continue watching later claims some of its titles
     * and it falls under its thin limit. [kept] records the rows (by kind).
     */
    fun keepShown(rows: List<Row>, kept: MutableSet<String>): List<Row> = rows.map { r ->
        // An emptied personal row (the viewer cleared it) still hides.
        if (r.kind in kept && !r.shown && !(r.personal && r.titles.isEmpty())) r.copy(keep = true) else r
    }.onEach { r -> if (r.shown && !r.loading) kept += r.kind }

    /** Hero pool (web Home): Continue watching, Top 10, Trending; with a backdrop; 6. */
    fun heroPool(cont: List<Title>, top10: List<Title>, trending: List<Title>): List<Title> =
        (cont + top10 + trending).filter { !it.backdrop.isNullOrEmpty() }.distinctBy { it.key }.take(6)

    /**
     * Continue watching cards. The overview comes from the saved progress, else
     * from `known` (catalogue rows, My list or a fetched title), so the TV hero
     * has its overview line.
     */
    fun continueTitles(cw: List<Progress>, known: (String) -> String?): List<Title> = cw.map {
        val key = "${it.mediaType}:${it.tmdbId}"
        Title(it.tmdbId, it.mediaType, it.title, it.poster, it.backdrop, overview = it.overview ?: known(key))
    }
}

class HomeVm : ViewModel() {
    private val g = App.instance
    /** Every planned row, deduplicated; render `rows.filter { it.shown }`. */
    var rows by mutableStateOf<List<Row>>(emptyList()); private set
    /** null until Continue watching and Top 10 are in (web shows a skeleton). */
    var heroTitles by mutableStateOf<List<Title>?>(null); private set
    private var loadedFor: List<String>? = null
    private var base: List<Row> = emptyList()
    private var recs: List<Row> = emptyList()
    /** Rows shown loaded this session (HomeRows.keepShown); reset when languages change. */
    private val kept = HashSet<String>()

    /** Raw catalogue rows as fetched; `rows` shows them deduplicated in order. */
    private val raw = HashMap<String, List<Title>>()
    private val failed = HashSet<String>()
    private val overviews = HashMap<String, String>()
    private val overviewAsked = HashSet<String>()

    fun load(force: Boolean = false) {
        val chosen = g.prefs.langs()
        if (!force && loadedFor == chosen) { refreshLocal(); return }
        loadedFor = chosen
        raw.clear(); failed.clear(); recs = emptyList(); kept.clear()
        base = HomeRows.plan(chosen)
        heroTitles = null
        rebuild()
        refreshLocal()
        for (r in base) if (!r.personal) fetch(r.kind)
        loadRecs()
    }

    fun retry(kind: String) {
        failed.remove(kind)
        raw.remove(kind)
        rebuild()
        fetch(kind)
    }

    private fun fetch(kind: String) {
        viewModelScope.launch {
            val res = runCatching { g.api.row(kind, g.prefs.query()) }
            res.onSuccess { raw[kind] = it }.onFailure { if (it is CancellationException) throw it; failed += kind }
            rebuild()
        }
    }

    private fun loadRecs() {
        val seeds = g.progress.seeds(3)
        if (seeds.isEmpty()) return
        viewModelScope.launch {
            val out = ArrayList<Row>()
            for (s in seeds) {
                val t = runCatching { g.api.similar(s.mediaType, s.tmdbId) }.getOrNull().orEmpty()
                if (t.isEmpty()) continue
                val kind = "rec-${s.mediaType}-${s.tmdbId}"
                raw[kind] = t
                out += Row(kind, "Because you watched ${s.title}", thin = 4, rec = true)
            }
            recs = out
            rebuild()
        }
    }

    private var local = HashMap<String, Row>()

    private fun rebuild() {
        val planned = HomeRows.withRecs(base, recs).map { r ->
            local[r.kind] ?: r.copy(loading = r.kind !in raw && r.kind !in failed, error = r.kind in failed)
        }
        rows = HomeRows.keepShown(HomeRows.dedupe(planned, raw), kept)
        // Web waits for Continue watching and Top 10, then fills from Trending.
        if ("top10" in raw || "top10" in failed) {
            val pool = HomeRows.heroPool(local["continue"]?.titles.orEmpty(), raw["top10"].orEmpty(), raw["trending"].orEmpty())
            if (pool != heroTitles) heroTitles = pool
        }
    }

    fun refreshLocal() {
        val cw = g.progress.continueWatching()
        val listed = g.myList.all()
        val titles = HomeRows.continueTitles(cw) { key ->
            overviews[key] ?: raw.values.firstNotNullOfOrNull { l -> l.firstOrNull { it.key == key }?.overview }
                ?: listed.firstOrNull { it.key == key }?.overview
        }
        // Progress saved before 1.0.1 has no overview: fetch it once (HTTP-cached).
        titles.filter { it.overview == null && overviewAsked.add(it.key) }.forEach { t ->
            viewModelScope.launch {
                runCatching { g.api.titleFull(t.mediaType, t.tmdbId) }.getOrNull()?.overview?.let {
                    overviews[t.key] = it
                    refreshLocal()
                }
            }
        }
        local["continue"] = Row("continue", "Continue watching", titles, cw.associateBy { "${it.mediaType}:${it.tmdbId}" }, loading = false)
        local["list"] = Row("list", "My list", listed, loading = false)
        rebuild()
    }

    /** First catalogue title: the TV hero before anything is focused. */
    val hero: Title?
        get() = heroTitles?.firstOrNull() ?: rows.firstOrNull { !it.personal && it.titles.isNotEmpty() }?.titles?.firstOrNull()
}

class DetailVm : ViewModel() {
    private val g = App.instance
    var full by mutableStateOf<TitleFull?>(null); private set
    var error by mutableStateOf<String?>(null); private set
    var season by mutableStateOf(1); private set
    var episodes by mutableStateOf<List<Episode>>(emptyList()); private set
    var episodesLoading by mutableStateOf(false); private set
    var inList by mutableStateOf(false); private set
    var resume by mutableStateOf<Progress?>(null); private set
    /** "More like this"; null while loading. */
    var similar by mutableStateOf<List<Title>?>(null); private set
    private var key: String? = null
    private var epJob: Job? = null

    fun load(type: String, id: Long) {
        val k = "$type:$id"
        if (key == k) { refreshLocal(); return }
        key = k
        viewModelScope.launch {
            similar = runCatching { g.api.similar(type, id) }.getOrDefault(emptyList())
        }
        viewModelScope.launch {
            val t = runCatching { g.api.titleFull(type, id) }.onFailure { android.util.Log.w("Chitram", "title $type/$id failed", it); error = "Could not load this title." }.getOrNull() ?: return@launch
            full = t
            refreshLocal()
            // Prewarm (prewarm.md): same title and language Play passes (playRequest).
            if (t.mediaType != "tv") prewarm(t, 0, 0)
            if (t.mediaType == "tv") {
                val next = g.progress.nextUp(t.tmdbId, t.seasonList)
                // A show's Play needs the season list: prewarm the episode Play opens.
                val (ps, pe) = prefetchEpisode(next, t.seasonList)
                prewarm(t, ps, pe)
                selectSeason(next?.season?.takeIf { s -> t.seasonList.any { it.number == s } } ?: t.seasonList.firstOrNull { it.number > 0 }?.number ?: 1)
            }
        }
    }

    /**
     * Fire-and-forget on-device resolve of the config's prewarm providers, off the
     * main thread. No VM call: Play reuses the jobs, the VM is asked only on Play.
     * Never blocks the page; any failure is dropped and Play resolves as usual.
     */
    private fun prewarm(t: TitleFull, season: Int, episode: Int) {
        warmed = t.mediaType to t.tmdbId
        viewModelScope.launch(Dispatchers.IO) {
            runCatching { g.onDevice.prewarm(t.mediaType, t.tmdbId, season, episode, g.codecs, g.prefs.preferredAudio(), t.title, t.originalLang) }
                .onFailure { android.util.Log.i("Chitram", "prewarm: skipped: ${it.javaClass.simpleName}") }
        }
    }
    private var warmed: Pair<String, Long>? = null

    /** Page gone (back out): jobs Play did not take are cancelled; a job Play took is untouched. */
    override fun onCleared() {
        warmed?.let { (type, id) -> runCatching { g.onDevice.cancelPrewarm(type, id) } }
    }

    companion object {
        /** The episode Play opens with no tap on an episode: next up, else S(first)E1 (playRequest). */
        fun prefetchEpisode(next: Progress?, seasons: List<SeasonInfo>?): Pair<Int, Int> =
            next?.let { it.season to it.episode }
                ?: ((seasons.orEmpty().firstOrNull { it.number > 0 }?.number ?: 1) to 1)
    }

    fun retry() {
        val k = key ?: return
        key = null
        error = null
        val (type, id) = k.split(":")
        load(type, id.toLong())
    }

    fun refreshLocal() {
        val t = full ?: return
        inList = g.myList.contains(t.asTitle())
        resume = if (t.mediaType == "tv") g.progress.nextUp(t.tmdbId, t.seasonList)
        else g.progress.get(t.mediaType, t.tmdbId)?.takeIf { !it.finished && it.positionMs > 0 }
    }

    fun selectSeason(n: Int) {
        val t = full ?: return
        season = n
        epJob?.cancel()
        episodesLoading = true
        epJob = viewModelScope.launch {
            episodes = runCatching { g.api.season(t.tmdbId, n) }.getOrDefault(emptyList())
            episodesLoading = false
        }
    }

    fun toggleList(): Boolean { full?.let { inList = g.myList.toggle(it.asTitle()) }; return inList }

    fun episodeProgress(ep: Episode): Progress? = full?.let { g.progress.get("tv", it.tmdbId, ep.season, ep.episode) }

    /** Play label, as on the web title page. */
    fun playLabel(): String {
        val t = full ?: return "Play"
        val r = resume
        return when {
            t.mediaType != "tv" -> if (r != null) "Resume" else "Play"
            r == null -> "Play S1 E1"
            r.positionMs > 0 -> "Resume S${r.season} E${r.episode}"
            else -> "Play S${r.season} E${r.episode}"
        }
    }

    /** True when Start over makes sense: a saved position mid-way. */
    val canStartOver: Boolean get() = (resume?.positionMs ?: 0) > 0

    fun playRequest(ep: Episode? = null, fromStart: Boolean = false): PlayRequest? {
        val t = full ?: return null
        if (t.mediaType != "tv") return PlayRequest("movie", t.tmdbId, t.title, poster = t.poster, backdrop = t.backdrop, overview = t.overview, fromStart = fromStart, imdbId = t.imdbId, runtimeMin = t.runtimeMin, originalLang = t.originalLang)
        val e = ep ?: resume?.let { r -> Episode(r.episode, r.season, r.epTitle ?: episodes.firstOrNull { it.season == r.season && it.episode == r.episode }?.title ?: "") }
            ?: episodes.firstOrNull() ?: Episode(1, season)
        return PlayRequest("tv", t.tmdbId, t.title, e.season, e.episode, t.poster, t.backdrop, e.title.ifEmpty { null }, t.seasonList, t.overview, fromStart = fromStart, imdbId = t.imdbId, runtimeMin = e.runtimeMin ?: t.runtimeMin, originalLang = t.originalLang)
    }
}

class PersonVm : ViewModel() {
    private val g = App.instance
    /** null while loading; `person == null` inside means not found or failed. */
    var data by mutableStateOf<PersonResponse?>(null); private set
    private var id = 0L

    fun load(personId: Long) {
        if (id == personId) return
        id = personId
        viewModelScope.launch {
            data = runCatching { g.api.person(personId) }.getOrDefault(PersonResponse())
        }
    }
}

class BrowseVm : ViewModel() {
    private val g = App.instance
    var filters by mutableStateOf(BrowseFilters()); private set
    var titles by mutableStateOf<List<Title>>(emptyList()); private set
    var total by mutableStateOf<Int?>(null); private set
    var loading by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null); private set
    private var page = 0
    private var totalPages = 1
    private var job: Job? = null
    private var started = false

    val hasMore: Boolean get() = page < totalPages

    /** First open: filters from a row's "See all", else the defaults. */
    fun start(initial: BrowseFilters) {
        if (started) return
        started = true
        set(initial)
    }

    fun set(f: BrowseFilters) {
        filters = f
        page = 0
        totalPages = 1
        titles = emptyList()
        total = null
        loadMore(reset = true)
    }

    fun loadMore(reset: Boolean = false) {
        if (!reset && (loading || !hasMore)) return
        job?.cancel()
        val f = filters
        val next = page + 1
        loading = true
        error = null
        job = viewModelScope.launch {
            try {
                val r = g.api.discover(f, next)
                // Pages can repeat a title; keep the first.
                titles = (titles + r.titles).distinctBy { it.key }
                page = next
                totalPages = r.totalPages
                total = r.totalResults
            } catch (e: CancellationException) { throw e } catch (e: Exception) {
                error = "Could not load titles."
            }
            loading = false
        }
    }

    fun retry() = if (titles.isEmpty()) set(filters) else loadMore()
}

class SearchVm : ViewModel() {
    private val g = App.instance
    var query by mutableStateOf(""); private set
    var results by mutableStateOf<List<Title>>(emptyList()); private set
    /** The trimmed query `results` belong to; lags `query` while debouncing. */
    var resultsFor by mutableStateOf(""); private set
    var loading by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null); private set
    var recent by mutableStateOf(g.recent.all()); private set
    private var job: Job? = null

    fun onQuery(q: String) {
        query = q
        search(debounceMs = 300) // debounce typing on the on-screen keyboard
    }

    /** IME Search: run now, skipping the debounce, unless done or in flight. */
    fun submit() {
        val q = query.trim()
        remember(q)
        if ((resultsFor == q && !loading) || inFlight == q) return
        search(debounceMs = 0)
    }
    private var inFlight: String? = null
    /** Try again after a failed search (submit skips a query that already has an answer). */
    fun retry() = search(debounceMs = 0)

    /** Saved when the viewer submits or opens a result, not on every keystroke. */
    fun remember(q: String = query) { g.recent.add(q); recent = g.recent.all() }
    fun forget(q: String) { g.recent.remove(q); recent = g.recent.all() }
    fun clearRecent() { g.recent.clear(); recent = emptyList() }

    private fun search(debounceMs: Long) {
        val q = query.trim()
        job?.cancel()
        if (q.length < 2) { results = emptyList(); resultsFor = q; loading = false; error = null; return }
        job = viewModelScope.launch {
            delay(debounceMs)
            loading = true
            error = null
            inFlight = q
            // A newer query cancels this job: let that through, it is not a failure.
            val found = try { g.api.search(q, g.prefs.effective()) }
                catch (e: CancellationException) { throw e }
                catch (e: Exception) { null }
                finally { if (inFlight == q) inFlight = null }
            if (found == null) error = "Search failed. Check the connection."
            results = found ?: emptyList()
            resultsFor = q
            loading = false
        }
    }
}

/** TV Search focus: move to the first card once results for this query are in. */
object SearchFocus {
    fun ready(pending: Boolean, query: String, resultsFor: String, loading: Boolean, count: Int): Boolean =
        pending && !loading && count > 0 && resultsFor == query.trim()
}
