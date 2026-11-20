@file:OptIn(UnstableApi::class)

package com.chitram.app.player

import android.app.Application
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import androidx.compose.runtime.getValue
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
import com.chitram.app.resolve.StreamInterceptor
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
    private var deviceJobs: List<Deferred<Source?>> = emptyList()
    /** On-device providers already re-resolved once for this title. */
    private val reresolved = HashSet<String>()
    /** The preferred-language audio pick is done once per on-device source. */
    private var audioPickedFor: String? = null

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
                    current?.let { request?.let { r -> g.lastProvider.put(r.type, r.id, it.provider) } }
                }
                if (state == Player.STATE_ENDED) onEnded()
            }
            override fun onVideoSizeChanged(size: VideoSize) { videoSize = size }
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
            failover("${current?.provider ?: "Source"}: stalled", player.currentPosition.coerceAtLeast(0))
        }
    }

    fun start(r: PlayRequest) {
        if (request == r) return
        saveProgress()
        request = r
        tried.clear()
        reresolved.clear()
        refreshedOnce = false
        nextUp = null
        notice = ""
        ctxLang = null
        ctxHeight = null
        requestedAt = System.currentTimeMillis()
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
    private fun resolve(refresh: Boolean, keepProvider: String?, startMs: Long) {
        val r = request ?: return
        resolveJob?.cancel()
        lateJobs.forEach { it.cancel() }
        deviceJobs.forEach { it.cancel() }
        player.stop()
        phase = Phase.Resolving
        status = if (refresh) "Refreshing links…" else "Getting your stream ready"
        resolveJob = viewModelScope.launch {
            val pin = keepProvider ?: g.lastProvider.get(r.type, r.id)
            val preferred = g.prefs.preferredAudio()
            val device = g.onDevice.launch(viewModelScope, r.type, r.id, r.season, r.episode, g.codecs, preferred)
            deviceJobs = device
            var backendError: Exception? = null
            val backend = try {
                Ranking.fromResponse(g.api.streams(r.type, r.id, r.season, r.episode, refresh), preferred, g.codecs, pin)
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) { device.forEach { it.cancel() }; throw e }
                backendError = e
                emptyList()
            }
            // A playable backend row in the viewer's language starts now; on-device rows join late.
            val haveGood = backend.any { !it.unsupported && Ranking.tier(it, preferred) <= 2 }
            val graceEnd = System.currentTimeMillis() + when {
                backend.isEmpty() -> DEVICE_WAIT_MS
                haveGood -> 0L
                else -> DEVICE_GRACE_MS
            }
            val early = device.mapNotNull { d ->
                kotlinx.coroutines.withTimeoutOrNull((graceEnd - System.currentTimeMillis()).coerceAtLeast(1)) { d.await() }
            }
            val list = Ranking.merge(backend, early, preferred, pin)
            sources = list
            lateJobs = device.filter { !it.isCompleted }.map { d -> viewModelScope.launch { joinLate(r, d, preferred, pin) } }
            if (list.isEmpty() && isOffline()) {
                pendingResolveMs = startMs
                goOffline()
                status = OFFLINE_TEXT
                return@launch
            }
            // Captions ride on the media item, so give the subtitle fetch a moment
            // to land; it runs alongside the streams call and is usually done.
            subsJob?.let { j -> withTimeoutOrNull(SUBS_WAIT_MS) { j.await() }?.let { subs = it } }
            if (list.isEmpty()) {
                phase = Phase.Failed(backendError?.let { "Could not reach the server (${it.message ?: it.javaClass.simpleName})." } ?: "No playable source found.")
                return@launch
            }
            play(list.first(), startMs)
        }
    }

    private suspend fun joinLate(r: PlayRequest, d: Deferred<Source?>, preferred: String, pin: String?) {
        val s = d.await() ?: return
        if (request != r) return
        sources = Ranking.merge(sources, listOf(s), preferred, pin)
        android.util.Log.i("Chitram", "on-device ${s.provider} joined late")
        if (phase is Phase.Failed) { play(s, g.progress.resumeMs(r.type, r.id, r.season, r.episode)); notice = "" }
    }

    fun play(s: Source, startMs: Long = player.currentPosition.coerceAtLeast(0)) {
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
        if (s.onDevice != null) {
            // Provider Referer/Origin on every request; vaplayer's token on every segment.
            // Caption files go out plain: the provider headers and vaplayer token are for the stream only.
            val streamClient = StreamInterceptor.client(g.api.client, s.headers, s.segmentToken)
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
        val action = FailPolicy.onError(cur, http?.responseCode, refreshedOnce, cur?.onDevice in reresolved, offline = offline || isOffline())
        if (action == FailPolicy.Action.WAIT_ONLINE) {
            android.util.Log.i("Chitram", "[offline] ${cur?.provider}: ${e.errorCodeName} while offline, waiting")
            goOffline()
            return
        }
        if (action == FailPolicy.Action.RERESOLVE && cur?.onDevice != null) {
            reresolve(cur, pos, "${cur.provider}: ${e.errorCodeName}")
            return
        }
        if (action == FailPolicy.Action.REFRESH) {
            refreshedOnce = true
            tried.clear()
            resolve(refresh = true, keepProvider = current?.provider, startMs = pos)
            return
        }
        failover("${current?.provider ?: "Source"}: ${e.errorCodeName}", pos)
    }

    /** Recover an on-device row once: resolve it again on the device and resume at `pos`. */
    private fun reresolve(s: Source, pos: Long, reason: String) {
        val r = request ?: return
        val name = s.onDevice ?: return
        reresolved += name
        android.util.Log.i("Chitram", "recover: $reason -> re-resolving ${s.provider} on device")
        notice = "Reconnecting to ${s.provider}…"
        player.stop()
        resolveJob?.cancel()
        resolveJob = viewModelScope.launch {
            val key = if (name.equals("mapple", true)) com.chitram.app.resolve.OnDeviceResolver.MAPPLE else com.chitram.app.resolve.OnDeviceResolver.VAPLAYER
            val fresh = g.onDevice.resolveOne(key, r.type, r.id, r.season, r.episode, g.codecs, g.prefs.preferredAudio(), fresh = true)
            if (request != r) return@launch
            if (fresh == null) { failover("$reason, re-resolve failed", pos); return@launch }
            sources = Ranking.merge(sources, listOf(fresh), g.prefs.preferredAudio(), null)
            play(fresh, pos)
            notice = ""
        }
    }

    /**
     * The current row failed: mark it dead, report it, and advance to the next
     * alive row in the language (and near the height) that was playing (web
     * switchFlow.advanceTarget).
     */
    private fun failover(reason: String, pos: Long) {
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
        notice = "${failed?.provider ?: "That server"} didn't respond, playing ${next.provider}."
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
                android.util.Log.i("Chitram", "[switch] ${s.provider} dead: $reason")
                when (FailPolicy.onError(s, null, refreshedOnce, s.onDevice in reresolved, offline = isOffline())) {
                    FailPolicy.Action.WAIT_ONLINE -> { landed = false; goOffline() }
                    FailPolicy.Action.RERESOLVE -> reresolve(s, player.currentPosition.coerceAtLeast(0), "${s.provider}: $reason")
                    else -> failover("${s.provider}: $reason", player.currentPosition.coerceAtLeast(0))
                }
            }
            PlayPolicy.Switch.WAIT -> {}
        }
    }

    private fun onLanded(s: Source, now: Long) {
        landed = true
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
                if (PlayPolicy.nextAlive(sources, tried + s.id, ctxLang, ctxHeight) != null) failover(reason, player.currentPosition.coerceAtLeast(0))
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
     * Telugu first: an on-device master lists many audio renditions (mapple: 14).
     * If the player did not land on the preferred language, select it once.
     */
    private fun pickPreferredAudio(t: Tracks) {
        val s = current ?: return
        if (s.onDevice == null || audioPickedFor == s.id) return
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
                    failover("no picture", p)
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

    fun retry() {
        val r = request ?: return
        tried.clear()
        refreshedOnce = false
        resolve(refresh = true, keepProvider = null, startMs = g.progress.resumeMs(r.type, r.id, r.season, r.episode))
    }

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
        val labels = Ranking.labels(menu)
        return menu.mapIndexed { i, s ->
            val lang = s.languages.joinToString(", ").ifEmpty { "Unknown language" }
            val q = Ranking.height(s).takeIf { it > 0 }?.let { "${it}p" } ?: s.quality
            MenuItem("src:${s.id}", labels[i], "$q · $lang" + if (s.unsupported) " · not supported here" else "", s.id == current?.id, s.unsupported)
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
                    ?: langName(f.language) ?: current?.languages?.firstOrNull() ?: "Default"
                if (!names.add(name.lowercase())) continue
                out += MenuItem("trk:$gi:$i", name, "in this stream", gr.isTrackSelected(i))
            }
        }
        if (out.isEmpty()) current?.languages?.firstOrNull()?.let { names += it.lowercase(); out += MenuItem("cur", it, "this server", true) }
        for ((lang, s) in Ranking.otherSourceLanguages(sources, current?.id, names)) {
            out += MenuItem("src:${s.id}", lang, "switches to ${s.provider} ${s.quality}")
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
            "src" -> sources.firstOrNull { it.id == key.removePrefix("src:") }?.let {
                if (it.id == current?.id) return
                // Keep `tried`: auto-advance after a failed pick must not return to a dead row (U7).
                play(it); notice = "Switching to ${it.provider}…"
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
