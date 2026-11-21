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
import androidx.media3.common.Format
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
import androidx.media3.exoplayer.Renderer
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
import androidx.media3.exoplayer.video.MediaCodecVideoRenderer
import androidx.media3.exoplayer.video.VideoRendererEventListener
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
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

/** [group]: a sheet sub-heading ("In this stream" / "Other servers"); rows with the same group sit under one label. */
data class MenuItem(val key: String, val label: String, val detail: String = "", val selected: Boolean = false, val dim: Boolean = false, val group: String = "")

internal fun streamCount(n: Int) = if (n == 1) "1 stream" else "$n streams"

/** Runs a NetMirror check and says what it found, so the tap is never silent. */
internal suspend fun <T> netmirrorCheck(resolve: suspend () -> List<T>): Pair<List<T>, String> = try {
    val rows = resolve()
    rows to if (rows.isEmpty()) "No NetMirror streams for this title" else "${rows.size} added"
} catch (e: com.chitram.app.resolve.StepException) {
    emptyList<T>() to "NetMirror unavailable"
}

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
        (if (Device.isTv(app)) NoKeyframeSkipRenderersFactory(app) else DefaultRenderersFactory(app)).setEnableDecoderFallback(true),
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
    /** H13: the Telugu row merged under the playing picture, or null. */
    var pairedAudio by mutableStateOf<Source?>(null); private set
    private var pairApplied = false
    private val audioDecoders: Set<String>? by lazy { HybridPair.deviceAudioDecoders() }

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
                // Back on the phone: the TV cast is over, free the LAN proxy (C5).
                if (playing && CastProxy.running) CastProxy.stop(getApplication())
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
            override fun onCues(cueGroup: CueGroup) { cues = cueGroup.cues.joinToString("\n") { Mojibake.fix(it.text?.toString() ?: "") }.trim() }
            override fun onTracksChanged(t: Tracks) { tracks = t; recordAudio(t); if (pairedAudio != null) applyPair(t) else pickPreferredAudio(t); if (landed) current?.let { snapshotCtx(it) } }
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
                checkOfflineLatch()
                checkNotice()
                checkSwitch()
                checkStall()
                checkFrozen()
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

    // Offline latch self-heal (Fire TV never-recovering buffer): goOffline() can
    // latch on a brief false isOffline() reading, and then ONLY netCallback
    // onAvailable clears it. If the default network never actually dropped, that
    // event never fires and the player stays paused with the offline notice
    // forever. So while latched, re-check connectivity each tick and clear it
    // ourselves the moment we are online again, instead of waiting for the event.
    private fun checkOfflineLatch() {
        if (offline && !isOffline()) backOnline()
    }

    // A notice set while already READY (audio-menu messages, "Trying X on the
    // same source") only cleared on a fresh READY transition, so a spinner could
    // sit over a video that is in fact playing. Clear it once the picture is
    // actually advancing.
    private var noticeClearPos = -1L
    private fun checkNotice() {
        if (notice.isEmpty() || offline || phase != Phase.Playing) { noticeClearPos = -1; return }
        val pos = player.currentPosition
        if (isPlaying && pos > noticeClearPos && noticeClearPos >= 0) { notice = ""; noticeClearPos = -1; return }
        noticeClearPos = pos
    }

    // Frozen-playback watchdog: position not advancing while we should be
    // playing. Covers the gaps checkStall misses - a 0-fps decoder freeze stays
    // STATE_READY (no buffering, no error), and a "Reconnecting..." resolve sits
    // in STATE_IDLE. Re-prepare+seek first, then failover if still stuck.
    private var frozenPos = -1L
    private var frozenSince = 0L
    private var frozenRepreparedAt = 0L
    private fun checkFrozen() {
        val active = landed && !offline && phase == Phase.Playing &&
            player.playWhenReady && !isPlaying &&
            player.playbackState != Player.STATE_ENDED
        if (!active) { frozenSince = 0; frozenRepreparedAt = 0; return }
        val now = System.currentTimeMillis()
        val pos = player.currentPosition
        if (frozenSince == 0L || pos > frozenPos + 250) { frozenSince = now; frozenPos = pos; frozenRepreparedAt = 0; return }
        val stuckFor = now - frozenSince
        // One re-prepare+seek (cheap, keeps the source) before the heavier switch.
        if (frozenRepreparedAt == 0L && stuckFor >= FROZEN_REPREPARE_MS) {
            frozenRepreparedAt = now
            android.util.Log.i("Chitram", "recover: frozen ${stuckFor}ms at ${pos}ms, re-prepare ${current?.provider}")
            val seekTo = pos.coerceAtLeast(0)
            runCatching { player.prepare(); player.seekTo(seekTo); player.play() }
            return
        }
        if (stuckFor >= FROZEN_FAILOVER_MS) {
            frozenSince = 0; frozenRepreparedAt = 0
            failover("${current?.provider ?: "Source"}: frozen", pos.coerceAtLeast(0), LoadingModel.Reason.STOPPED)
        }
    }

    private var selectedAudioLanguage: String? = null
    private var languageTrial: String? = null
    private val discoveredAudio = HashMap<String, List<String>>()
    private var languageFallback: Triple<Source, String?, Long>? = null
    private fun desiredAudio(): String = selectedAudioLanguage ?: g.prefs.preferredAudio()

    fun start(r: PlayRequest) {
        if (request == r) return
        saveProgress()
        if (request?.id != r.id || request?.type != r.type) selectedAudioLanguage = null
        request = r
        netmirrorNote = null
        languageTrial = null
        languageFallback = null
        discoveredAudio.clear()
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
            // Include jobs completing between the initial snapshot and listener setup.
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

    /** `pairAudio` (H13): merge that row's Telugu audio under this row's picture. */
    fun play(s: Source, startMs: Long = player.currentPosition.coerceAtLeast(0), pairAudio: Source? = null, audioLanguage: String? = selectedAudioLanguage) {
        selectedAudioLanguage = audioLanguage?.takeIf { it.isNotBlank() }
        pairedAudio = pairAudio
        pairApplied = false
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
            .setPreferredAudioLanguages(*isoFor(desiredAudio()))
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
            .build()
        if (pairAudio != null) {
            // H13: picture first, Telugu second. Each half keeps its own headers, token and swap.
            val audioItem = MediaItem.Builder().setUri(pairAudio.url)
                .apply { if (!pairAudio.progressive) setMimeType(MimeTypes.APPLICATION_M3U8) }.build()
            android.util.Log.i("Chitram", "[hybrid] ${s.provider} video + ${pairAudio.provider} ${g.prefs.preferredAudio()} audio, offset ${HybridPair.OFFSET_US}us")
            player.setMediaSource(HybridPair.merge(sourceFor(s, item), sourceFor(pairAudio, audioItem)), startMs)
        } else if (s.onDevice != null || TsAudioSwap.wanted(s)) {
            player.setMediaSource(sourceFor(s, item), startMs)
        } else {
            player.setMediaItem(item, startMs)
        }
        player.prepare()
        player.playWhenReady = true
        phase = Phase.Playing
        status = ""
        startNoPictureGuard(s)
    }

    /**
     * Provider Referer/Origin on every request; vaplayer's token on every segment.
     * Caption files go out plain: the provider headers and vaplayer token are for the stream only.
     * A muxed CastleTV row (VM or device) gets the TS audio swap: the player keeps only the first AAC PID.
     */
    private fun sourceFor(s: Source, item: MediaItem): androidx.media3.exoplayer.source.MediaSource {
        val swap = if (TsAudioSwap.wanted(s)) TsAudioSwap(desiredAudio()) else null
        if (s.onDevice == null && swap == null) return DefaultMediaSourceFactory(OkHttpDataSource.Factory(g.api.client)).createMediaSource(item)
        val streamClient = StreamInterceptor.client(g.api.client, s.headers, s.segmentToken)
            .let { c -> if (swap == null) c else c.newBuilder().addInterceptor(swap).build() }
        if (swap != null) android.util.Log.i("Chitram", "[tsaudio] ${s.provider}: swapping in ${g.prefs.preferredAudio()} from ${s.languages.joinToString("/")}")
        val http = OkHttpDataSource.Factory(okhttp3.Call.Factory { req ->
            if (subs.any { it.url == req.url.toString() }) g.api.client.newCall(req) else streamClient.newCall(req)
        })
        return DefaultMediaSourceFactory(http).createMediaSource(item)
    }

    /** H13: once both halves have tracks, pin the picture's video and the Telugu audio. */
    private fun applyPair(t: Tracks) {
        val a = pairedAudio ?: return
        if (pairApplied) return
        val (v, au) = HybridPair.overrides(t, isoFor(desiredAudio()).toList()) ?: return
        pairApplied = true
        audioPickedFor = current?.id
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
            .setOverrideForType(v).setOverrideForType(au).build()
        android.util.Log.i("Chitram", "[hybrid] picked video ${v.mediaTrackGroup.id} and audio ${au.mediaTrackGroup.id} from ${a.provider}")
    }

    /** Fatal error policy (web/lib/player/fatalPolicy.js): stale link refreshes once, else next source. */
    private fun handleError(e: PlaybackException) {
        pairedAudio?.let { a ->
            // A failed pair falls back to the Telugu row on its own: never lose the Telugu audio.
            android.util.Log.w("Chitram", "[hybrid] pair failed (${e.errorCodeName}), playing ${a.provider} alone")
            notice = "Playing ${label(a)} for ${g.prefs.preferredAudio()}…"
            play(a, player.currentPosition.coerceAtLeast(0))
            return
        }
        val http = generateSequence<Throwable>(e) { it.cause }.filterIsInstance<HttpDataSource.InvalidResponseCodeException>().firstOrNull()
        val pos = player.currentPosition.coerceAtLeast(0)
        val cur = current
        val action = FailPolicy.onError(cur, http?.responseCode, refreshedOnce, cur?.onDevice in reresolved, offline = offline || isOffline(), twinTried = cur?.provider?.lowercase() in twinTried, languageSelection = languageTrial != null)
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
            val rows = g.onDevice.resolveAll(key, r.type, r.id, r.season, r.episode, g.codecs, desiredAudio(), fresh = true, title = r.title)
            val eligible = languageTrial?.let { AudioChoice.candidates(rows, it, tried) } ?: rows
            val fresh = eligible.find { it.id == s.id } ?: Ranking.rank(eligible, desiredAudio()).firstOrNull { it.id !in tried }
            if (request != r) return@launch
            if (fresh == null) { failover("$reason, re-resolve failed", pos, why); return@launch }
            if (why == LoadingModel.Reason.NO_ANSWER && FailPolicy.unchangedNetmirrorRetry(s, fresh)) {
                android.util.Log.i("Chitram", "netmirror: unchanged CDN target after timeout; advancing instead of reattaching")
                failover("NetMirror CDN did not respond", pos, why)
                return@launch
            }
            if (fresh.id != s.id) tried += s.id
            putSources(Ranking.merge(sources, rows, desiredAudio(), null))
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
        if (twin != null && twin.id !in tried && (languageTrial == null || AudioChoice.candidates(listOf(twin), languageTrial!!).isNotEmpty())) {
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
            val rows = g.onDevice.resolveAll(name, r.type, r.id, r.season, r.episode, g.codecs, desiredAudio(), fresh = true, title = r.title)
            val eligible = languageTrial?.let { AudioChoice.candidates(rows, it, tried) } ?: rows
            val fresh = Ranking.rank(eligible, desiredAudio()).firstOrNull { it.id !in tried }
            if (request != r) return@launch
            if (fresh == null || fresh.id in tried) { failover("$reason, device resolve failed", pos, why); return@launch }
            endAttempt(LoadingModel.RowState.FAILED, why)
            tried += s.id
            report(s, ok = false, reason = reason)
            putSources(Ranking.merge(sources, rows, desiredAudio(), null))
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
        val pool = languageTrial?.let { AudioChoice.candidates(sources, it, tried) } ?: sources
        val next = PlayPolicy.nextAlive(pool, tried, languageTrial ?: ctxLang ?: desiredAudio(), ctxHeight)
        if (next == null && languageTrial != null) {
            val language = languageTrial
            val fallback = languageFallback
            languageTrial = null
            languageFallback = null
            if (fallback != null) {
                play(fallback.first, fallback.third, audioLanguage = fallback.second)
                notice = "No playable $language stream responded. Restored previous stream."
                return
            }
        }
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
                when (FailPolicy.onError(s, null, refreshedOnce, s.onDevice in reresolved, offline = isOffline(), twinTried = s.provider.lowercase() in twinTried, languageSelection = languageTrial != null)) {
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
        if (languageTrial != null && ctxLang.equals(languageTrial, true)) { languageTrial = null; languageFallback = null }
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
        val want = isoFor(desiredAudio()).map { it.lowercase() }
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
            var lastFrames = -1
            while (isActive) {
                delay(1000)
                if (current !== s) return@launch
                if (!player.isPlaying) { movingSince = 0; continue }
                val counters = player.videoDecoderCounters?.also { it.ensureUpdated() }
                val frames = counters?.renderedOutputBufferCount ?: 0
                // A picture is playing once frames keep coming. One forced first frame
                // followed by none (Fire TV 1.2.19: decoder flushed, 0 fps) is still no picture.
                if (frames >= PICTURE_FRAMES) return@launch
                if (frames != lastFrames) { lastFrames = frames; basePos = -1; movingSince = 0; continue }
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
        sources = list.map { source -> discoveredAudio[source.id]?.let { source.copy(languages = it, audioLanguages = it, selectableAudio = it.size > 1) } ?: source }
        labels = LoadingModel.labelRows(labels, sources)
    }

    private fun recordAudio(t: Tracks) {
        if (pairedAudio != null) return
        val source = current ?: return
        val known = t.groups.filter { it.type == C.TRACK_TYPE_AUDIO }.flatMap { group ->
            (0 until group.length).filter { group.isTrackSupported(it) }.mapNotNull { i ->
                val f = group.getTrackFormat(i)
                langName(f.language) ?: Ranking.languageLabel(f.label)
            }
        }.filter(AudioChoice::knownLanguage).distinctBy { it.lowercase() }
        if (known.isEmpty()) return
        discoveredAudio[source.id] = known
        current = source.copy(languages = known, audioLanguages = known, selectableAudio = known.size > 1)
        putSources(sources)
        val wanted = languageTrial
        if (wanted != null && known.none { it.equals(wanted, true) }) viewModelScope.launch {
            if (current?.id == source.id && languageTrial == wanted) failover("$wanted audio missing", player.currentPosition.coerceAtLeast(0))
        }
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
    suspend fun castSpec(): WvcCast.Spec? {
        // A pair is merged on the phone only; the TV gets the Telugu row itself.
        val s = pairedAudio ?: current ?: return null
        val r = request ?: return null
        player.pause()
        saveProgress()
        // C5: an on-device row goes through the phone's LAN proxy (headers + token added here).
        val lan = if (s.onDevice == null) null else withContext(Dispatchers.IO) {
            try { CastProxy.start(getApplication(), s, g.api.client, g.prefs.preferredAudio()) } catch (e: Exception) {
                android.util.Log.w("Chitram", "[lanproxy] start failed: ${e.javaClass.simpleName}: ${e.message}"); null
            }
        }
        return WvcCast.spec(s, r, lan)
    }

    fun togglePlay() { if (player.isPlaying) player.pause() else { if (player.playbackState == Player.STATE_ENDED) player.seekTo(0); player.play() } }
    fun seekTo(ms: Long) { player.seekTo(ms.coerceIn(0, if (player.duration > 0) player.duration else Long.MAX_VALUE)); positionMs = player.currentPosition }
    fun seekBy(ms: Long) { player.seekTo((player.currentPosition + ms).coerceIn(0, if (player.duration > 0) player.duration else Long.MAX_VALUE)); positionMs = player.currentPosition }

    // ---- Menus ---------------------------------------------------------------

    fun serverItems(provider: String? = null): List<MenuItem> {
        if (provider == null) return sources.groupBy { it.provider.lowercase() }.map { (_, rows) ->
            val name = rows.first().provider
            val languages = rows.flatMap(AudioChoice::languages).distinct().take(3).joinToString(", ")
            MenuItem("group:$name", name, listOf(streamCount(rows.size), languages).filter { it.isNotEmpty() }.joinToString(" · "), rows.any { it.id == current?.id })
        } + if (sources.none { it.provider.equals("netmirror", true) }) listOf(MenuItem("group:NetMirror", "NetMirror", "Check streams on demand")) else emptyList()
        return Ranking.menuOrder(sources.filter { it.provider.equals(provider, true) }).map { source ->
            val languages = AudioChoice.languages(source).joinToString(", ").ifEmpty { "Unknown audio" }
            val quality = Ranking.height(source).takeIf { it > 0 }?.let { "${it}p" } ?: source.quality
            val detail = listOfNotNull(source.netmirrorCatalog, quality, languages,
                if (source.incomplete) "More streams pending" else null,
                if (source.unsupported) "Not supported here" else null).joinToString(" · ")
            MenuItem("src:${source.id}", label(source), detail, source.id == current?.id, source.unsupported)
        }
    }

    var checkingNetmirror by mutableStateOf(false); private set
    /** Result of the last NetMirror check, shown on the Check row. */
    var netmirrorNote by mutableStateOf<String?>(null); private set
    fun checkNetmirror() {
        val r = request ?: return
        if (checkingNetmirror) return
        checkingNetmirror = true
        netmirrorNote = null
        viewModelScope.launch {
            val t0 = System.currentTimeMillis()
            try {
                val (rows, note) = netmirrorCheck { g.onDevice.resolveAll("netmirror", r.type, r.id, r.season, r.episode, g.codecs, desiredAudio(), fresh = true, title = r.title) }
                android.util.Log.i("Chitram", "[netmirror] check: ${rows.size} rows")
                if (request == r) putSources(Ranking.merge(sources, rows, desiredAudio(), null))
                // A cached answer comes back in ~100ms; keep "Checking sources…" up long enough to read.
                delay((600 - (System.currentTimeMillis() - t0)).coerceAtLeast(0))
                netmirrorNote = note
            } finally { checkingNetmirror = false }
        }
    }

    private fun groups(type: Int) = tracks.groups.filter { it.type == type }

    fun audioItems(): List<MenuItem> =
        audioMenu(groups(C.TRACK_TYPE_AUDIO), sources, current,
            unnamed = current?.let { LoadingModel.langOf(it, desiredAudio()) },
            curLang = current?.let { LoadingModel.langOf(it, g.prefs.preferredAudio()) })

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

    fun subtitleItems(): List<MenuItem> =
        subtitleMenu(groups(C.TRACK_TYPE_TEXT), C.TRACK_TYPE_TEXT in player.trackSelectionParameters.disabledTrackTypes)

    fun choose(key: String) {
        val p = key.split(":")
        when (p[0]) {
            "lang" -> {
                val language = key.removePrefix("lang:")
                val all = AudioChoice.candidates(sources, language)
                if (all.isEmpty()) { notice = "No playable $language stream found yet."; return }
                if (AudioChoice.candidates(sources, language, tried).isEmpty()) all.forEach { tried.remove(it.id) }
                // A1: the playing source with no track in this language cannot
                // switch anything; go to another server or say there is none.
                val next = nextForLanguage(AudioChoice.candidates(sources, language, tried), all, current?.id, carries(groups(C.TRACK_TYPE_AUDIO), language))
                if (next == null) { notice = "No other $language stream found"; return }
                languageFallback = current?.let { Triple(it, selectedAudioLanguage ?: ctxLang, player.currentPosition.coerceAtLeast(0)) }
                languageTrial = language
                selectedAudioLanguage = language
                audioPickedFor = null
                if (next.id == current?.id) {
                    player.trackSelectionParameters = player.trackSelectionParameters.buildUpon().clearOverridesOfType(C.TRACK_TYPE_AUDIO).setPreferredAudioLanguages(*isoFor(language)).build()
                    pickPreferredAudio(tracks)
                } else play(next, audioLanguage = language)
                notice = "Trying $language on ${label(next)}…"
            }
            // src:<id> from the video sheet, or src:<id>:<lang> from the audio
            // sheet. Provider ids carry no colon (provider-N), so p[1] is the id.
            "src" -> AudioChoice.source(key, sources)?.let { (source, language) ->
                languageTrial = null; languageFallback = null
                if (source.id == current?.id && language == null) return
                if (source.id == current?.id) {
                    selectedAudioLanguage = language
                    audioPickedFor = null
                    player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
                        .clearOverridesOfType(C.TRACK_TYPE_AUDIO).setPreferredAudioLanguages(*isoFor(desiredAudio())).build()
                    pickPreferredAudio(tracks)
                } else {
                    manualPickId = source.id
                    play(source, audioLanguage = language ?: selectedAudioLanguage)
                    notice = "Switching to ${label(source)}…"
                }
            }
            "pair" -> sources.firstOrNull { it.id == p[1] }?.let { a ->
                val v = current ?: return
                play(v, player.currentPosition.coerceAtLeast(0), pairAudio = a, audioLanguage = g.prefs.preferredAudio())
                notice = "${g.prefs.preferredAudio()} from ${label(a)}…"
            }
            "trk" -> {
                languageTrial = null; languageFallback = null
                val gi = p[1].toInt(); val ti = p[2].toInt()
                val format = groups(C.TRACK_TYPE_AUDIO).getOrNull(gi)?.getTrackFormat(ti)
                selectedAudioLanguage = langName(format?.language) ?: format?.label ?: selectedAudioLanguage
                audioPickedFor = current?.id
                override(C.TRACK_TYPE_AUDIO, gi, ti)
            }
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

        /**
         * Frozen-playback watchdog (Fire TV never-recovering buffer). When the
         * position has not advanced while we should be playing: re-prepare+seek
         * after FROZEN_REPREPARE_MS, failover after FROZEN_FAILOVER_MS. This is
         * separate from checkStall (which needs STATE_BUFFERING): a 0-fps decoder
         * freeze stays STATE_READY and raises no error, so only position proves it.
         */
        const val FROZEN_REPREPARE_MS = 12_000L
        const val FROZEN_FAILOVER_MS = 22_000L

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

        const val IN_STREAM = "In this stream"
        const val OTHER_SERVERS = "Other servers"

        private fun known(f: Format): String? =
            langName(f.language) ?: f.label?.takeIf(AudioChoice::knownLanguage)?.let { com.chitram.app.data.Ranking.languageLabel(it) ?: it }

        /** True when the tracks are not known yet, or a supported track is in [language]. */
        internal fun carries(audio: List<Tracks.Group>, language: String): Boolean {
            if (audio.isEmpty()) return true
            val want = com.chitram.app.data.Ranking.languageLabel(language) ?: language
            return audio.any { gr -> (0 until gr.length).any { i -> gr.isTrackSupported(i) && known(gr.getTrackFormat(i))?.equals(want, true) == true } }
        }

        /** Next source for a language pick. The playing source only when it [currentCarries] the language (A1). */
        internal fun nextForLanguage(pool: List<Source>, all: List<Source>, currentId: String?, currentCarries: Boolean): Source? {
            val first = pool.firstOrNull()
            if (first != null && (first.id != currentId || currentCarries)) return first
            return pool.firstOrNull { it.id != currentId } ?: all.firstOrNull { it.id != currentId && !it.unsupported }
        }

        /**
         * Audio sheet. [unnamed] names a track with no language (the row's language);
         * [curLang] is the row shown while tracks are not known yet. A language
         * whose only server is the playing one is left out once its tracks are
         * known: picking it could change nothing (A1).
         */
        internal fun audioMenu(audio: List<Tracks.Group>, sources: List<Source>, current: Source?, unnamed: String?, curLang: String?): List<MenuItem> {
            val out = ArrayList<MenuItem>()
            val names = HashSet<String>()
            audio.forEachIndexed { gi, gr ->
                for (i in 0 until gr.length) {
                    if (!gr.isTrackSupported(i)) continue
                    val f = gr.getTrackFormat(i)
                    // HLS renditions are often named just "Audio"; prefer a language.
                    val name = langName(f.language) ?: f.label?.takeUnless { it.equals("audio", true) || it.isBlank() } ?: unnamed ?: "Default"
                    if (!names.add(name.lowercase())) continue
                    val count = AudioChoice.candidates(sources, name).size
                    out += MenuItem("trk:$gi:$i", name, if (count > 1) "$count streams" else "", gr.isTrackSelected(i), group = IN_STREAM)
                }
            }
            // Tracks not known yet: name the language that will play, not the row's first (A8).
            if (out.isEmpty()) curLang?.let { names += it.lowercase(); out += MenuItem("cur", it, "this server", true, group = IN_STREAM) }
            // Key per language, not per source: one selectable-audio source (a Castle
            // demux row) offers several languages, so a bare src:<id> key repeats and
            // the audio LazyColumn throws "Key already used". (Kubera, 2026-11-21.)
            val known = audio.isNotEmpty()
            for ((lang, rows) in AudioChoice.index(sources)) {
                if (lang.lowercase() in names) continue
                val n = rows.count { !it.unsupported && (!known || it.id != current?.id) }
                if (n == 0) continue
                out += MenuItem("lang:$lang", lang, if (n == 1) "1 stream" else "$n streams", group = OTHER_SERVERS)
            }
            return out
        }

        /** Subtitle sheet: unsupported tracks are left out, like audio and quality (A3). */
        internal fun subtitleMenu(text: List<Tracks.Group>, disabled: Boolean): List<MenuItem> {
            val out = arrayListOf(MenuItem("sub:off", "Off", "", disabled))
            text.forEachIndexed { gi, gr ->
                for (i in 0 until gr.length) {
                    if (!gr.isTrackSupported(i)) continue
                    val f = gr.getTrackFormat(i)
                    out += MenuItem("sub:$gi:$i", f.label ?: langName(f.language) ?: "Subtitles", "", !disabled && gr.isTrackSelected(i))
                }
            }
            return out
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

/** Rendered frames that prove a picture (about 2 s of video); the no-picture guard stops there. */
private const val PICTURE_FRAMES = 50

/**
 * TV only. media3 flushes the video decoder and skips to the next keyframe when
 * an output frame is over 500 ms late (MediaCodecVideoRenderer.maybeDropBuffersToKeyframe).
 * On the Fire TV Stick 4K (API 25 MediaTek AVC) each flush leaves the next output
 * late again, so the decoder flushes about 20 times a second and renders 0 fps
 * while audio plays (1.2.19, CastleTV Telugu). Late frames are still dropped one
 * by one (shouldDropOutputBuffer), so the picture catches up without a flush.
 */
private class NoKeyframeSkipRenderersFactory(context: android.content.Context) : DefaultRenderersFactory(context) {
    override fun buildVideoRenderers(
        context: android.content.Context, extensionRendererMode: Int, mediaCodecSelector: MediaCodecSelector,
        enableDecoderFallback: Boolean, eventHandler: android.os.Handler, eventListener: VideoRendererEventListener,
        allowedVideoJoiningTimeMs: Long, out: ArrayList<Renderer>,
    ) {
        val start = out.size
        super.buildVideoRenderers(context, extensionRendererMode, mediaCodecSelector, enableDecoderFallback, eventHandler, eventListener, allowedVideoJoiningTimeMs, out)
        val i = (start until out.size).firstOrNull { out[it] is MediaCodecVideoRenderer } ?: return
        out[i] = NoKeyframeSkipVideoRenderer(context, codecAdapterFactory, mediaCodecSelector, allowedVideoJoiningTimeMs, enableDecoderFallback, eventHandler, eventListener)
    }
}

private class NoKeyframeSkipVideoRenderer(
    context: android.content.Context, factory: androidx.media3.exoplayer.mediacodec.MediaCodecAdapter.Factory,
    selector: MediaCodecSelector, joiningMs: Long, fallback: Boolean, handler: android.os.Handler, listener: VideoRendererEventListener,
) : MediaCodecVideoRenderer(context, factory, selector, joiningMs, fallback, handler, listener, DefaultRenderersFactory.MAX_DROPPED_VIDEO_FRAME_COUNT_TO_NOTIFY) {
    public override fun shouldDropBuffersToKeyframe(earlyUs: Long, elapsedRealtimeUs: Long, isLastBuffer: Boolean): Boolean = false
}
