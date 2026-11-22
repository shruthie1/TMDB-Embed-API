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
    /** TMDB original language ("te") from the title details already loaded: a MultiMovies "Original" source takes it. */
    val originalLang: String? = null,
)

/** [group]: a sheet sub-heading ("In this stream" / "Other servers"); rows with the same group sit under one label. */
data class MenuItem(val key: String, val label: String, val detail: String = "", val selected: Boolean = false, val dim: Boolean = false, val group: String = "")

/** Source list row key of "Refresh sources" (MenuTap.Refresh). */
internal const val REFRESH_KEY = "refresh:sources"

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
    /**
     * True while a server switch the VIEWER asked for is in flight (Server menu,
     * language pick, Details row, pair pick): the loading card says "Switching
     * server…", never a slow or failed line. An automatic failover never sets it.
     * Cleared on the first frame, on any failure, and on a title or episode change.
     */
    var switching by mutableStateOf(false); private set
    private var firstListSize = 0
    /** One stable label per row id (LoadingModel.labelRows): menus, notices and Details agree. */
    var labels by mutableStateOf<Map<String, String>>(emptyMap()); private set
    private var resolveStartMs = 0L

    /** The player's base client: the shared pool, plus the castle-demux master codec fill (MasterCodecs). */
    private val playerHttp: okhttp3.OkHttpClient = com.chitram.app.resolve.PlaylistInterceptor.attach(
        g.api.client.newBuilder().addInterceptor(MasterCodecs).build(), g.playlists) { isoFor(desiredAudio()).toList() }

    /** First-play timing (fix D): master / variant / seg0 logged once per play(), first frame once per tap. Before [player]: its data sources report bytes to it. */
    private val loadMarks = LoadMarks()

    /** Start cap: a lower rendition until each play's first frame (StartCapMeter). */
    private val startMeter = StartCapMeter(androidx.media3.exoplayer.upstream.DefaultBandwidthMeter.getSingletonInstance(app))

    val player: ExoPlayer = ExoPlayer.Builder(
        app,
        (if (Device.isTv(app)) NoKeyframeSkipRenderersFactory(app) else DefaultRenderersFactory(app)).setEnableDecoderFallback(true),
    )
        .setMediaSourceFactory(DefaultMediaSourceFactory(OkHttpDataSource.Factory(playerHttp).setTransferListener(loadMarks.bytes)))
        // Smaller buffer than the default: the 2018 stick has 1.5 GB RAM.
        .setLoadControl(DefaultLoadControl.Builder().setBufferDurationsMs(15_000, 40_000, 1_500, 3_000).build())
        .setBandwidthMeter(startMeter)
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
    /**
     * mapple-speed-2: mapple's background search for the preferred language after
     * it returned a non-preferred front at once; [deviceLate] gets that row (or
     * nothing). Same life as [deviceJobs].
     */
    private var deviceBg: Job? = null
    private var deviceLate: Deferred<List<Source>>? = null
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
    /** Rows (DirectRoute.key) whose direct play failed before a frame: proxy from now on. */
    private val directFailed = HashSet<String>()
    /**
     * A first frame was rendered since the last play() (direct fallback gate). A per-play
     * flag, not `framed` (once per title start, so a later switch would never fall back)
     * and not identity (recordAudio replaces `current` with a copy).
     */
    private var framedThisPlay = false
    /** Lines traced for this play (LoadTrace): before the first frame only, at most LoadTrace.MAX. */
    private var traced = 0
    private fun trace(event: String, detail: String) {
        if (framedThisPlay || playStartedAt == 0L || traced >= LoadTrace.MAX) return
        traced++
        android.util.Log.i("Chitram", LoadTrace.line(event, System.currentTimeMillis() - playStartedAt, detail))
    }
    private var firstFrameLogged = false
    private var directJob: Job? = null
    /** H13: the Telugu row merged under the playing picture, or null. */
    var pairedAudio by mutableStateOf<Source?>(null); private set
    private var pairApplied = false
    /** True when [pairedAudio] is in a server-fused master (one url), false for the on-device merge (Task 6 seam). */
    private var pairFused = false
    /** Step 2: the explicit "Add <L> audio" journey (rules in AddAudio.Journey), and its one in-flight donor check. */
    private val journey = AddAudio.Journey()
    private var addJob: Job? = null
    private var addedNotice: String? = null
    /** Start position of the pair the journey asked for (AddAudio.Effect.PlayPair). */
    private var pairAtMs: Long? = null
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
    /**
     * The watchdog (or a dead proxy host) judged this play dead. Kept apart
     * from [landed]: a judged row is not landed, so checkRuntime never reports
     * it ok (multimovies-slow-rca.md side finding: ok + fail pairs).
     */
    private var judged = false
    /** This play got playlists or segments (FailPolicy rowDelivered). */
    private var deliveredThisPlay = false
    private var runtimeDone = false
    /** Language and height playing when the last row landed: auto-advance keeps them (U7). */
    private var ctxLang: String? = null
    private var ctxHeight: Int? = null

    // Offline (U8).
    private var resumeOnReturn = false
    /** startMs of a resolve that could not run offline; replayed when the network returns. */
    private var pendingResolveMs: Long? = null
    /** "Every source failed" was reached while offline: the network coming back re-resolves from [failedAtMs]. */
    private var failedWhileOffline = false
    private var failedAtMs = 0L
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
                    // The run's pair is playing: the add-audio run is over (web landed(), I2).
                    journey.ready(journeyScreen())
                    // "<L> audio added from <server>." is said once the pair is ready, not wiped by it.
                    if (!offline) { notice = addedNotice ?: ""; addedNotice = null }
                }
                if (state == Player.STATE_ENDED) onEnded()
            }
            override fun onVideoSizeChanged(size: VideoSize) { videoSize = size }
            override fun onRenderedFirstFrame() {
                framedThisPlay = true; directJob?.cancel(); markFramed()
                startMeter.capped = false
                current?.let { watchPlayed(it) }
                if (!firstFrameLogged && requestedAt > 0) {
                    firstFrameLogged = true
                    val now = System.currentTimeMillis()
                    android.util.Log.i("Chitram", firstFrameLine(now - requestedAt, current?.provider, now - playStartedAt))
                }
            }
            override fun onCues(cueGroup: CueGroup) { cues = cueGroup.cues.joinToString("\n") { Mojibake.fix(it.text?.toString() ?: "") }.trim() }
            override fun onTracksChanged(t: Tracks) { tracks = t; recordAudio(t); if (pairedAudio != null && !pairFused) applyPair(t) else pickPreferredAudio(t); if (landed) current?.let { snapshotCtx(it) } }
            override fun onPlayerError(error: PlaybackException) { handleError(error) }
        })
        player.addAnalyticsListener(object : androidx.media3.exoplayer.analytics.AnalyticsListener {
            override fun onLoadError(
                eventTime: androidx.media3.exoplayer.analytics.AnalyticsListener.EventTime,
                loadEventInfo: androidx.media3.exoplayer.source.LoadEventInfo,
                mediaLoadData: androidx.media3.exoplayer.source.MediaLoadData,
                error: java.io.IOException,
                wasCanceled: Boolean,
            ) {
                trace("load-error", LoadTrace.load(mediaLoadData.dataType, mediaLoadData.trackType, mediaLoadData.trackFormat?.language, loadEventInfo.loadDurationMs, loadEventInfo.bytesLoaded, loadEventInfo.uri.toString()) +
                    " " + LoadTrace.error(error) + if (wasCanceled) " canceled" else "")
                if (!wasCanceled) onLoadFailed(loadEventInfo.uri.toString(), error)
            }
            override fun onLoadStarted(
                eventTime: androidx.media3.exoplayer.analytics.AnalyticsListener.EventTime,
                loadEventInfo: androidx.media3.exoplayer.source.LoadEventInfo,
                mediaLoadData: androidx.media3.exoplayer.source.MediaLoadData,
            ) { trace("load-start", LoadTrace.load(mediaLoadData.dataType, mediaLoadData.trackType, mediaLoadData.trackFormat?.language, -1, -1, loadEventInfo.uri.toString())) }
            override fun onLoadCanceled(
                eventTime: androidx.media3.exoplayer.analytics.AnalyticsListener.EventTime,
                loadEventInfo: androidx.media3.exoplayer.source.LoadEventInfo,
                mediaLoadData: androidx.media3.exoplayer.source.MediaLoadData,
            ) { trace("load-cancel", LoadTrace.load(mediaLoadData.dataType, mediaLoadData.trackType, mediaLoadData.trackFormat?.language, loadEventInfo.loadDurationMs, loadEventInfo.bytesLoaded, loadEventInfo.uri.toString())) }
            override fun onLoadCompleted(
                eventTime: androidx.media3.exoplayer.analytics.AnalyticsListener.EventTime,
                loadEventInfo: androidx.media3.exoplayer.source.LoadEventInfo,
                mediaLoadData: androidx.media3.exoplayer.source.MediaLoadData,
            ) {
                trace("load-done", LoadTrace.load(mediaLoadData.dataType, mediaLoadData.trackType, mediaLoadData.trackFormat?.language, loadEventInfo.loadDurationMs, loadEventInfo.bytesLoaded, loadEventInfo.uri.toString()))
                val kind = loadMarks.mark(mediaLoadData.dataType) ?: return
                android.util.Log.i("Chitram", loadLine(kind, loadEventInfo.loadDurationMs, System.currentTimeMillis() - playStartedAt, loadEventInfo.uri.toString()))
            }
            override fun onVideoInputFormatChanged(
                eventTime: androidx.media3.exoplayer.analytics.AnalyticsListener.EventTime,
                format: androidx.media3.common.Format,
                decoderReuseEvaluation: androidx.media3.exoplayer.DecoderReuseEvaluation?,
            ) { trace("video-format", "${format.sampleMimeType} ${format.width}x${format.height}") }
            override fun onAudioInputFormatChanged(
                eventTime: androidx.media3.exoplayer.analytics.AnalyticsListener.EventTime,
                format: androidx.media3.common.Format,
                decoderReuseEvaluation: androidx.media3.exoplayer.DecoderReuseEvaluation?,
            ) { trace("audio-format", "${format.sampleMimeType} lang=${format.language}") }
            override fun onPlaybackStateChanged(eventTime: androidx.media3.exoplayer.analytics.AnalyticsListener.EventTime, state: Int) {
                trace("state", LoadTrace.state(state) + " pos=${player.currentPosition} buffered=${player.bufferedPosition}")
            }
            override fun onPositionDiscontinuity(
                eventTime: androidx.media3.exoplayer.analytics.AnalyticsListener.EventTime,
                oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int,
            ) { trace("discontinuity", "reason=$reason ${oldPosition.positionMs}->${newPosition.positionMs}") }
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
        // The old stream keeps playing while donors are checked: keep "Checking …" up until the check ends.
        if (addJob?.isActive == true && notice == journey.active?.checking) { noticeClearPos = -1; return }
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
        refreshJob?.cancel()
        refreshModel = RefreshModel()
        languageTrial = null
        languageFallback = null
        runEffects(journey.drop())
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
        firstFrameLogged = false
        android.util.Log.i("Chitram", startLine(r.type, r.id, r.season, r.episode, requestedAt))
        resetStart()
        subs = emptyList()
        subsJob?.cancel()
        val job = viewModelScope.async { OpenSubs.fetchKept(g.api.client, r.imdbId, r.season, r.episode, r.runtimeMin) }
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
            deviceBg?.cancel()
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
            val saved = g.lastProvider.get(r.type, r.id, r.season, r.episode)
            val pin = keepProvider ?: saved?.provider
            val manualPin = keepProvider != null || saved?.manual == true
            val preferred = g.prefs.preferredAudio()
            // VM breaker open: no VM call, MultiMovies, showsst and OneTouchTV resolve on the device instead.
            val vmDown = !g.api.vmUp
            val names = g.onDevice.names(vmDown)
            // prewarm.md: providers the details page already resolved. Each continues from that job;
            // one Play would start only on a VM failure (multimovies, vidrift) joins the first list now.
            val (keptNames, jobNames) = if (keep) emptyList<String>() to emptyList() else g.onDevice.warmSplit(r.type, r.id, r.season, r.episode, preferred)
            val warmNames = g.onDevice.names(vmDown = true).filter { it in keptNames || it in jobNames }
            val warmExtra = warmNames.filter { it !in names }
            val device = if (keep) deviceJobs else {
                val bg = kotlinx.coroutines.SupervisorJob(viewModelScope.coroutineContext[Job])
                val late = kotlinx.coroutines.CompletableDeferred<List<Source>>()
                deviceBg = bg
                deviceLate = late
                g.onDevice.launchAll(viewModelScope, r.type, r.id, r.season, r.episode, g.codecs, preferred, r.title, vmDown, r.originalLang,
                    late = late, lateScope = kotlinx.coroutines.CoroutineScope(viewModelScope.coroutineContext + bg)) +
                    warmExtra.map { n -> viewModelScope.async { g.onDevice.resolveAll(n, r.type, r.id, r.season, r.episode, g.codecs, preferred, title = r.title, originalLang = r.originalLang) } }
            }.also { d ->
                if (keep) return@also
                deviceNames = names + warmExtra
                d.zip(names + warmExtra).forEach { (job, n) -> watchCheck(job, n, t0) }
            }
            deviceJobs = device
            val warmJobs = if (keep) emptyList() else device.zip(names + warmExtra).filter { (_, n) -> n in warmNames }.map { it.first }
            OnDeviceResolver.raceLines(keptNames, jobNames).forEach { android.util.Log.i("Chitram", it) }
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
            // Fix A: VM-down-only providers start once the VM fails or its lead ends with no row in the viewer's language.
            val first = StartRace().firstMany(vm, device, preferred, warm = warmJobs, extras = if (vm == null) null else { why ->
                startVmDownJobs(r, preferred, t0, vmDownExtras(g.onDevice.names(vmDown = true), g.onDevice.names(vmDown = false), deviceNames), why)
            })
            val backend = first.backend
            val backendError = first.backendError
            if (!first.backendPending) {
                endCheck(LoadingModel.CHECK_SERVER, backend.size)
                if (vm == null || backendError != null) launchVmDownOnly(r, preferred, pin, manualPin, t0)
            }
            // Same provider from both sides: the VM row shows, the device row waits as its twin.
            val (shown, twinMap) = StartRace.splitTwins(backend, first.device)
            twins = twinMap
            val list = Ranking.merge(backend, shown, preferred, pin, manualPin)
            putSources(list)
            if (firstListSize == 0) firstListSize = list.size
            listReady = true
            // Include jobs completing between the initial snapshot and listener setup.
            lateJobs = (deviceJobs + listOfNotNull(deviceLate)).map { d -> viewModelScope.launch { joinLate(r, d, preferred, pin, manualPin) } } +
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
            if (phase == Phase.Resolving) {
                // The provider that last played this title starts first, inside the viewer's language (LastPlayed).
                val last = if (keepProvider == null) LastPlayed.startRow(sources, saved, preferred) else null
                if (keepProvider == null && saved != null) android.util.Log.i("Chitram", LastPlayed.line(r.type, r.id, saved.provider, if (last != null) "hit" else "miss"))
                lastHitId = last?.id
                play(last ?: sources.first(), startMs)
            }
        }
    }

    /** Row id started because it was the title's last provider; a failure of it is logged `[last] .. failed`. */
    private var lastHitId: String? = null
    private var playedJob: Job? = null

    /**
     * Remembers the provider once its row, on screen since its first frame, has
     * played LastProviderStore.PLAYED_MS: a row that dies in the first seconds
     * never becomes the title's start row.
     */
    private fun watchPlayed(row: Source) {
        val r = request ?: return
        playedJob?.cancel()
        val framedAt = player.currentPosition.coerceAtLeast(0)
        val manual = row.id == manualPickId
        playedJob = viewModelScope.launch {
            while (true) {
                delay(1_000)
                val same = current?.id == row.id && request == r
                if (!same) return@launch
                if (LastPlayed.played(framedAt, player.currentPosition, same)) {
                    g.lastProvider.put(r.type, r.id, row.provider, manual = manual, season = r.season, episode = r.episode)
                    android.util.Log.i("Chitram", LastPlayed.line(r.type, r.id, row.provider, "saved"))
                    return@launch
                }
            }
        }
    }

    /** One loading-screen check row per on-device provider, closed when its resolve ends. */
    private fun watchCheck(job: Deferred<List<Source>>, name: String, t0: Long) {
        val id = "check:$name"
        checks = checks + LoadingModel.Check(id, "${CHECK_LABELS[name] ?: name} (on phone)", t0)
        viewModelScope.launch { val got = runCatching { job.await() }.getOrNull(); endCheck(id, got?.size ?: 0) }
    }

    /**
     * The VM is down or failed: start every VM-down-only on-device provider
     * (MultiMovies, showsst, OneTouchTV, Vidrift) not already running, once per start.
     * Each joins late on its own; nothing here waits, so the first row is not delayed.
     */
    private fun launchVmDownOnly(r: PlayRequest, preferred: String, pin: String?, manualPin: Boolean, t0: Long) {
        for (d in startVmDownJobs(r, preferred, t0, vmDownExtras(g.onDevice.names(vmDown = true), g.onDevice.names(vmDown = false), deviceNames), "VM failed after start")) {
            lateJobs = lateJobs + viewModelScope.launch { joinLate(r, d, preferred, pin, manualPin) }
        }
    }

    /** Starts [names] on the device (each recorded in deviceNames, so never twice) and returns their jobs. */
    private fun startVmDownJobs(r: PlayRequest, preferred: String, t0: Long, names: List<String>, why: String): List<Deferred<List<Source>>> {
        if (names.isNotEmpty()) android.util.Log.i("Chitram", "[race] $why: starting ${names.joinToString(",")} on device after ${System.currentTimeMillis() - t0}ms")
        return names.map { n ->
            deviceNames = deviceNames + n
            val d = viewModelScope.async { g.onDevice.resolveAll(n, r.type, r.id, r.season, r.episode, g.codecs, preferred, title = r.title, originalLang = r.originalLang) }
            deviceJobs = deviceJobs + d
            watchCheck(d, n, t0)
            d
        }
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
        if (rows == null) { launchVmDownOnly(r, preferred, pin, manualPin, t0); return }
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

    /**
     * `pairAudio` (H13): the row lending its audio. With [fused] (Step 2) [s] is
     * already the server-fused master and plays as one url; without it the two
     * rows are merged on the device (Task 6 path).
     */
    fun play(row: Source, startMs: Long = player.currentPosition.coerceAtLeast(0), pairAudio: Source? = null, audioLanguage: String? = selectedAudioLanguage, fused: Boolean = false) {
        // Direct when the server's provider config allows it and this row has
        // not failed direct before; else the proxied url, as before (DirectRoute).
        val s = DirectRoute.forPlay(row, directFailed)
        if (row.directUrl != null) android.util.Log.i("Chitram", DirectRoute.logLine(if (DirectRoute.isDirect(s)) "direct" else "proxy", s,
            "reason=" + if (DirectRoute.isDirect(s)) "config-direct" else "direct-failed-before"))
        framedThisPlay = false
        startMeter.capped = true
        loadMarks.reset()
        traced = 0
        directJob?.cancel()
        // Another picture replaces the run's: no late donor answer may land on it.
        if (pairAudio == null) runEffects(journey.otherPicture(s.id))
        selectedAudioLanguage = audioLanguage?.takeIf { it.isNotBlank() }
        pairedAudio = pairAudio
        pairFused = pairAudio != null && fused
        pairApplied = false
        addedNotice = null
        // A row still open here was left by a manual pick: back to waiting, not failed.
        endAttempt(LoadingModel.RowState.WAITING, null)
        attempts = attempts + LoadingModel.Attempt(s.id, System.currentTimeMillis())
        current = s
        cues = ""
        videoSize = VideoSize.UNKNOWN
        playStartedAt = System.currentTimeMillis()
        landed = false
        judged = false
        deliveredThisPlay = false
        runtimeDone = false
        // OpenSubtitles first (Telugu, then English), then any the provider row carries.
        val external = subs.map { t ->
            MediaItem.SubtitleConfiguration.Builder(Uri.parse(t.url))
                .setMimeType(MimeTypes.APPLICATION_SUBRIP).setLabel(t.label).setLanguage(t.lang).build()
        }
        // An HLS subtitle playlist is not a caption file: never sideloaded (PlayPolicy.sideloadable).
        val own = PlayPolicy.sideloadable(s.subtitles).take(12).map { sub ->
            val mime = if (sub.url.contains(".srt", ignoreCase = true)) MimeTypes.APPLICATION_SUBRIP else MimeTypes.TEXT_VTT
            MediaItem.SubtitleConfiguration.Builder(Uri.parse(sub.url))
                .setMimeType(mime).setLabel(sub.lang ?: "Subtitles").setLanguage(sub.lang?.lowercase()).build()
        }
        val item = MediaItem.Builder()
            .setUri(s.url)
            .apply { PlayPolicy.mimeFor(s)?.let { setMimeType(it) } }
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
        if (pairAudio != null && !fused) {
            // H13: picture first, Telugu second. Each half keeps its own headers, token and swap.
            val audioItem = MediaItem.Builder().setUri(pairAudio.url)
                .apply { PlayPolicy.mimeFor(pairAudio)?.let { setMimeType(it) } }.build()
            android.util.Log.i("Chitram", "[hybrid] ${s.provider} video + ${pairAudio.provider} ${desiredAudio()} audio, offset ${HybridPair.OFFSET_US}us")
            player.setMediaSource(HybridPair.merge(sourceFor(s, item), sourceFor(pairAudio, audioItem)), startMs)
        } else if (s.onDevice != null || TsAudioSwap.wanted(s) || s.headers.isNotEmpty()) {
            player.setMediaSource(sourceFor(s, item), startMs)
        } else {
            player.setMediaItem(item, startMs)
        }
        player.prepare()
        player.playWhenReady = true
        phase = Phase.Playing
        status = ""
        startNoPictureGuard(s)
        if (DirectRoute.isDirect(s)) directJob = viewModelScope.launch {
            // No segment and no byte for 6 s, or no frame by 10 s: the same row via the proxy
            // (DirectRoute.stallReason). Checked every 500 ms from 6 s to 10 s (gap 6.3).
            delay(DirectRoute.FIRST_SEGMENT_MS - (System.currentTimeMillis() - playStartedAt).coerceAtLeast(0))
            while (true) {
                val t = System.currentTimeMillis()
                val at = t - playStartedAt
                val why = DirectRoute.stallReason(at, framedThisPlay, loadMarks.segmentLoaded, idleMs = t - maxOf(loadMarks.lastBytesAt, playStartedAt))
                if (why != null) {
                    val playing = current
                    val up = g.api.vmUp
                    if (!up) android.util.Log.i("Chitram", DirectRoute.logLine("direct-stalled", s, "reason=$why fallback=none vm=down"))
                    if (playing != null && DirectRoute.timerShouldFallBack(playing, s, framedThisPlay, vmUp = up)) directFallBack(playing, player.currentPosition.coerceAtLeast(0), why)
                    return@launch
                }
                if (framedThisPlay || at >= DirectRoute.FIRST_FRAME_MS) return@launch
                delay(minOf(500L, DirectRoute.FIRST_FRAME_MS - at).coerceAtLeast(1))
            }
        }
    }

    /**
     * A direct play failed before its first frame: the SAME row once more via
     * its proxied url, before any refresh, device twin or failover. The row
     * stays on the proxy for this session.
     */
    private fun directFallBack(cur: Source, pos: Long, why: String) {
        directJob?.cancel()
        directFailed += DirectRoute.key(cur)
        android.util.Log.i("Chitram", DirectRoute.logLine("direct-failed", cur, "reason=$why fallback=proxy"))
        play(DirectRoute.proxyOf(cur), pos, pairAudio = pairedAudio, fused = pairFused)
    }

    /**
     * Provider Referer/Origin on every request; vaplayer's token on every segment.
     * Caption files go out plain: the provider headers and vaplayer token are for the stream only.
     * A muxed CastleTV row (VM or device) gets the TS audio swap: the player keeps only the first AAC PID.
     */
    private fun sourceFor(s: Source, item: MediaItem): androidx.media3.exoplayer.source.MediaSource {
        val swap = if (TsAudioSwap.wanted(s)) TsAudioSwap(desiredAudio()) else null
        // A backend row playing direct (DirectRoute) carries the provider's headers.
        if (PlayPolicy.usesBaseClient(s, swap != null)) return DefaultMediaSourceFactory(OkHttpDataSource.Factory(playerHttp).setTransferListener(loadMarks.bytes)).createMediaSource(item)
        // A DASH row (MultiMovies sacdn MPD): its signature on every sacdn segment, its language in the MPD.
        val streamClient = StreamInterceptor.playerClient(g.api.client, s.headers, s.segmentToken, PlayPolicy.connectTimeoutMs(s),
            signedFrom = StreamInterceptor.signedFrom(s), audioLang = StreamInterceptor.audioLangOf(s))
            .let { c -> if (swap == null) c else c.newBuilder().addInterceptor(swap).build() }
            // Innermost: kept playlists from memory, a master's first playlists in parallel (PlaylistCache).
            .let { c -> com.chitram.app.resolve.PlaylistInterceptor.attach(c, g.playlists) { isoFor(desiredAudio()).toList() } }
        if (swap != null) android.util.Log.i("Chitram", "[tsaudio] ${s.provider}: swapping in ${g.prefs.preferredAudio()} from ${s.languages.joinToString("/")}")
        val http = OkHttpDataSource.Factory(okhttp3.Call.Factory { req ->
            if (subs.any { it.url == req.url.toString() }) g.api.client.newCall(req) else streamClient.newCall(req)
        }).setTransferListener(loadMarks.bytes)
        return DefaultMediaSourceFactory(http).createMediaSource(item)
    }

    /** H13: once both halves have tracks, pin the picture's video and the Telugu audio. */
    private fun applyPair(t: Tracks) {
        val a = pairedAudio ?: return
        if (pairApplied) return
        val (v, au) = when (val p = HybridPair.pick(t, isoFor(desiredAudio()).toList())) {
            HybridPair.Pick.Pending -> return
            is HybridPair.Pick.Pin -> p.video to p.audio
            HybridPair.Pick.NoMatch -> {
                // Task 6 ruling: no other-language track. A failed try: next donor or restore, never the donor alone.
                pairApplied = true
                val pos = player.currentPosition.coerceAtLeast(0)
                if (!pairFailed("no ${desiredAudio()} track in ${a.provider}", pos)) current?.let { play(it, pos) }
                return
            }
        }
        pairApplied = true
        audioPickedFor = current?.id
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
            .setOverrideForType(v).setOverrideForType(au).build()
        android.util.Log.i("Chitram", "[hybrid] picked video ${v.mediaTrackGroup.id} and audio ${au.mediaTrackGroup.id} from ${a.provider}")
    }

    /** A row failed in playback: its kept rows (StreamCache) are dropped so nothing reuses them. */
    private fun dropKept(row: Source?) {
        val r = request ?: return
        if (row != null) g.onDevice.dropKept(r.type, r.id, r.season, r.episode, row)
    }

    /** Fatal error policy (web/lib/player/fatalPolicy.js): stale link refreshes once, else next source. */
    private fun handleError(e: PlaybackException) {
        val http = generateSequence<Throwable>(e) { it.cause }.filterIsInstance<HttpDataSource.InvalidResponseCodeException>().firstOrNull()
        val pos = player.currentPosition.coerceAtLeast(0)
        val cur = current
        val serverReplied = http != null || e.errorCode == PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS
        val delivered = deliveredThisPlay || player.totalBufferedDuration > 0 || player.duration > 0
        val action = FailPolicy.onError(cur, http?.responseCode, refreshedOnce, cur?.onDevice in reresolved, offline = offline || isOffline(), twinTried = cur?.provider?.lowercase() in twinTried, languageSelection = languageTrial != null, serverReplied = serverReplied, rowDelivered = delivered)
        if (delivered && action == FailPolicy.Action.FAILOVER && FailPolicy.hasDeviceTwin(cur?.provider) && cur?.provider?.lowercase() !in twinTried) android.util.Log.i("Chitram", "[mm] ${cur?.provider}: VM row delivered bytes, no device re-resolve")
        if (serverReplied && (offline || isOffline())) android.util.Log.i("Chitram", "[offline] ${cur?.provider}: ${e.errorCodeName} http=${http?.responseCode} server replied, not offline -> $action")
        val why = LoadingModel.reasonFor(http?.responseCode, decoder = e.errorCode in 4000..4999)
        if (action == FailPolicy.Action.WAIT_ONLINE) {
            android.util.Log.i("Chitram", "[offline] ${cur?.provider}: ${e.errorCodeName} while offline, waiting")
            goOffline()
            return
        }
        // Client cache: rows that failed in playback are never reused; the re-resolve below (once) fetches fresh.
        dropKept(cur)
        // On-device merge: a donor request failed. The donor's fault, not the
        // picture's route: next donor first, the picture stays direct (m-B).
        if (!pairFused && DirectRoute.donorAtFault(http?.dataSpec?.uri?.toString(), cur, pairedAudio) && pairFailed("${e.errorCodeName}", pos)) return
        if (DirectRoute.shouldFallBack(cur, framed = framedThisPlay, vmUp = g.api.vmUp) && cur != null) {
            directFallBack(cur, pos, "${e.errorCodeName}${http?.responseCode?.let { "-$it" } ?: ""}")
            return
        }
        // A pair the device cannot play: the next donor, or back to what played before. Never the donor alone.
        if (pairFailed("${e.errorCodeName}", pos)) return
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

    // ---- Add <L> audio from another server (Step 2, server-fused) ----------------
    // A thin adapter: AddAudio.Journey decides, this runs its effects.

    private fun journeyScreen(pos: Long = player.currentPosition.coerceAtLeast(0)) = AddAudio.Screen(
        current = current, pairedAudio = pairedAudio, fused = pairFused, audioLanguage = selectedAudioLanguage,
        positionMs = pos, offline = offline || isOffline(),
        loaded = player.playbackState == Player.STATE_READY || player.duration > 0,
        ready = player.playbackState == Player.STATE_READY,
    )

    private fun runEffects(effects: List<AddAudio.Effect>) {
        for (e in effects) when (e) {
            // Held for the next READY only while not READY yet; READY shows it once and clears it.
            is AddAudio.Effect.Notice -> { notice = e.text; addedNotice = if (e.untilReady && player.playbackState != Player.STATE_READY) e.text else null }
            AddAudio.Effect.CancelCheck -> { addJob?.cancel(); addJob = null }
            is AddAudio.Effect.ClearHeld -> { addedNotice = null; if (e.stale != null && notice == e.stale) notice = "" }
            is AddAudio.Effect.Check -> checkDonors(e.run, e.gen)
            // Through the reused "pair" branch of choose(): a viewer-asked switch.
            is AddAudio.Effect.PlayPair -> { pairAtMs = e.positionMs; choose("pair:${e.hit.donor.id}:${e.run.language}") }
            is AddAudio.Effect.Restore -> {
                val fb = e.fallback
                android.util.Log.i("Chitram", "[addaudio] restoring ${fb.source.provider} at ${e.positionMs}ms")
                play(fb.source, e.positionMs, pairAudio = fb.pairedAudio, audioLanguage = fb.audioLanguage, fused = fb.fused)
            }
            is AddAudio.Effect.PictureOnly -> play(e.picture, e.positionMs)
        }
    }

    /** One background job per check; a newer check or a cancel replaces it. The journey judges the result. */
    private fun checkDonors(run: AddAudio.Run, gen: Int) {
        val r = request ?: return
        addJob?.cancel()
        addJob = viewModelScope.launch {
            val hit = AddAudio.run(run,
                tryOne = { d -> g.api.pair(run.picture, d, run.language, r.id, r.type).also { o -> android.util.Log.i("Chitram", "[addaudio] ${d.provider}: ${o.javaClass.simpleName}") } },
                onTry = { d, n, total -> runEffects(journey.checking(gen, run, LoadingModel.Copy.checkingAudio(run.language, label(d), n, total), journeyScreen())) },
                accept = { ok -> AddAudio.decodes(ok, g.codecs, audioDecoders).also { if (!it) android.util.Log.i("Chitram", "[addaudio] ${ok.codecs} not decodable here") } },
                device = { d -> deviceMergeOk(run.picture, d) })
            if (request != r) return@launch
            runEffects(journey.result(gen, run, hit, journeyScreen(), ::label))
        }
    }

    /**
     * Task 6 on-device merge try for one donor: both halves decodable here, and
     * their media playlists (read with each row's own headers) within
     * HybridPair.DURATION_TOLERANCE_S. The language gate runs at the tracks
     * (applyPair): a half with no track in L fails like a playback error.
     */
    private suspend fun deviceMergeOk(picture: Source, donor: Source): Boolean {
        if (g.codecs.supports(picture.videoCodec, picture.codecString) == false || !HybridPair.audioDecodes(donor.codecString, audioDecoders)) {
            android.util.Log.i("Chitram", "[addaudio] device merge ${picture.provider}+${donor.provider}: not decodable here")
            return false
        }
        val why = HybridPair.deviceGate(picture, donor) { s ->
            val c = StreamInterceptor.forRow(g.api.client, s)
            ({ url: String -> g.api.text(c, url) })
        }
        android.util.Log.i("Chitram", "[addaudio] device merge ${picture.provider}+${donor.provider}: ${why ?: "durations agree"}")
        return why == null
    }

    /**
     * The pair on screen failed on the device. True when the journey handled it:
     * the previous stream is back at once and the next donor is checked behind
     * it. Never plays the donor row alone in place of the picture.
     */
    private fun pairFailed(reason: String, pos: Long): Boolean {
        val a = pairedAudio ?: return false
        val effects = journey.deviceFailure(journeyScreen(pos))
        if (effects == null) {
            // A pair no journey run owns, or one that already reached READY (I2):
            // drop the donor, keep the picture's own failover.
            android.util.Log.w("Chitram", "[hybrid] pair failed ($reason), normal recovery, not playing ${a.provider} alone")
            pairedAudio = null; pairFused = false
            return false
        }
        if (effects.isEmpty()) { goOffline(); return true }
        android.util.Log.w("Chitram", "[addaudio] pair with ${a.provider} failed on the device: $reason")
        endAttempt(LoadingModel.RowState.FAILED, LoadingModel.Reason.STOPPED)
        runEffects(effects)
        return true
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
            val rows = g.onDevice.resolveAll(key, r.type, r.id, r.season, r.episode, g.codecs, desiredAudio(), fresh = true, title = r.title, originalLang = r.originalLang)
            val eligible = languageTrial?.let { AudioChoice.candidates(rows, it, tried) } ?: rows
            val fresh = eligible.find { it.id == s.id } ?: Ranking.rank(eligible, desiredAudio()).firstOrNull { it.id !in tried }
            if (request != r) return@launch
            if (fresh == null) {
                if (FailPolicy.onResolveMiss(isOffline()) == FailPolicy.ResolveMiss.GO_OFFLINE) { resolveMissOffline(s, pos); return@launch }
                failover("$reason, re-resolve failed", pos, why); return@launch
            }
            if (FailPolicy.unchangedProxiedRetry(s, fresh)) {
                android.util.Log.i("Chitram", "[mm] mapple: re-resolve gave the same proxied row; next server instead")
                failover("$reason, same proxied row", pos, why)
                return@launch
            }
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
        // Before endAttempt/play: play() appends the next row's attempt.
        val before = attempts
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
            notice = LoadingModel.failNotice(before, s.id, label(s), label(twin), skip = why == LoadingModel.Reason.UNSUPPORTED)
            return
        }
        val name = OnDeviceResolver.nameFor(s.provider) ?: return failover(reason, pos, why)
        android.util.Log.i("Chitram", "recover: $reason -> resolving ${s.provider} on device")
        notice = "Reconnecting to ${s.provider}…"
        player.stop()
        resolveJob?.cancel()
        resolveJob = viewModelScope.launch {
            val rows = g.onDevice.resolveAll(name, r.type, r.id, r.season, r.episode, g.codecs, desiredAudio(), fresh = true, title = r.title, originalLang = r.originalLang)
            val eligible = languageTrial?.let { AudioChoice.candidates(rows, it, tried) } ?: rows
            val fresh = Ranking.rank(eligible, desiredAudio()).firstOrNull { it.id !in tried }
            if (request != r) return@launch
            if (fresh == null && FailPolicy.onResolveMiss(isOffline()) == FailPolicy.ResolveMiss.GO_OFFLINE) { resolveMissOffline(s, pos); return@launch }
            if (fresh == null || fresh.id in tried) { failover("$reason, device resolve failed", pos, why); return@launch }
            endAttempt(LoadingModel.RowState.FAILED, why)
            tried += s.id
            report(s, ok = false, reason = reason)
            putSources(Ranking.merge(sources, rows, desiredAudio(), null))
            play(fresh, pos)
            notice = LoadingModel.failNotice(before, s.id, label(s), label(fresh), skip = why == LoadingModel.Reason.UNSUPPORTED)
        }
    }

    /**
     * The current row failed: mark it dead, report it, and advance to the next
     * alive row in the language (and near the height) that was playing (web
     * switchFlow.advanceTarget).
     */
    private fun failover(reason: String, pos: Long, why: String = LoadingModel.Reason.STOPPED, missingLang: String? = null) {
        // Stall, freeze, no picture or runtime on a pair: the run decides, not the server list.
        if (pairFailed(reason, pos)) return
        // Before endAttempt/play: play() appends the next row's attempt.
        val before = attempts
        endAttempt(LoadingModel.RowState.FAILED, why)
        val failed = current
        if (failed != null && failed.id == lastHitId) {
            lastHitId = null
            request?.let { r -> android.util.Log.i("Chitram", LastPlayed.line(r.type, r.id, failed.provider, "failed")) }
        }
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
            failedWhileOffline = isOffline()
            failedAtMs = pos
            // Offline, every row fails the same way: say offline, and retry when it returns.
            phase = Phase.Failed(if (failedWhileOffline) OFFLINE_TEXT else "Every source failed. Last: $reason")
            player.stop()
            if (failedWhileOffline) {
                android.util.Log.i("Chitram", "[offline] every source failed while offline, waiting to retry at ${pos}ms")
                goOffline()
            }
            return
        }
        android.util.Log.i("Chitram", "failover: $reason -> ${next.provider} (lang ${ctxLang ?: "preferred"}, ${ctxHeight ?: "-"}p)")
        play(next, pos)
        notice = LoadingModel.failNotice(before, failed?.id, failed?.let { label(it) }, label(next), skip = why == LoadingModel.Reason.UNSUPPORTED, missingLang = missingLang)
    }

    /**
     * Dead-source watchdog (web switchFlow, U6) for every row put on screen: no
     * sign of life in 8s, or no frame in 20s, is dead. On-device rows still get
     * their one re-resolve first (1.1.9).
     */
    private fun checkSwitch() {
        val s = current ?: return
        if (landed || judged || phase != Phase.Playing) return
        val now = System.currentTimeMillis()
        // Paused before the first frame, or offline: nothing to judge; restart the clock.
        if (offline || !player.playWhenReady) { playStartedAt = now; return }
        val alive = player.totalBufferedDuration > 0 || player.duration > 0 || player.playbackState == Player.STATE_READY
        if (alive) deliveredThisPlay = true
        when (PlayPolicy.switchVerdict(now - playStartedAt, alive, frames = player.isPlaying)) {
            PlayPolicy.Switch.LANDED -> onLanded(s, now)
            PlayPolicy.Switch.DEAD -> {
                val reason = if (alive) "switch: no frame in 20s" else "switch: no response in 8s"
                judgeDead(s, alive, reason, if (alive) LoadingModel.Reason.NO_PICTURE else LoadingModel.Reason.NO_ANSWER, if (alive) "no-frame-20s" else "no-response-8s")
            }
            PlayPolicy.Switch.WAIT -> {}
        }
    }

    /** The row on screen is dead before its first frame: direct fallback, pair, device, or the next server. */
    private fun judgeDead(s: Source, alive: Boolean, reason: String, why: String, directWhy: String) {
        judged = true // play() resets it; never `landed` (checkRuntime would report ok)
        android.util.Log.i("Chitram", "[switch] ${s.provider} dead: $reason")
        if (!isOffline() && DirectRoute.shouldFallBack(s, framed = framedThisPlay, vmUp = g.api.vmUp)) {
            directFallBack(s, player.currentPosition.coerceAtLeast(0), directWhy)
            return
        }
        if (!isOffline()) dropKept(s)
        if (!isOffline() && pairFailed(reason, player.currentPosition.coerceAtLeast(0))) return
        when (FailPolicy.onError(s, null, refreshedOnce, s.onDevice in reresolved, offline = isOffline(), twinTried = s.provider.lowercase() in twinTried, languageSelection = languageTrial != null, rowDelivered = alive || deliveredThisPlay)) {
            FailPolicy.Action.WAIT_ONLINE -> { judged = false; goOffline() }
            FailPolicy.Action.RERESOLVE -> reresolve(s, player.currentPosition.coerceAtLeast(0), "${s.provider}: $reason", why)
            FailPolicy.Action.DEVICE -> toDevice(s, player.currentPosition.coerceAtLeast(0), "${s.provider}: $reason", why)
            else -> failover("${s.provider}: $reason", player.currentPosition.coerceAtLeast(0), why)
        }
    }

    /**
     * A load of the row on screen failed (ExoPlayer may still retry it). A mapple
     * proxy host that refused the connection before any frame is dead now, not
     * after the 8 s watchdog (multimovies-slow-rca.md fix 3).
     */
    private fun onLoadFailed(uri: String, error: java.io.IOException) {
        val s = current ?: return
        if (landed || judged || offline || phase != Phase.Playing || isOffline()) return
        val replied = generateSequence<Throwable>(error) { it.cause }.any { it is HttpDataSource.InvalidResponseCodeException }
        if (!PlayPolicy.proxyHostDead(s, uri, httpReplied = replied, framed = framedThisPlay)) return
        android.util.Log.i("Chitram", "[mm] ${s.provider}: proxy host ${DirectRoute.host(uri)} failed (${error.javaClass.simpleName}) before a frame")
        judgeDead(s, alive = false, reason = "proxy host failed", why = LoadingModel.Reason.NO_ANSWER, directWhy = "proxy-host-failed")
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
        ctxLang = audio?.let { Ranking.trackLanguage(it.language, it.label) } ?: s.languages.firstOrNull() ?: ctxLang
        if (languageTrial != null && Ranking.sameLanguage(ctxLang, languageTrial)) { languageTrial = null; languageFallback = null }
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
        if (!landed || judged || runtimeDone || phase != Phase.Playing) return
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
            mediaUrl = DirectRoute.proxyOf(s).url, audioLang = ctxLang,
            device = if (Device.isTv(getApplication<Application>())) "tv" else "mobile",
        ))
    }

    // ---- Offline (U8, web Player.jsx offline banner) -------------------------

    private fun isOffline(): Boolean = NetState.offline(cm)

    private fun goOffline() {
        if (offline) return
        offline = true
        // No donor check offline: every try would fail and blame the servers.
        runEffects(journey.offline())
        resumeOnReturn = player.playWhenReady
        player.pause()
        if (!framed) switching = false
        notice = OFFLINE_TEXT
        android.util.Log.i("Chitram", "[offline] paused ${current?.provider ?: "resolve"}")
    }

    /** A device re-resolve found nothing because the device is offline: wait, do not fail over. */
    private fun resolveMissOffline(s: Source, pos: Long) {
        android.util.Log.i("Chitram", "[offline] ${s.provider}: re-resolve found nothing while offline, waiting")
        pendingResolveMs = pos
        goOffline()
    }

    private fun backOnline() {
        offline = false
        notice = ""
        android.util.Log.i("Chitram", "[offline] back online")
        pendingResolveMs?.let { ms -> pendingResolveMs = null; resolve(refresh = false, keepProvider = null, startMs = ms); return }
        val phaseName = when (phase) { Phase.Playing -> "playing"; is Phase.Failed -> "failed"; else -> "other" }
        if (!FailPolicy.backOnlineRetries(phaseName, failedWhileOffline)) return
        if (phase is Phase.Failed) {
            // Reached "Every source failed" offline: nothing was the servers' fault. Fresh start, same spot.
            failedWhileOffline = false
            android.util.Log.i("Chitram", "[offline] back online after offline failure, re-resolving at ${failedAtMs}ms")
            tried.clear()
            refreshedOnce = false
            resetStart()
            resolve(refresh = LoadingModel.retryPlan(failed = true).refresh, keepProvider = null, startMs = failedAtMs)
            return
        }
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
        val want = desiredAudio()
        fun matches(f: androidx.media3.common.Format): Boolean = Ranking.trackMatches(f.language, f.label, want)
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
        runEffects(journey.drop())
        resolveJob?.cancel()
        lateJobs.forEach { it.cancel() }
        deviceJobs.forEach { it.cancel() }
        deviceBg?.cancel()
        vmJob?.cancel()
        fullJob?.cancel()
        guardJob?.cancel()
        subsJob?.cancel()
        refreshJob?.cancel()
        refreshModel = RefreshModel()
        pendingResolveMs = null
        failedWhileOffline = false
        offline = false
        switching = false
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
        switching = false
        attempts = emptyList()
        checks = emptyList()
        listReady = false
        firstListSize = 0
        labels = emptyMap()
    }

    /** [Ranking.sharedTeluguMasters] lines already logged this screen. */
    private val sharedLogged = HashSet<String>()

    private fun putSources(list: List<Source>) {
        sources = list.map { source -> discoveredAudio[source.id]?.let { source.copy(languages = it, audioLanguages = it, selectableAudio = it.size > 1) } ?: source }
        // Gap 9.10: two providers calling one master "Telugu" is logged for review; no tag changes.
        Ranking.sharedTeluguMasters(sources).filter { sharedLogged.add(it) }.forEach { android.util.Log.i("Chitram", it) }
        labels = LoadingModel.labelRows(labels, sources)
    }

    private fun recordAudio(t: Tracks) {
        if (pairedAudio != null) return
        val source = current ?: return
        val known = t.groups.filter { it.type == C.TRACK_TYPE_AUDIO }.flatMap { group ->
            (0 until group.length).filter { group.isTrackSupported(it) }.mapNotNull { i ->
                val f = group.getTrackFormat(i)
                Ranking.trackLanguage(f.language, f.label)
            }
        }.filter(AudioChoice::knownLanguage).distinctBy { it.lowercase() }
        if (known.isEmpty()) return
        discoveredAudio[source.id] = known
        current = source.copy(languages = known, audioLanguages = known, selectableAudio = known.size > 1)
        putSources(sources)
        val wanted = languageTrial
        if (wanted != null && known.none { Ranking.sameLanguage(it, wanted) }) viewModelScope.launch {
            if (current?.id == source.id && languageTrial == wanted) failover("$wanted audio missing", player.currentPosition.coerceAtLeast(0), missingLang = wanted)
        }
    }

    private fun label(s: Source): String = labels[s.id] ?: s.provider

    /** Close the open attempt, if any. A frame or a failure ends a viewer-asked switch. */
    private fun endAttempt(state: LoadingModel.RowState, reason: String?) {
        if (state == LoadingModel.RowState.PLAYING || state == LoadingModel.RowState.FAILED) switching = false
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
        switching = switching,
    ))

    /** A viewer pick: the open row was left, not failed, and the switch is in flight. */
    private fun beginAskedSwitch() {
        endAttempt(LoadingModel.RowState.LEFT, null)
        switching = true
    }

    /** A Details row: play that source now (same path as the Server menu). */
    fun playSource(id: String) = choose("src:$id")

    /**
     * Cast to TV: pauses here and returns what to hand Web Video Caster, or null
     * when nothing is playing. WVC takes no start position, so the TV starts at 0.
     */
    suspend fun castSpec(): WvcCast.Spec? {
        // Never the donor alone: a fused pair casts its fused master (current); an
        // on-device merge (Task 6) casts the picture row, since the TV cannot merge.
        val s = current ?: return null
        val r = request ?: return null
        player.pause()
        saveProgress()
        // C5: an on-device row goes through the phone's LAN proxy (headers + token added here).
        // A DASH row is not proxied: LanProxy rewrites HLS playlists only (its MPD would lose the segment paths).
        val lan = if (s.onDevice == null || s.dash) null else withContext(Dispatchers.IO) {
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

    fun serverItems(provider: String? = null, now: Long = System.currentTimeMillis()): List<MenuItem> {
        // While refreshing, the old rows stay in place, dimmed, until the new list replaces them in one update.
        val dim = refreshModel.running
        if (provider == null) return listOf(refreshItem(now)) + sources.groupBy { it.provider.lowercase() }.map { (_, rows) ->
            val name = rows.first().provider
            val languages = rows.flatMap(AudioChoice::languages).distinct().take(3).joinToString(", ")
            MenuItem("group:$name", name, listOf(streamCount(rows.size), languages).filter { it.isNotEmpty() }.joinToString(" · "), rows.any { it.id == current?.id }, dim = dim)
        } + if (sources.none { it.provider.equals("netmirror", true) }) listOf(MenuItem("group:NetMirror", "NetMirror", "Check streams on demand")) else emptyList()
        val rows = Ranking.menuOrder(sources.filter { it.provider.equals(provider, true) })
        // Owner: nested rows of one provider are told apart by a short host tag (ServerTag).
        val tags = ServerTag.tags(rows)
        return rows.map { source ->
            val languages = AudioChoice.languages(source).joinToString(", ").ifEmpty { "Unknown audio" }
            val quality = Ranking.height(source).takeIf { it > 0 }?.let { "${it}p" } ?: source.quality
            val detail = listOfNotNull(source.netmirrorCatalog, quality, languages, tags[source.id],
                if (source.incomplete) "More streams pending" else null,
                if (source.unsupported) "Not supported here" else null).joinToString(" · ")
            MenuItem("src:${source.id}", label(source), detail, source.id == current?.id, source.unsupported || dim)
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

    // ---- Refresh sources (RefreshModel) -----------------------------------------

    /** The "Refresh sources" control: source list top row and the failure card. */
    var refreshModel by mutableStateOf(RefreshModel()); private set
    private var refreshJob: Job? = null

    /**
     * On demand: every kept row of this title is dropped, every provider and the
     * VM (refresh=1) asked anew, and the new rows replace the list in one update.
     * What plays keeps playing; only a source that already failed (failure card)
     * gives way to the best new row. One per title per 30 s.
     */
    fun refreshSources() {
        val r = request ?: return
        if (refreshModel.running) return
        val now = System.currentTimeMillis()
        val readyAt = g.refresh.readyAt(r.type, r.id, r.season, r.episode)
        if (readyAt > now) { refreshModel = refreshModel.blocked(now, readyAt); return }
        refreshModel = refreshModel.start(now, now + com.chitram.app.resolve.SourceRefresh.COOLDOWN_MS)
        val before = sources.map { it.url }.toSet()
        val preferred = g.prefs.preferredAudio()
        refreshJob = viewModelScope.launch {
            val res = try {
                g.refresh.run(r.type, r.id, r.season, r.episode, g.codecs, preferred, r.title, r.originalLang,
                    also = sources.mapNotNull { it.onDevice }, onProvider = { n, c -> if (request == r) refreshModel = refreshModel.answered(n, c) })
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                null
            }
            if (request != r) return@launch
            val t = System.currentTimeMillis()
            when (res) {
                is com.chitram.app.resolve.SourceRefresh.Throttled -> refreshModel = refreshModel.blocked(t, res.readyAt)
                null -> refreshModel = refreshModel.finish(t, RefreshModel.Copy.FAILED)
                is com.chitram.app.resolve.SourceRefresh.Done -> applyRefresh(r, res, before, preferred)
            }
        }
    }

    private fun applyRefresh(r: PlayRequest, res: com.chitram.app.resolve.SourceRefresh.Done, before: Set<String>, preferred: String) {
        val t = System.currentTimeMillis()
        val saved = g.lastProvider.get(r.type, r.id, r.season, r.episode)
        val pin = saved?.provider
        val manual = saved?.manual == true
        val vmRows = res.vm?.let { Ranking.fromResponse(it, preferred, g.codecs, pin, manual = manual) }.orEmpty()
        val (shown, twinMap) = StartRace.splitTwins(vmRows, res.device)
        val errored = phase is Phase.Failed
        // The playing row stays in the list (selected) even when the new answer lacks it; nothing switches.
        val plan = RefreshModel.apply(Ranking.merge(vmRows, shown, preferred, pin, manual), res.failed, current, errored) { l, cur -> Ranking.merge(l, listOf(cur), preferred, pin, manual) }
        val list = plan.list
        if (list == null) {
            // Nothing came back: the old list stays as it is.
            refreshModel = refreshModel.finish(t, RefreshModel.outcome(before, emptyList(), res.failed, preferred))
            return
        }
        // Rows still joining from the start would bring old urls back.
        lateJobs.forEach { it.cancel() }
        fullJob?.cancel()
        twins = twinMap
        putSources(list)
        listReady = true
        refreshModel = refreshModel.finish(t, RefreshModel.outcome(before, list, false, preferred))
        android.util.Log.i("Chitram", "[refresh] list replaced: ${list.size} row(s); playing ${if (errored) "none (failed)" else current?.provider ?: "none"}")
        plan.start?.let { first ->
            tried.clear()
            reresolved.clear()
            refreshedOnce = false
            attempts = emptyList()
            resetStart()
            notice = ""
            play(sources.firstOrNull { it.id == first.id } ?: first, g.progress.resumeMs(r.type, r.id, r.season, r.episode))
        }
    }

    /** The source list's first row: "Refresh sources", its state, and what it found. */
    fun refreshItem(now: Long): MenuItem {
        val m = refreshModel
        val detail = m.noteAt(now) ?: if (m.running) m.chips().ifEmpty { RefreshModel.Copy.PLAYBACK_CONTINUES } else RefreshModel.Copy.PLAYBACK_CONTINUES
        return MenuItem(REFRESH_KEY, m.label(now), detail)
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
            "add" -> runEffects(journey.tap(key.removePrefix("add:"), sources, journeyScreen()))
            "lang" -> {
                runEffects(journey.pick())
                val language = key.removePrefix("lang:")
                val all = AudioChoice.candidates(sources, language)
                if (all.isEmpty()) { notice = "No playable $language stream found yet."; return }
                if (AudioChoice.candidates(sources, language, tried).isEmpty()) all.forEach { tried.remove(it.id) }
                // A1: the playing source with no track in this language cannot
                // switch anything; go to another server or say there is none.
                val next = nextForLanguage(AudioChoice.candidates(sources, language, tried), all, current?.id, carries(groups(C.TRACK_TYPE_AUDIO), language))
                if (next == null) { notice = "No other $language stream found"; return }
                // Before the first frame there is nothing to restore: a failed pick moves on (web snapshot()).
                languageFallback = if (framed) current?.let { Triple(it, selectedAudioLanguage ?: ctxLang, player.currentPosition.coerceAtLeast(0)) } else null
                languageTrial = language
                selectedAudioLanguage = language
                audioPickedFor = null
                if (next.id == current?.id) {
                    player.trackSelectionParameters = player.trackSelectionParameters.buildUpon().clearOverridesOfType(C.TRACK_TYPE_AUDIO).setPreferredAudioLanguages(*isoFor(language)).build()
                    pickPreferredAudio(tracks)
                } else { beginAskedSwitch(); play(next, audioLanguage = language) }
                notice = "Trying $language on ${label(next)}…"
            }
            // src:<id> from the video sheet, or src:<id>:<lang> from the audio
            // sheet. Provider ids carry no colon (provider-N), so p[1] is the id.
            "src" -> AudioChoice.source(key, sources)?.let { (source, language) ->
                runEffects(journey.pick())
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
                    beginAskedSwitch()
                    play(source, audioLanguage = language ?: selectedAudioLanguage)
                    notice = "Switching to ${label(source)}…"
                }
            }
            // pair:<donorId>:<L>: the journey's accepted donor in L, as the server-fused master
            // or (Task 6) the picture row merged on the device with the donor's audio.
            "pair" -> journey.onScreen?.let { run ->
                val hit = run.hit?.takeIf { it.donor.id == p.getOrNull(1) } ?: return
                val language = p.getOrNull(2)?.takeIf { it.isNotBlank() } ?: run.language
                beginAskedSwitch()
                // The run's saved position, never a not-yet-loaded restored stream's 0.
                val at = pairAtMs ?: AddAudio.positionFor(journeyScreen(), run)
                pairAtMs = null
                play(AddAudio.pairSource(run.picture, hit, language), at, pairAudio = hit.donor, audioLanguage = language, fused = hit.ok != null)
            }
            "trk" -> {
                // An in-stream pick: stop a donor check, keep a pair already on screen.
                runEffects(journey.pick())
                languageTrial = null; languageFallback = null
                val gi = p[1].toInt(); val ti = p[2].toInt()
                val format = groups(C.TRACK_TYPE_AUDIO).getOrNull(gi)?.getTrackFormat(ti)
                selectedAudioLanguage = Ranking.trackLanguage(format?.language, format?.label) ?: format?.label ?: selectedAudioLanguage
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
        /** Fix D log lines. Greppable prefixes: `play: start`, `play: master`, `play: variant`, `play: seg0`, `play: first-frame total=`. */
        internal fun startLine(type: String, id: Long, season: Int, episode: Int, atMs: Long): String =
            "play: start $type/$id" + (if (type == "tv") " s${season}e$episode" else "") + " at=$atMs"
        internal fun loadLine(kind: String, loadMs: Long, sincePlayMs: Long, uri: String): String =
            "play: $kind ${loadMs}ms (+${sincePlayMs}ms since play) ${DirectRoute.host(uri)}${uri.substringAfter("://").substringAfter('/', "").substringBefore('?').let { if (it.isEmpty()) "" else "/" + it.takeLast(48) }}"
        internal fun firstFrameLine(totalMs: Long, provider: String?, sincePlayMs: Long): String =
            "play: first-frame total=${totalMs}ms provider=${provider ?: "?"} sincePlay=${sincePlayMs}ms"

        /** VM-down-only names ([down] minus [up]) not yet started ([running]), in [down] order. */
        internal fun vmDownExtras(down: List<String>, up: List<String>, running: List<String>): List<String> =
            down.filter { it !in up && it !in running }

        private val CHECK_LABELS = mapOf("mapple" to "Mapple", "vaplayer" to "VaPlayer", "castletv" to "CastleTV", "multimovies" to "MultiMovies", "netmirror" to "NetMirror", "showsst" to "showsst", "onetouchtv" to "OneTouchTV", "vidrift" to "Vidrift")
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

        /** True when the tracks are not known yet, or a supported track is in [language]. */
        internal fun carries(audio: List<Tracks.Group>, language: String): Boolean {
            if (audio.isEmpty()) return true
            return audio.any { gr -> (0 until gr.length).any { i -> gr.isTrackSupported(i) && gr.getTrackFormat(i).let { f -> Ranking.trackMatches(f.language, f.label, language) } } }
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
                    // Tag first, then a language in the label ('Telugu 5.1' -> Telugu), then the raw label.
                    val name = Ranking.trackLanguage(f.language, f.label) ?: f.label?.takeUnless { it.equals("audio", true) || it.isBlank() } ?: unnamed ?: "Default"
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
                // Already in this stream: the pick is the in-stream track above, never another server.
                if (lang.lowercase() in names || names.any { Ranking.sameLanguage(it, lang) }) continue
                val n = rows.count { !it.unsupported && (!known || it.id != current?.id) }
                if (n == 0) continue
                out += MenuItem("lang:$lang", lang, if (n == 1) "1 stream" else "$n streams", group = OTHER_SERVERS)
            }
            // Step 2: one "Add <L> audio from another server" row per language this
            // stream lacks and a pairable server carries (Telugu first). The sheet is
            // a scrolling Column of focusable rows (PlayerScreen MenuPanel), so a long list stays D-pad reachable on TV.
            for ((lang, _) in AddAudio.offers(sources, current, names, onDevicePath = true)) {
                out += MenuItem("add:$lang", LoadingModel.Copy.addAudio(lang), group = LoadingModel.Copy.ADD_AUDIO_GROUP)
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
        fun isoFor(label: String): Array<String> = (ISO[label.lowercase()] ?: Ranking.languageCode(label))?.let { arrayOf(it, label) } ?: arrayOf(label)
        fun langName(code: String?): String? = Ranking.languageLabel(code)
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

/**
 * Fix D: names the first loads of one play(). HLS: the first manifest is the
 * master, the second a variant (or audio) playlist; the first media or init
 * load is seg0. Each name is given once until [reset].
 */
internal class LoadMarks {
    private var manifests = 0
    private var seg0 = false
    /** A media or init segment finished loading since [reset] (DirectRoute.stallReason). */
    val segmentLoaded: Boolean get() = seg0
    /** When the last stream byte arrived (gap 6.3); 0 before any. */
    @Volatile var lastBytesAt = 0L
        private set
    /** Every stream data source reports its bytes here. */
    val bytes = object : androidx.media3.datasource.TransferListener {
        override fun onTransferInitializing(source: androidx.media3.datasource.DataSource, dataSpec: androidx.media3.datasource.DataSpec, isNetwork: Boolean) = Unit
        override fun onTransferStart(source: androidx.media3.datasource.DataSource, dataSpec: androidx.media3.datasource.DataSpec, isNetwork: Boolean) = Unit
        override fun onBytesTransferred(source: androidx.media3.datasource.DataSource, dataSpec: androidx.media3.datasource.DataSpec, isNetwork: Boolean, bytesTransferred: Int) {
            if (isNetwork && bytesTransferred > 0) lastBytesAt = System.currentTimeMillis()
        }
        override fun onTransferEnd(source: androidx.media3.datasource.DataSource, dataSpec: androidx.media3.datasource.DataSpec, isNetwork: Boolean) = Unit
    }
    fun reset() { manifests = 0; seg0 = false; lastBytesAt = 0L }
    fun mark(dataType: Int): String? = when (dataType) {
        androidx.media3.common.C.DATA_TYPE_MANIFEST -> when (++manifests) { 1 -> "master"; 2 -> "variant"; else -> null }
        androidx.media3.common.C.DATA_TYPE_MEDIA, androidx.media3.common.C.DATA_TYPE_MEDIA_INITIALIZATION ->
            if (seg0) null else { seg0 = true; "seg0" }
        else -> null
    }
}

/**
 * Before-first-frame trace (`play: trace +<ms> <event> <detail>`): every load
 * start, finish, cancel and error, the renderer formats and the state changes,
 * so a slow start shows which request or step the time went to.
 */
internal object LoadTrace {
    const val MAX = 60
    fun line(event: String, sincePlayMs: Long, detail: String): String = "play: trace +${sincePlayMs}ms $event $detail"
    fun load(dataType: Int, trackType: Int, lang: String?, loadMs: Long, bytes: Long, uri: String): String {
        val data = when (dataType) {
            androidx.media3.common.C.DATA_TYPE_MANIFEST -> "manifest"
            androidx.media3.common.C.DATA_TYPE_MEDIA -> "media"
            androidx.media3.common.C.DATA_TYPE_MEDIA_INITIALIZATION -> "init"
            else -> "data$dataType"
        }
        val track = when (trackType) {
            androidx.media3.common.C.TRACK_TYPE_VIDEO -> "video"
            androidx.media3.common.C.TRACK_TYPE_AUDIO -> "audio"
            androidx.media3.common.C.TRACK_TYPE_TEXT -> "text"
            androidx.media3.common.C.TRACK_TYPE_DEFAULT -> "muxed"
            else -> "t$trackType"
        }
        val tail = uri.substringAfter("://").substringAfter('/', "").substringBefore('?').takeLast(40)
        return "$data/$track" + (lang?.let { " lang=$it" } ?: "") +
            (if (loadMs >= 0) " ${loadMs}ms" else "") + (if (bytes >= 0) " ${bytes}B" else "") + " ${DirectRoute.host(uri)}/$tail"
    }
    fun error(e: Throwable): String {
        val code = generateSequence(e) { it.cause }.filterIsInstance<androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException>().firstOrNull()?.responseCode
        return (code?.let { "http=$it " } ?: "") + e.javaClass.simpleName
    }
    fun state(s: Int): String = when (s) {
        Player.STATE_IDLE -> "IDLE"; Player.STATE_BUFFERING -> "BUFFERING"; Player.STATE_READY -> "READY"; Player.STATE_ENDED -> "ENDED"; else -> "S$s"
    }
}
