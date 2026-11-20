@file:OptIn(UnstableApi::class)

package com.chitram.app.player

import android.app.Application
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.VideoSize
import androidx.media3.common.text.CueGroup
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import com.chitram.app.data.Api
import com.chitram.app.data.PlaybackReport
import com.chitram.app.App
import com.chitram.app.data.Progress
import com.chitram.app.data.Ranking
import com.chitram.app.data.SeasonInfo
import com.chitram.app.data.Source
import com.chitram.app.resolve.OnDeviceResolver
import com.chitram.app.resolve.StreamInterceptor
import com.chitram.app.resolve.TsAudioSwap
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** What to play. `seasons` lets the player roll on to the next episode. */
data class PlayRequest(
    val type: String,
    val id: Long,
    val title: String,
    val season: Int = 0,
    val episode: Int = 0,
    val poster: String? = null,
    val backdrop: String? = null,
    val epTitle: String? = null,
    val seasons: List<SeasonInfo> = emptyList(),
    val overview: String? = null,
    /** Start over: ignore the saved position. */
    val fromStart: Boolean = false,
    /** Subtitles are keyed by imdb id (OpenSubtitles addon). */
    val imdbId: String? = null,
    /** TMDB runtime: the episode's when known, else the title's (runtime check). */
    val runtimeMin: Int? = null,
)

data class MenuItem(val key: String, val label: String, val detail: String = "", val selected: Boolean = false, val dim: Boolean = false)

class PlayerVm(app: Application) : AndroidViewModel(app) {
    private val g = app as App

    sealed interface Phase {
        data object Resolving : Phase
        data object Playing : Phase
        data class Failed(val message: String) : Phase
    }

    var phase by mutableStateOf<Phase>(Phase.Resolving); private set
    var request by mutableStateOf<PlayRequest?>(null); private set
    var sources by mutableStateOf<List<Source>>(emptyList()); private set
    var current by mutableStateOf<Source?>(null); private set
    var status by mutableStateOf(""); private set
    var isPlaying by mutableStateOf(false); private set
    var buffering by mutableStateOf(false); private set
    var videoSize by mutableStateOf(VideoSize.UNKNOWN); private set
    var cues by mutableStateOf(""); private set
    var tracks by mutableStateOf(Tracks.EMPTY); private set
    var positionMs by mutableStateOf(0L); private set
    var durationMs by mutableStateOf(0L); private set
    var bufferedMs by mutableStateOf(0L); private set
    /** Mid-play message while a source changes ("Trying another source…"); "" otherwise. */
    var notice by mutableStateOf(""); private set
    /** Set when an episode ends and another follows: the Next episode card. */
    var nextUp by mutableStateOf<PlayRequest?>(null); private set
    /** No network: playback is paused and waits for it (U8). */
    var offline by mutableStateOf(false); private set

    // ---- Loading screen (LoadingModel) ----------------------------------------
    /** One clock for the whole start: Play, a resume or an episode change. Never reset per overlay. */
    var playAt by mutableLongStateOf(0L); private set
    /** False until the first frame of this start has rendered. Mid-film switches keep it true. */
    var framed by mutableStateOf(false); private set
    /** Rows put on screen during this start, in order (k of n tried). */
    var attempts by mutableStateOf<List<LoadingModel.Attempt>>(emptyList()); private set
    /** Search-phase rows: Chitram server, Mapple (on phone), VaPlayer (on phone). */
    var checks by mutableStateOf<List<LoadingModel.Check>>(emptyList()); private set
    /** True once the first source list exists for this resolve. */
    var listReady by mutableStateOf(false); private set
    private var firstListSize = 0
    /** One stable label per row id (LoadingModel.labelRows): menus, notices and Details agree. */
    var labels by mutableStateOf<Map<String, String>>(emptyMap()); private set
    private var resolveStartMs = 0L

    val player: ExoPlayer = ExoPlayer.Builder(
        app,
        DefaultRenderersFactory(app).setEnableDecoderFallback(true),
    )
        .setMediaSourceFactory(DefaultMediaSourceFactory(OkHttpDataSource.Factory(g.api.client)))
        // Smaller buffer than the default: the 2018 stick has 1.5 GB RAM.
        .setLoadControl(DefaultLoadControl.Builder().setBufferDurationsMs(15_000, 40_000, 1_500, 3_000).build())
        .setSeekBackIncrementMs(10_000)
        .setSeekForwardIncrementMs(10_000)
        .build()

    /**
     * System media session: the remote's media keys reach the player through
     * it, and Fire TV shows now-playing from the item's metadata.
     */
    private val session: MediaSession = MediaSession.Builder(app, player).setId("chitram").build()

    /**
     * Rows that FAILED for this title (web deadSources). A manual switch keeps
     * it, so auto-advance never returns to a row that already failed (U7).
     */
    private val tried = HashSet<String>()
    private var refreshedOnce = false
    private var resolveJob: Job? = null
    private var guardJob: Job? = null
    /** On-device resolves still running after the first source started; they join late. */
    private var lateJobs: List<Job> = emptyList()
    private var deviceJobs: List<Deferred<List<Source>>> = emptyList()
    /** OnDeviceResolver names of [deviceJobs], same order. */
    private var deviceNames: List<String> = emptyList()
    /** The VM /api/streams call of this start (null when the breaker skipped it). */
    private var vmJob: Deferred<List<Source>>? = null
    /** A9: the one ?full=1 follow-up after a partial VM answer. */
    private var fullJob: Job? = null
    /** Device rows hidden behind a VM row of the same provider, by lowercase provider. */
    private var twins: Map<String, Source> = emptyMap()
    /** Providers whose VM row already fell back to the device once in this title. */
    private val twinTried = HashSet<String>()
    /** On-device providers already re-resolved once for this title. */
    private val reresolved = HashSet<String>()
    /** The preferred-language audio pick is done once per source. */
    private var audioPickedFor: String? = null
    /** Row the viewer picked by hand in this title (Server menu or Details); its provider pins outright. */
    private var manualPickId: String? = null

    /** OpenSubtitles tracks for the current request (U1): Telugu, then English. */
    private var subs: List<OpenSubs.Track> = emptyList()
    private var subsJob: Deferred<List<OpenSubs.Track>>? = null

    // Dead-source watchdog and report timing (U4, U6), per play().
    private var requestedAt = 0L
    private var playStartedAt = 0L
    private var landed = false
    private var runtimeDone = false
    /** Language and height playing when the last row landed: auto-advance keeps them (U7). */
    private var ctxLang: String? = null
    private var ctxHeight: Int? = null

    // Offline (U8).
    private var resumeOnReturn = false
    /** startMs of a resolve that could not run offline; replayed when the network returns. */
    private var pendingResolveMs: Long? = null
    private val cm: ConnectivityManager? = try { app.getSystemService(ConnectivityManager::class.java) } catch (_: Exception) { null }
    private val netCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { viewModelScope.launch { if (offline) backOnline() } }
        override fun onLost(network: Network) {
            // A Wi-Fi to mobile handoff loses one network and gains another: look again shortly.
            viewModelScope.launch { delay(1_500); if (isOffline()) goOffline() }
        }
    }

    init {
        player.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(playing: Boolean) {
                isPlaying = playing
                if (!playing) saveProgress()
            }
            override fun onPlaybackStateChanged(state: Int) {
                buffering = state == Player.STATE_BUFFERING
                if (state == Player.STATE_READY) {
                    durationMs = player.duration.coerceAtLeast(0)
                    if (!offline) notice = ""
                    current?.let { request?.let { r -> g.lastProvider.put(r.type, r.id, it.provider, manual = it.id == manualPickId) } }
                }
                if (state == Player.STATE_ENDED) onEnded()
            }
            override fun onVideoSizeChanged(size: VideoSize) { videoSize = size }
            override fun onRenderedFirstFrame() { markFramed() }
            override fun onCues(cueGroup: CueGroup) { cues = cueGroup.cues.joinToString("\n") { it.text ?: "" }.trim() }
            override fun onTracksChanged(t: Tracks) { tracks = t; pickPreferredAudio(t); if (landed) current?.let { snapshotCtx(it) } }
            override fun onPlayerError(error: PlaybackException) { handleError(error) }
        })
        viewModelScope.launch {
            var n = 0
            while (isActive) {
                delay(500)
                positionMs = player.currentPosition
                bufferedMs = player.bufferedPosition
                if (player.duration > 0) durationMs = player.duration
                if (++n % 20 == 0 && player.isPlaying) saveProgress()
                checkSwitch()
                checkStall()
                checkRuntime()
            }
        }
        try { cm?.registerDefaultNetworkCallback(netCallback) } catch (e: Exception) {
            android.util.Log.i("Chitram", "[offline] no network callback: ${e.javaClass.simpleName}")
        }
    }

    // Stall ladder (web useRecovery "switching" stage): a buffering stream whose
    // buffer has not grown for 25s is dead, so move to the next source. Mid-play
    // only: until the first frame the switch watchdog (8s/20s) judges the row. ExoPlayer
    // retries a refused connection on its own and never raises an error for it.
    private var stallBuffered = -1L
    private var stallSince = 0L

    private fun checkStall() {
        val stalled = landed && !offline && phase == Phase.Playing && player.playWhenReady && player.playbackState == Player.STATE_BUFFERING
        if (!stalled) { stallSince = 0; return }
        val now = System.currentTimeMillis()
        val b = player.bufferedPosition
        if (stallSince == 0L || b > stallBuffered) { stallSince = now; stallBuffered = b; return }
        if (now - stallSince >= STALL_SWITCH_MS) {
            stallSince = 0
            failover("${current?.provider ?: "Source"}: stalled", player.currentPosition.coerceAtLeast(0), LoadingModel.Reason.STOPPED)
        }
    }

    fun start(r: PlayRequest) {
        if (request == r) return
        saveProgress()
        request = r
        tried.clear()
        reresolved.clear()
        twinTried.clear()
        twins = emptyMap()
        refreshedOnce = false
        manualPickId = null
        nextUp = null
        notice = ""
        ctxLang = null
        ctxHeight = null
        requestedAt = System.currentTimeMillis()
        resetStart()
        subs = emptyList()
        subsJob?.cancel()
        val job = viewModelScope.async { OpenSubs.fetch(g.api.client, r.imdbId, r.season, r.episode, r.runtimeMin) }
        subsJob = job
        // Late captions reach the next row put on screen (failover or a manual switch).
        viewModelScope.launch { val t = job.await(); if (request == r) { subs = t; android.util.Log.i("Chitram", "[subs] ${t.size} tracks: ${t.joinToString { it.label }}") } }
        resolve(refresh = false, keepProvider = null, startMs = if (r.fromStart) 0 else g.progress.resumeMs(r.type, r.id, r.season, r.episode))
    }

    /**
     * Backend streams and the on-device resolves (mapple, vaplayer) run together.
     * Once the backend answers, on-device rows get DEVICE_GRACE_MS more to join
     * the first ranking (all of their budget when the backend gave nothing); any
     * that finish later are merged into the list without interrupting playback.
     */
    private fun resolve(refresh: Boolean, keepProvider: String?, startMs: Long, reuseDevice: Boolean = false) {
        val r = request ?: return
        resolveJob?.cancel()
        // Search-phase Try again re-asks the server only: on-device resolves keep running.
        val keep = reuseDevice && deviceJobs.isNotEmpty()
        if (!keep) {
            lateJobs.forEach { it.cancel() }
            deviceJobs.forEach { it.cancel() }
            twins = emptyMap()
        }
        player.stop()
        phase = Phase.Resolving
        listReady = false
        resolveStartMs = startMs
        status = if (refresh) "Refreshing links…" else "Getting your stream ready"
        val t0 = System.currentTimeMillis()
        checks = (if (keep) checks.filter { it.id != LoadingModel.CHECK_SERVER } else emptyList()) +
            LoadingModel.Check(LoadingModel.CHECK_SERVER, "Chitram server", t0)
        resolveJob = viewModelScope.launch {
            // A remembered provider leads only inside the viewer's language unless it was picked by hand (A8).
            val saved = g.lastProvider.get(r.type, r.id)
            val pin = keepProvider ?: saved?.provider
            val manualPin = keepProvider != null || saved?.manual == true
            val preferred = g.prefs.preferredAudio()
            // VM breaker open: no VM call, MultiMovies resolves on the device instead.
            val vmDown = !g.api.vmUp
            val names = g.onDevice.names(vmDown)
            val device = if (keep) deviceJobs else g.onDevice.launchAll(viewModelScope, r.type, r.id, r.season, r.episode, g.codecs, preferred, r.title, vmDown).also { d ->
                deviceNames = names
                d.zip(names).forEach { (job, n) -> watchCheck(job, n, t0) }
            }
            deviceJobs = device
            vmJob?.cancel()
            fullJob?.cancel()
            // A9: set when the VM answered partial or a provider threw; read after the answer lands.
            val wantsFull = java.util.concurrent.atomic.AtomicBoolean(false)
            // The VM call lives in the supervisor scope: its failure must not cancel the start.
            val vm = if (vmDown) null else viewModelScope.async {
                val resp = g.api.streams(r.type, r.id, r.season, r.episode, refresh)
                wantsFull.set(resp.wantsFull)
                Ranking.fromResponse(resp, preferred, g.codecs, pin, manual = manualPin)
            }
            vmJob = vm
            if (vm == null) android.util.Log.i("Chitram", "[vm] paused: starting from device rows only")
            val first = StartRace().firstMany(vm, device, preferred)
            val backend = first.backend
            val backendError = first.backendError
            if (!first.backendPending) {
                endCheck(LoadingModel.CHECK_SERVER, backend.size)
                if (vm == null || backendError != null) launchMultiMovies(r, preferred, pin, manualPin, t0)
            }
            // Same provider from both sides: the VM row shows, the device row waits as its twin.
            val (shown, twinMap) = StartRace.splitTwins(backend, first.device)
            twins = twinMap
            val list = Ranking.merge(backend, shown, preferred, pin, manualPin)
            putSources(list)
            if (firstListSize == 0) firstListSize = list.size
            listReady = true
            // Await every job: one may complete after the first race snapshot. IDs make replay safe.
            lateJobs = device.map { d -> viewModelScope.launch { joinLate(r, d, preferred, pin, manualPin) } } +
                listOfNotNull(vm?.takeIf { first.backendPending }?.let { j -> viewModelScope.launch { joinVm(r, j, preferred, pin, manualPin, t0, wantsFull) } })
            if (!first.backendPending && backendError == null && wantsFull.get()) followFull(r, preferred, pin, manualPin)
            if (sources.isEmpty() && isOffline()) {
                pendingResolveMs = startMs
                goOffline()
                status = OFFLINE_TEXT
                return@launch
            }
            // Captions ride on the media item, so give the subtitle fetch a moment
            // to land; it runs alongside the streams call and is usually done.
            subsJob?.let { j -> withTimeoutOrNull(SUBS_WAIT_MS) { j.await() }?.let { subs = it } }
            if (sources.isEmpty()) {
                phase = Phase.Failed(backendError?.let { "Could not reach the server (${it.message ?: it.javaClass.simpleName})." } ?: "No playable source found.")
                return@launch
            }
            if (phase == Phase.Resolving) play(sources.first(), startMs)
        }
    }

    /** One loading-screen check row per on-device provider, closed when its resolve ends. */
    private fun watchCheck(job: Deferred<List<Source>>, name: String, t0: Long) {
        val id = "check:$name"
        checks = checks + LoadingModel.Check(id, "${CHECK_LABELS[name] ?: name} (on phone)", t0)
        viewModelScope.launch { val got = runCatching { job.await() }.getOrNull(); endCheck(id, got?.size ?: 0) }
    }

    /** The VM is down or failed: resolve MultiMovies on the device (once per start) and let it join late. */
    private fun launchMultiMovies(r: PlayRequest, preferred: String, pin: String?, manualPin: Boolean, t0: Long) {
        val n = com.chitram.app.resolve.OnDeviceResolver.MULTIMOVIES
        if (n in deviceNames || !g.onDevice.names(vmDown = true).contains(n)) return
        deviceNames = deviceNames + n
        val d = viewModelScope.async { g.onDevice.resolveAll(n, r.type, r.id, r.season, r.episode, g.codecs, preferred, title = r.title) }
        deviceJobs = deviceJobs + d
        watchCheck(d, n, t0)
        lateJobs = lateJobs + viewModelScope.launch { joinLate(r, d, preferred, pin, manualPin) }
    }

    /** VM rows that came after the film started from a device row: join without interrupting. */
    private suspend fun joinVm(r: PlayRequest, j: Deferred<List<Source>>, preferred: String, pin: String?, manualPin: Boolean, t0: Long, wantsFull: java.util.concurrent.atomic.AtomicBoolean) {
        val rows = try { j.await() } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException && !j.isCancelled) throw e
            android.util.Log.i("Chitram", "[vm] late answer failed: ${e.message}")
            null
        }
        if (request != r) return
        endCheck(LoadingModel.CHECK_SERVER, rows?.size ?: 0)
        if (rows == null) { launchMultiMovies(r, preferred, pin, manualPin, t0); return }
        putSources(Ranking.merge(sources, rows, preferred, pin, manualPin))
        android.util.Log.i("Chitram", "[vm] ${rows.size} row(s) joined late")
        if (phase is Phase.Failed && rows.isNotEmpty()) { play(sources.first(), g.progress.resumeMs(r.type, r.id, r.season, r.episode)); notice = "" }
        if (wantsFull.get()) followFull(r, preferred, pin, manualPin)
    }

    /**
     * A9: the VM answered with only its ready rows. One ?full=1 call (60s) in the
     * background, as web/lib/backend.js does; new rows join and the list is
     * re-ranked in place. The playing source is never interrupted. A timeout or
     * a down VM leaves the first list as it is.
     */
    private fun followFull(r: PlayRequest, preferred: String, pin: String?, manualPin: Boolean) {
        fullJob?.cancel()
        val t0 = System.currentTimeMillis()
        fullJob = viewModelScope.launch {
            val more = g.api.streamsFull(r.type, r.id, r.season, r.episode)
            if (request != r) return@launch
            if (more == null) { android.util.Log.i("Chitram", "[vm] full follow-up gave nothing; first list stands"); return@launch }
            val before = sources.size
            putSources(Ranking.mergeMore(sources, more, preferred, g.codecs, pin, manualPin))
            android.util.Log.i("Chitram", "[vm] full follow-up: ${sources.size - before} new row(s) of ${more.streams.size} in ${System.currentTimeMillis() - t0}ms")
            if (phase is Phase.Failed && sources.isNotEmpty()) { play(sources.first(), g.progress.resumeMs(r.type, r.id, r.season, r.episode)); notice = "" }
        }
    }

    private suspend fun joinLate(r: PlayRequest, d: Deferred<List<Source>>, preferred: String, pin: String?, manualPin: Boolean) {
        val rows = d.await()
        if (request != r || rows.isEmpty()) return
        val (shown, lateTwins) = StartRace.splitTwins(sources.filter { it.onDevice == null }, rows)
        twins = twins + lateTwins
        putSources(Ranking.merge(sources, shown, preferred, pin, manualPin))
        android.util.Log.i("Chitram", "on-device ${rows.size} row(s) joined late")
        if (phase is Phase.Failed && sources.isNotEmpty()) { play(sources.first(), g.progress.resumeMs(r.type, r.id, r.season, r.episode)); notice = "" }
    }

    fun play(s: Source, startMs: Long = player.currentPosition.coerceAtLeast(0)) {
        // A row still open here was left by a manual pick: back to waiting, not failed.
        endAttempt(LoadingModel.RowState.WAITING, null)
        attempts = attempts + LoadingModel.Attempt(s.id, System.currentTimeMillis())
        current = s
        cues = ""
        videoSize = VideoSize.UNKNOWN
        playStartedAt = System.currentTimeMillis()
        landed = false
        runtimeDone = false
        // OpenSubtitles first (Telugu, then English), then any the provider row carries.
        val external = subs.map { t ->
            MediaItem.SubtitleConfiguration.Builder(Uri.parse(t.url))
                .setMimeType(MimeTypes.APPLICATION_SUBRIP).setLabel(t.label).setLanguage(t.lang).build()
        }
        val own = s.subtitles.take(12).map { sub ->
            val mime = if (sub.url.contains(".srt", ignoreCase = true)) MimeTypes.APPLICATION_SUBRIP else MimeTypes.TEXT_VTT
            MediaItem.SubtitleConfiguration.Builder(Uri.parse(sub.url))
                .setMimeType(mime).setLabel(sub.lang ?: "Subtitles").setLanguage(sub.lang?.lowercase()).build()
        }
        val item = MediaItem.Builder()
            .setUri(s.url)
            .apply { if (!s.progressive) setMimeType(MimeTypes.APPLICATION_M3U8) }
            .setSubtitleConfigurations(external + own)
            .setMediaMetadata(metadata(request))
            .build()
        audioPickedFor = null
        // Prefer the viewer's language inside multi-audio masters; subtitles off by default.
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
            .clearOverrides()
            .setPreferredAudioLanguages(*isoFor(g.prefs.preferredAudio()))
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
            .build()
        val swap = if (TsAudioSwap.wanted(s)) TsAudioSwap(g.prefs.preferredAudio()) else null
        if (s.onDevice != null || swap != null) {
            // Provider Referer/Origin on every request; vaplayer's token on every segment.
            // Caption files go out plain: the provider headers and vaplayer token are for the stream only.
            // A muxed CastleTV row (VM or device) gets the TS audio swap: the player keeps only the first AAC PID.
            val streamClient = StreamInterceptor.client(g.api.client, s.headers, s.segmentToken)
                .let { c -> if (swap == null) c else c.newBuilder().addInterceptor(swap).build() }
            if (swap != null) android.util.Log.i("Chitram", "[tsaudio] ${s.provider}: swapping in ${g.prefs.preferredAudio()} from ${s.languages.joinToString("/")}")
            val http = OkHttpDataSource.Factory(okhttp3.Call.Factory { req ->
                if (subs.any { it.url == req.url.toString() }) g.api.client.newCall(req) else streamClient.newCall(req)
            })
            player.setMediaSource(DefaultMediaSourceFactory(http).createMediaSource(item), startMs)
        } else {
            player.setMediaItem(item, startMs)
        }
        player.prepare()
        player.playWhenReady = true
        phase = Phase.Playing
        status = ""
        startNoPictureGuard(s)
    }

    /** Fatal error policy (web/lib/player/fatalPolicy.js): stale link refreshes once, else next source. */
    private fun handleError(e: PlaybackException) {
        val http = generateSequence<Throwable>(e) { it.cause }.filterIsInstance<HttpDataSource.InvalidResponseCodeException>().firstOrNull()
        val pos = player.currentPosition.coerceAtLeast(0)
        val cur = current
        val action = FailPolicy.onError(cur, http?.responseCode, refreshedOnce, cur?.onDevice in reresolved, offline = offline || isOffline(), twinTried = cur?.provider?.lowercase() in twinTried)
        val why = LoadingModel.reasonFor(http?.responseCode, decoder = e.errorCode in 4000..4999)
        if (action == FailPolicy.Action.WAIT_ONLINE) {
            android.util.Log.i("Chitram", "[offline] ${cur?.provider}: ${e.errorCodeName} while offline, waiting")
            goOffline()
            return
        }
        if (action == FailPolicy.Action.RERESOLVE && cur?.onDevice != null) {
            reresolve(cur, pos, "${cur.provider}: ${e.errorCodeName}", why)
            return
        }
        if (action == FailPolicy.Action.DEVICE && cur != null) {
            toDevice(cur, pos, "${cur.provider}: ${e.errorCodeName}", why)
            return
        }
        if (action == FailPolicy.Action.REFRESH) {
            endAttempt(LoadingModel.RowState.FAILED, why)
            refreshedOnce = true
            tried.clear()
            resolve(refresh = true, keepProvider = current?.provider, startMs = pos)
            return
        }
        failover("${current?.provider ?: "Source"}: ${e.errorCodeName}", pos, why)
    }

    /** Recover an on-device row once: resolve it again on the device and resume at `pos`. */
    private fun reresolve(s: Source, pos: Long, reason: String, why: String) {
        val r = request ?: return
        val name = s.onDevice ?: return
        reresolved += name
        endAttempt(LoadingModel.RowState.FAILED, why)
        android.util.Log.i("Chitram", "recover: $reason -> re-resolving ${s.provider} on device")
        notice = "Reconnecting to ${s.provider}…"
        player.stop()
        resolveJob?.cancel()
        resolveJob = viewModelScope.launch {
            val key = OnDeviceResolver.nameFor(name) ?: OnDeviceResolver.VAPLAYER
            val rows = g.onDevice.resolveAll(key, r.type, r.id, r.season, r.episode, g.codecs, g.prefs.preferredAudio(), fresh = true, title = r.title)
            val fresh = rows.find { it.id == s.id } ?: Ranking.rank(rows, g.prefs.preferredAudio()).firstOrNull { it.id !in tried }
            if (request != r) return@launch
            if (fresh == null) { failover("$reason, re-resolve failed", pos, why); return@launch }
            if (fresh.id != s.id) tried += s.id
            putSources(Ranking.merge(sources, rows, g.prefs.preferredAudio(), null))
            play(fresh, pos)
            notice = ""
        }
    }

    /**
     * A VM row of a provider the device can resolve (CastleTV, MultiMovies)
     * failed: play its device twin, or resolve that provider on the device now,
     * at the same position. Once per provider per title; then normal failover.
     */
    private fun toDevice(s: Source, pos: Long, reason: String, why: String) {
        val r = request ?: return
        val key = s.provider.lowercase()
        twinTried += key
        val twin = twins[key]
        if (twin != null && twin.id !in tried) {
            android.util.Log.i("Chitram", "recover: $reason -> device twin")
            endAttempt(LoadingModel.RowState.FAILED, why)
            tried += s.id
            report(s, ok = false, reason = reason)
            putSources(Ranking.merge(sources, listOf(twin), g.prefs.preferredAudio(), null))
            play(twin, pos)
            notice = LoadingModel.advanceNotice(label(s), label(twin), skip = why == LoadingModel.Reason.UNSUPPORTED)
            return
        }
        val name = OnDeviceResolver.nameFor(s.provider) ?: return failover(reason, pos, why)
        android.util.Log.i("Chitram", "recover: $reason -> resolving ${s.provider} on device")
        notice = "Reconnecting to ${s.provider}…"
        player.stop()
        resolveJob?.cancel()
        resolveJob = viewModelScope.launch {
            val rows = g.onDevice.resolveAll(name, r.type, r.id, r.season, r.episode, g.codecs, g.prefs.preferredAudio(), fresh = true, title = r.title)
            val fresh = Ranking.rank(rows, g.prefs.preferredAudio()).firstOrNull { it.id !in tried }
            if (request != r) return@launch
            if (fresh == null || fresh.id in tried) { failover("$reason, device resolve failed", pos, why); return@launch }
            endAttempt(LoadingModel.RowState.FAILED, why)
            tried += s.id
            report(s, ok = false, reason = reason)
            putSources(Ranking.merge(sources, rows, g.prefs.preferredAudio(), null))
            play(fresh, pos)
            notice = LoadingModel.advanceNotice(label(s), label(fresh), skip = why == LoadingModel.Reason.UNSUPPORTED)
        }
    }

    /**
     * The current row failed: mark it dead, report it, and advance to the next
     * alive row in the language (and near the height) that was playing (web
     * switchFlow.advanceTarget).
     */
    private fun failover(reason: String, pos: Long, why: String = LoadingModel.Reason.STOPPED) {
        endAttempt(LoadingModel.RowState.FAILED, why)
        val failed = current
        if (failed != null) {
            tried += failed.id
            report(failed, ok = false, reason = reason)
        }
        val next = PlayPolicy.nextAlive(sources, tried, ctxLang ?: g.prefs.preferredAudio(), ctxHeight)
        if (next == null) {
            phase = Phase.Failed("Every source failed. Last: $reason")
            player.stop()
            return
        }
        android.util.Log.i("Chitram", "failover: $reason -> ${next.provider} (lang ${ctxLang ?: "preferred"}, ${ctxHeight ?: "-"}p)")
        play(next, pos)
        notice = LoadingModel.advanceNotice(failed?.let { label(it) } ?: "That server", label(next), skip = why == LoadingModel.Reason.UNSUPPORTED)
    }

    /**
     * Dead-source watchdog (web switchFlow, U6) for every row put on screen: no
     * sign of life in 8s, or no frame in 20s, is dead. On-device rows still get
     * their one re-resolve first (1.1.9).
     */
    private fun checkSwitch() {
        val s = current ?: return
        if (landed || phase != Phase.Playing) return
        val now = System.currentTimeMillis()
        // Paused before the first frame, or offline: nothing to judge; restart the clock.
        if (offline || !player.playWhenReady) { playStartedAt = now; return }
        val alive = player.totalBufferedDuration > 0 || player.duration > 0 || player.playbackState == Player.STATE_READY
        when (PlayPolicy.switchVerdict(now - playStartedAt, alive, frames = player.isPlaying)) {
            PlayPolicy.Switch.LANDED -> onLanded(s, now)
            PlayPolicy.Switch.DEAD -> {
                landed = true // judged; play() resets it
                val reason = if (alive) "switch: no frame in 20s" else "switch: no response in 8s"
                val why = if (alive) LoadingModel.Reason.NO_PICTURE else LoadingModel.Reason.NO_ANSWER
                android.util.Log.i("Chitram", "[switch] ${s.provider} dead: $reason")
                when (FailPolicy.onError(s, null, refreshedOnce, s.onDevice in reresolved, offline = isOffline(), twinTried = s.provider.lowercase() in twinTried)) {
                    FailPolicy.Action.WAIT_ONLINE -> { landed = false; goOffline() }
                    FailPolicy.Action.RERESOLVE -> reresolve(s, player.currentPosition.coerceAtLeast(0), "${s.provider}: $reason", why)
                    FailPolicy.Action.DEVICE -> toDevice(s, player.currentPosition.coerceAtLeast(0), "${s.provider}: $reason", why)
                    else -> failover("${s.provider}: $reason", player.currentPosition.coerceAtLeast(0), why)
                }
            }
            PlayPolicy.Switch.WAIT -> {}
        }
    }

    private fun onLanded(s: Source, now: Long) {
        landed = true
        markFramed()
        snapshotCtx(s)
        android.util.Log.i("Chitram", "[switch] ${s.provider} landed in ${now - playStartedAt}ms")
        checkRuntime()
    }

    /** What is playing now, for auto-advance: the selected audio language and the picture height. */
    private fun snapshotCtx(s: Source) {
        val audio = groups(C.TRACK_TYPE_AUDIO).flatMap { gr -> (0 until gr.length).filter { gr.isTrackSelected(it) }.map { gr.getTrackFormat(it) } }.firstOrNull()
        ctxLang = audio?.let { langName(it.language) } ?: s.languages.firstOrNull() ?: ctxLang
        ctxHeight = videoSize.height.takeIf { it > 0 } ?: Ranking.height(s).takeIf { it > 0 } ?: ctxHeight
    }

    /**
     * Runtime check (web runtimeCheck, U5): a stream under 82% of the TMDB
     * runtime is the wrong title or a truncated file. Fail over when another
     * row is left; with none, keep playing rather than dead-end. A play is
     * reported good only once the check passes (never while it is unknown).
     */
    private fun checkRuntime() {
        val s = current ?: return
        val r = request ?: return
        if (!landed || runtimeDone || phase != Phase.Playing) return
        val d = player.duration
        when (PlayPolicy.runtimeVerdict(r.runtimeMin, d)) {
            PlayPolicy.Runtime.UNKNOWN -> {}
            PlayPolicy.Runtime.OK -> {
                runtimeDone = true
                report(s, ok = true, reason = null)
            }
            PlayPolicy.Runtime.MISMATCH -> {
                runtimeDone = true
                val reason = "runtime mismatch (${d / 60_000}m vs ${r.runtimeMin}m)"
                android.util.Log.i("Chitram", "[runtime] ${s.provider}: $reason")
                if (PlayPolicy.nextAlive(sources, tried + s.id, ctxLang, ctxHeight) != null) failover(reason, player.currentPosition.coerceAtLeast(0), LoadingModel.Reason.NOT_FOUND)
                else report(s, ok = false, reason = reason)
            }
        }
    }

    /** POST /api/playback-report, fire-and-forget (U4). */
    private fun report(s: Source, ok: Boolean, reason: String?) {
        val r = request ?: return
        val now = System.currentTimeMillis()
        g.api.reportPlayback(PlaybackReport(
            type = if (r.type == "tv") "tv" else "movie", tmdbId = r.id, season = r.season, episode = r.episode,
            provider = s.provider, ok = ok, reason = reason?.take(60),
            startupMs = if (playStartedAt > 0) now - playStartedAt else 0,
            waitMs = if (requestedAt > 0) now - requestedAt else 0,
            mediaUrl = s.url, audioLang = ctxLang,
            device = if (Device.isTv(getApplication<Application>())) "tv" else "mobile",
        ))
    }

    // ---- Offline (U8, web Player.jsx offline banner) -------------------------

    private fun isOffline(): Boolean = try {
        val c = cm
        if (c == null) false else {
            val n = c.activeNetwork
            n == null || c.getNetworkCapabilities(n)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) != true
        }
    } catch (_: Exception) { false }

    private fun goOffline() {
        if (offline) return
        offline = true
        resumeOnReturn = player.playWhenReady
        player.pause()
        notice = OFFLINE_TEXT
        android.util.Log.i("Chitram", "[offline] paused ${current?.provider ?: "resolve"}")
    }

    private fun backOnline() {
        offline = false
        notice = ""
        android.util.Log.i("Chitram", "[offline] back online")
        pendingResolveMs?.let { ms -> pendingResolveMs = null; resolve(refresh = false, keepProvider = null, startMs = ms); return }
        if (phase != Phase.Playing) return
        stallSince = 0
        playStartedAt = System.currentTimeMillis()
        if (player.playerError != null || player.playbackState == Player.STATE_IDLE) player.prepare()
        if (resumeOnReturn) player.play()
    }

    /**
     * Telugu first: a master lists many audio renditions (mapple: 14, castle-demux: 5).
     * If the player did not land on the preferred language, select it once. Backend
     * rows too (A8): the VM lists Hindi first on Castle.
     */
    private fun pickPreferredAudio(t: Tracks) {
        val s = current ?: return
        if (audioPickedFor == s.id) return
        val audio = t.groups.filter { it.type == C.TRACK_TYPE_AUDIO }
        if (audio.isEmpty()) return
        audioPickedFor = s.id
        val want = isoFor(g.prefs.preferredAudio()).map { it.lowercase() }
        fun matches(f: androidx.media3.common.Format): Boolean {
            val lang = f.language?.lowercase()?.substringBefore('-')
            val name = langName(f.language)?.lowercase()
            return lang in want || name in want || f.label?.lowercase() in want ||
                (lang != null && lang.length == 3 && langName(lang)?.lowercase() in want)
        }
        if (audio.any { gr -> (0 until gr.length).any { gr.isTrackSelected(it) && matches(gr.getTrackFormat(it)) } }) return
        for (gr in audio) for (i in 0 until gr.length) {
            if (gr.isTrackSupported(i) && matches(gr.getTrackFormat(i))) {
                player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
                    .setOverrideForType(TrackSelectionOverride(gr.mediaTrackGroup, i)).build()
                android.util.Log.i("Chitram", "audio: picked ${gr.getTrackFormat(i).language} on ${s.provider}")
                return
            }
        }
    }

    /**
     * "Audio but no picture" guard (web useNoPictureGuard): if the clock moves 3s
     * for 6s while no video frame has rendered, the device cannot show this
     * stream, so move to the next one.
     */
    private fun startNoPictureGuard(s: Source) {
        guardJob?.cancel()
        guardJob = viewModelScope.launch {
            var basePos = -1L
            var movingSince = 0L
            while (isActive) {
                delay(1000)
                if (current !== s) return@launch
                if (!player.isPlaying) { movingSince = 0; continue }
                val counters = player.videoDecoderCounters?.also { it.ensureUpdated() }
                val frames = counters?.renderedOutputBufferCount ?: 0
                if (videoSize.width > 0 || frames > 0) return@launch
                val p = player.currentPosition
                if (basePos < 0) { basePos = p; continue }
                if (p - basePos <= 500) { movingSince = 0; continue }
                if (movingSince == 0L) movingSince = System.currentTimeMillis()
                if (p - basePos >= 3000 && System.currentTimeMillis() - movingSince >= 6000) {
                    failover("no picture", p, LoadingModel.Reason.UNSUPPORTED)
                    return@launch
                }
            }
        }
    }

    /** The following episode, crossing into the next season; null for a film or the last one. */
    val nextEpisode: PlayRequest?
        get() {
            val r = request ?: return null
            if (r.type != "tv" || r.season == 0) return null
            val count = r.seasons.firstOrNull { it.number == r.season }?.episodes ?: 0
            return when {
                // Runtime unknown for the next episode: no runtime check (web treats unknown the same).
                count == 0 || r.episode < count -> r.copy(episode = r.episode + 1, epTitle = null, fromStart = false, runtimeMin = null)
                r.seasons.any { it.number == r.season + 1 } -> r.copy(season = r.season + 1, episode = 1, epTitle = null, fromStart = false, runtimeMin = null)
                else -> null
            }
        }

    /** End of an episode: offer the next one with a countdown (web NextUp). */
    private fun onEnded() {
        saveProgress()
        nextUp = nextEpisode
    }

    fun dismissNext() { nextUp = null }

    fun saveProgress() {
        val r = request ?: return
        val d = player.duration
        if (d <= 0 || current == null) return
        g.progress.save(Progress(r.type, r.id, r.season, r.episode, player.currentPosition, d, title = r.title, poster = r.poster, backdrop = r.backdrop, epTitle = r.epTitle, overview = r.overview))
    }

    /** Leaving the player: keep progress, free the decoders (the stick has few). */
    fun leave() {
        saveProgress()
        resolveJob?.cancel()
        lateJobs.forEach { it.cancel() }
        deviceJobs.forEach { it.cancel() }
        vmJob?.cancel()
        fullJob?.cancel()
        guardJob?.cancel()
        subsJob?.cancel()
        pendingResolveMs = null
        offline = false
        player.stop()
        player.clearMediaItems()
        request = null
        current = null
        sources = emptyList()
        nextUp = null
        notice = ""
        phase = Phase.Resolving
    }

    /**
     * Search phase: re-ask the server without refresh and keep the on-device
     * resolves running. End card: a fresh start with a full refresh.
     */
    fun retry() {
        val r = request ?: return
        val plan = LoadingModel.retryPlan(failed = phase is Phase.Failed)
        if (plan.keepDevice && phase == Phase.Resolving) {
            resolve(refresh = plan.refresh, keepProvider = null, startMs = resolveStartMs, reuseDevice = true)
            return
        }
        tried.clear()
        refreshedOnce = false
        resetStart()
        resolve(refresh = plan.refresh, keepProvider = null, startMs = g.progress.resumeMs(r.type, r.id, r.season, r.episode))
    }

    // ---- Loading screen state ------------------------------------------------

    private fun resetStart() {
        playAt = System.currentTimeMillis()
        framed = false
        attempts = emptyList()
        checks = emptyList()
        listReady = false
        firstListSize = 0
        labels = emptyMap()
    }

    private fun putSources(list: List<Source>) {
        sources = list
        labels = LoadingModel.labelRows(labels, list)
    }

    private fun label(s: Source): String = labels[s.id] ?: s.provider

    /** Close the open attempt, if any. */
    private fun endAttempt(state: LoadingModel.RowState, reason: String?) {
        val last = attempts.lastOrNull() ?: return
        if (last.endedAt != null) return
        attempts = attempts.dropLast(1) + last.copy(endedAt = System.currentTimeMillis(), state = state, reason = reason)
    }

    private fun markFramed() {
        if (phase != Phase.Playing) return
        endAttempt(LoadingModel.RowState.PLAYING, null)
        framed = true
    }

    private fun endCheck(id: String, found: Int) {
        checks = checks.map { if (it.id == id && it.endedAt == null) it.copy(endedAt = System.currentTimeMillis(), found = found) else it }
    }

    fun loadingView(now: Long): LoadingModel.View = LoadingModel.view(LoadingModel.Input(
        now = now, playAt = playAt, title = request?.title ?: "", preferred = g.prefs.preferredAudio(),
        sources = if (listReady || phase is Phase.Failed) sources else null, labels = labels, firstListSize = firstListSize,
        attempts = attempts, checks = checks, framed = framed, failed = phase is Phase.Failed,
        failMessage = (phase as? Phase.Failed)?.message ?: "",
    ))

    /** A Details row: play that source now (same path as the Server menu). */
    fun playSource(id: String) = choose("src:$id")

    /**
     * Cast to TV: pauses here and returns what to hand Web Video Caster, or null
     * when nothing is playing. WVC takes no start position, so the TV starts at 0.
     */
    fun castSpec(): WvcCast.Spec? {
        val s = current ?: return null
        val r = request ?: return null
        player.pause()
        saveProgress()
        return WvcCast.spec(s, r)
    }

    fun togglePlay() { if (player.isPlaying) player.pause() else { if (player.playbackState == Player.STATE_ENDED) player.seekTo(0); player.play() } }
    fun seekTo(ms: Long) { player.seekTo(ms.coerceIn(0, if (player.duration > 0) player.duration else Long.MAX_VALUE)); positionMs = player.currentPosition }
    fun seekBy(ms: Long) { player.seekTo((player.currentPosition + ms).coerceIn(0, if (player.duration > 0) player.duration else Long.MAX_VALUE)); positionMs = player.currentPosition }

    // ---- Menus ---------------------------------------------------------------

    fun serverItems(): List<MenuItem> {
        // Web Servers menu: best picture first, numbered once across the list (U3).
        val menu = Ranking.menuOrder(sources)
        return menu.mapIndexed { _, s ->
            val lang = s.languages.joinToString(", ").ifEmpty { "Unknown language" }
            val q = Ranking.height(s).takeIf { it > 0 }?.let { "${it}p" } ?: s.quality
            MenuItem("src:${s.id}", label(s), "$q · $lang" + if (s.unsupported) " · not supported here" else "", s.id == current?.id, s.unsupported)
        }
    }

    private fun groups(type: Int) = tracks.groups.filter { it.type == type }

    fun audioItems(): List<MenuItem> {
        val out = ArrayList<MenuItem>()
        val names = HashSet<String>()
        groups(C.TRACK_TYPE_AUDIO).forEachIndexed { gi, gr ->
            for (i in 0 until gr.length) {
                if (!gr.isTrackSupported(i)) continue
                val f = gr.getTrackFormat(i)
                // HLS renditions are often named just "Audio"; prefer a language.
                val name = f.label?.takeUnless { it.equals("audio", true) || it.isBlank() }
                    ?: langName(f.language) ?: current?.let { LoadingModel.langOf(it, g.prefs.preferredAudio()) } ?: "Default"
                if (!names.add(name.lowercase())) continue
                out += MenuItem("trk:$gi:$i", name, "in this stream", gr.isTrackSelected(i))
            }
        }
        // Tracks not known yet: name the language that will play, not the row's first (A8).
        if (out.isEmpty()) current?.let { LoadingModel.langOf(it, g.prefs.preferredAudio()) }?.let { names += it.lowercase(); out += MenuItem("cur", it, "this server", true) }
        // Key per language, not per source: one selectable-audio source (a Castle
        // demux row) offers several languages, so a bare src:<id> key repeats and
        // the audio LazyColumn throws "Key already used". Mirrors web trackChoices
        // (src:<id>:<lang>). choose() reads the id from p[1], so the :lang tail is
        // for uniqueness only. (Crash: Kubera, CastleTV-0 twice, 2026-11-21.)
        for ((lang, s) in Ranking.otherSourceLanguages(sources, current?.id, names)) {
            out += MenuItem("src:${s.id}:$lang", lang, "switches to ${s.provider} ${s.quality}")
        }
        return out
    }

    fun qualityItems(): List<MenuItem> {
        val video = groups(C.TRACK_TYPE_VIDEO)
        val overridden = player.trackSelectionParameters.overrides.keys.any { it.type == C.TRACK_TYPE_VIDEO }
        val out = arrayListOf(MenuItem("q:auto", "Auto", "adapts to your connection", !overridden))
        video.forEachIndexed { gi, gr ->
            (0 until gr.length).filter { gr.isTrackSupported(it) }
                .sortedByDescending { gr.getTrackFormat(it).height }
                .forEach { i ->
                    val f = gr.getTrackFormat(i)
                    if (f.height > 0) out += MenuItem("q:$gi:$i", "${f.height}p", if (f.bitrate > 0) "${f.bitrate / 1000} kbps" else "", overridden && gr.isTrackSelected(i))
                }
        }
        return out
    }

    fun subtitleItems(): List<MenuItem> {
        val disabled = C.TRACK_TYPE_TEXT in player.trackSelectionParameters.disabledTrackTypes
        val out = arrayListOf(MenuItem("sub:off", "Off", "", disabled))
        groups(C.TRACK_TYPE_TEXT).forEachIndexed { gi, gr ->
            for (i in 0 until gr.length) {
                val f = gr.getTrackFormat(i)
                out += MenuItem("sub:$gi:$i", f.label ?: langName(f.language) ?: "Subtitles", "", !disabled && gr.isTrackSelected(i))
            }
        }
        return out
    }

    fun choose(key: String) {
        val p = key.split(":")
        when (p[0]) {
            // src:<id> from the video sheet, or src:<id>:<lang> from the audio
            // sheet. Provider ids carry no colon (provider-N), so p[1] is the id.
            "src" -> sources.firstOrNull { it.id == p[1] }?.let {
                if (it.id == current?.id) return
                // Keep `tried`: auto-advance after a failed pick must not return to a dead row (U7).
                manualPickId = it.id
                play(it); notice = "Switching to ${label(it)}…"
            }
            "trk" -> override(C.TRACK_TYPE_AUDIO, p[1].toInt(), p[2].toInt())
            "q" -> if (p[1] == "auto") player.trackSelectionParameters = player.trackSelectionParameters.buildUpon().clearOverridesOfType(C.TRACK_TYPE_VIDEO).build()
                   else override(C.TRACK_TYPE_VIDEO, p[1].toInt(), p[2].toInt())
            "sub" -> if (p[1] == "off") {
                player.trackSelectionParameters = player.trackSelectionParameters.buildUpon().setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build()
                cues = ""
            } else {
                player.trackSelectionParameters = player.trackSelectionParameters.buildUpon().setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false).build()
                override(C.TRACK_TYPE_TEXT, p[1].toInt(), p[2].toInt())
            }
        }
    }

    private fun override(type: Int, gi: Int, i: Int) {
        val gr = groups(type).getOrNull(gi) ?: return
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
            .setOverrideForType(TrackSelectionOverride(gr.mediaTrackGroup, i)).build()
    }

    override fun onCleared() {
        saveProgress()
        try { cm?.unregisterNetworkCallback(netCallback) } catch (_: Exception) {}
        session.release()
        player.release()
    }

    companion object {
        /** Web useRecovery STAGES.switching. */
        const val STALL_SWITCH_MS = 25_000L

        /** How long the first play waits for the subtitle list after the streams answered. */
        const val SUBS_WAIT_MS = 1_500L
        const val OFFLINE_TEXT = "You're offline. Playback will resume when the connection returns."

        /** After the backend answers, how long on-device rows may still join the first ranking. */
        private val CHECK_LABELS = mapOf("mapple" to "Mapple", "vaplayer" to "VaPlayer", "castletv" to "CastleTV", "multimovies" to "MultiMovies", "netmirror" to "NetMirror")
        const val DEVICE_GRACE_MS = 3_000L
        /** When the backend gave nothing: wait for on-device rows up to their own budgets. */
        const val DEVICE_WAIT_MS = 30_000L

        /** Now-playing info: show or film title, episode line, backdrop art. */
        fun metadata(r: PlayRequest?): MediaMetadata {
            if (r == null) return MediaMetadata.EMPTY
            val ep = if (r.type == "tv" && r.season > 0) "S${r.season} E${r.episode}" + (r.epTitle?.let { " · $it" } ?: "") else null
            return MediaMetadata.Builder()
                .setTitle(r.title)
                .setDisplayTitle(r.title)
                .setSubtitle(ep)
                .setArtist(ep)
                .setDescription(r.overview)
                .setArtworkUri((Api.image(r.backdrop, "w780") ?: Api.image(r.poster, "w342"))?.let(Uri::parse))
                .setMediaType(if (r.type == "tv") MediaMetadata.MEDIA_TYPE_TV_SHOW else MediaMetadata.MEDIA_TYPE_MOVIE)
                .build()
        }

        private val ISO = mapOf("telugu" to "te", "tamil" to "ta", "hindi" to "hi", "malayalam" to "ml", "kannada" to "kn", "english" to "en")
        fun isoFor(label: String): Array<String> = ISO[label.lowercase()]?.let { arrayOf(it, label) } ?: arrayOf(label)
        fun langName(code: String?): String? {
            if (code.isNullOrEmpty() || code == "und") return null
            val name = java.util.Locale(code).getDisplayLanguage(java.util.Locale.ENGLISH)
            return name.ifEmpty { code }
        }
    }
}
