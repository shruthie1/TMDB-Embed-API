package com.chitram.app.ui.common

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.chitram.app.App
import com.chitram.app.data.Episode
import com.chitram.app.data.LanguagePrefs
import com.chitram.app.data.Progress
import com.chitram.app.data.Title
import com.chitram.app.data.TitleFull
import com.chitram.app.player.PlayRequest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** One home row. `progress` is set only on the Continue watching row. */
data class Row(
    val kind: String,
    val label: String,
    val titles: List<Title> = emptyList(),
    val progress: Map<String, Progress> = emptyMap(),
    val loading: Boolean = true,
    val ranked: Boolean = false,
)

object HomeRows {
    /**
     * Order: Continue watching, <primary> new, Trending, Top 10, <secondary>,
     * <primary> series, My List. Primary is Telugu unless the viewer's chosen
     * languages exclude it; secondary is Hindi by default.
     */
    fun plan(chosen: List<String>): List<Row> {
        val primary = if (chosen.isEmpty() || "te" in chosen) "te" else chosen.first()
        val secondary = when {
            chosen.isEmpty() -> "hi"
            else -> chosen.firstOrNull { it != primary }
        }
        val p = LanguagePrefs.label(primary)
        return buildList {
            add(Row("continue", "Continue watching", loading = false))
            add(Row(primary, "New in $p"))
            add(Row("trending", "Trending now"))
            add(Row("top10", "Top 10 in India today", ranked = true))
            if (secondary != null) add(Row(secondary, "Latest ${LanguagePrefs.label(secondary)} movies"))
            add(Row("series-$primary", "Popular $p shows"))
            add(Row("list", "My list", loading = false))
        }
    }

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
    var rows by mutableStateOf<List<Row>>(emptyList()); private set
    var error by mutableStateOf<String?>(null); private set
    private var loadedFor: List<String>? = null

    fun load(force: Boolean = false) {
        val chosen = g.prefs.langs()
        if (!force && loadedFor == chosen) { refreshLocal(); return }
        loadedFor = chosen
        raw.clear()
        rows = HomeRows.plan(chosen)
        refreshLocal()
        val q = g.prefs.query()
        error = null
        for (r in rows) {
            if (r.kind == "continue" || r.kind == "list") continue
            viewModelScope.launch {
                val titles = runCatching { g.api.row(r.kind, if (r.kind in setOf("trending", "top10", "recent")) q else "") }
                    .onFailure { error = "Could not load rows. Check the connection." }
                    .getOrDefault(emptyList())
                raw[r.kind] = titles
                update(r.kind) { it.copy(loading = false) }
            }
        }
    }

    /** Raw catalogue rows as fetched; `rows` shows them deduplicated in order. */
    private val raw = HashMap<String, List<Title>>()
    private val overviews = HashMap<String, String>()
    private val overviewAsked = HashSet<String>()

    /**
     * Drop titles already shown in an earlier catalogue row (web dedupeRows).
     * Recomputed in row order on every update, so the order rows arrive in
     * does not decide which row keeps a title.
     */
    private fun dedupeAll(list: List<Row>): List<Row> {
        val seen = HashSet<String>()
        return list.map { r ->
            if (r.kind == "continue" || r.kind == "list") return@map r
            val src = raw[r.kind] ?: return@map r
            val out = if (r.ranked) src else src.filter { it.key !in seen }
            out.forEach { seen += it.key }
            r.copy(titles = out)
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
        update("continue") { r ->
            r.copy(
                titles = titles,
                progress = cw.associateBy { "${it.mediaType}:${it.tmdbId}" },
                loading = false,
            )
        }
        update("list") { it.copy(titles = listed, loading = false) }
    }

    private fun update(kind: String, f: (Row) -> Row) {
        rows = dedupeAll(rows.map { if (it.kind == kind) f(it) else it })
    }

    /** Hero: the first title in the first loaded catalogue row. */
    val hero: Title?
        get() = rows.firstOrNull { it.kind != "continue" && it.kind != "list" && it.titles.isNotEmpty() }?.titles?.firstOrNull()
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
    private var key: String? = null
    private var epJob: Job? = null

    fun load(type: String, id: Long) {
        val k = "$type:$id"
        if (key == k) { refreshLocal(); return }
        key = k
        viewModelScope.launch {
            val t = runCatching { g.api.titleFull(type, id) }.onFailure { error = "Could not load this title." }.getOrNull() ?: return@launch
            full = t
            refreshLocal()
            if (t.mediaType == "tv") {
                val next = g.progress.nextUp(t.tmdbId, t.seasonList)
                selectSeason(next?.season?.takeIf { s -> t.seasonList.any { it.number == s } } ?: t.seasonList.firstOrNull { it.number > 0 }?.number ?: 1)
            }
        }
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
            val deferred = async { runCatching { g.api.season(t.tmdbId, n) }.getOrDefault(emptyList()) }
            episodes = deferred.await()
            episodesLoading = false
        }
    }

    fun toggleList() { full?.let { inList = g.myList.toggle(it.asTitle()) } }

    fun episodeProgress(ep: Episode): Progress? = full?.let { g.progress.get("tv", it.tmdbId, ep.season, ep.episode) }

    fun playRequest(ep: Episode? = null): PlayRequest? {
        val t = full ?: return null
        if (t.mediaType != "tv") return PlayRequest("movie", t.tmdbId, t.title, poster = t.poster, backdrop = t.backdrop, overview = t.overview)
        val e = ep ?: resume?.let { r -> Episode(r.episode, r.season, r.epTitle ?: "") } ?: episodes.firstOrNull() ?: Episode(1, season)
        return PlayRequest("tv", t.tmdbId, t.title, e.season, e.episode, t.poster, t.backdrop, e.title.ifEmpty { null }, t.seasonList, t.overview)
    }
}

class SearchVm : ViewModel() {
    private val g = App.instance
    var query by mutableStateOf(""); private set
    var results by mutableStateOf<List<Title>>(emptyList()); private set
    /** The trimmed query `results` belong to; lags `query` while debouncing. */
    var resultsFor by mutableStateOf(""); private set
    var loading by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null); private set
    private var job: Job? = null

    fun onQuery(q: String) {
        query = q
        search(debounceMs = 350) // debounce typing on the on-screen keyboard
    }

    /** IME Search: run now, skipping the debounce, unless done or in flight. */
    fun submit() {
        val q = query.trim()
        if ((resultsFor == q && !loading) || inFlight == q) return
        search(debounceMs = 0)
    }
    private var inFlight: String? = null

    private fun search(debounceMs: Long) {
        val q = query.trim()
        job?.cancel()
        if (q.length < 2) { results = emptyList(); resultsFor = q; loading = false; return }
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
