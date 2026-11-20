@file:OptIn(UnstableApi::class)

package com.chitram.app.player

import android.app.Application
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
import com.chitram.app.App
import com.chitram.app.data.Progress
import com.chitram.app.data.Ranking
import com.chitram.app.data.SeasonInfo
import com.chitram.app.data.Source
import kotlinx.coroutines.Job
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

    private val tried = HashSet<String>()
    private var refreshedOnce = false
    private var resolveJob: Job? = null
    private var guardJob: Job? = null

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
                    current?.let { request?.let { r -> g.lastProvider.put(r.type, r.id, it.provider) } }
                }
                if (state == Player.STATE_ENDED) onEnded()
            }
            override fun onVideoSizeChanged(size: VideoSize) { videoSize = size }
            override fun onCues(cueGroup: CueGroup) { cues = cueGroup.cues.joinToString("\n") { it.text ?: "" }.trim() }
            override fun onTracksChanged(t: Tracks) { tracks = t }
            override fun onPlayerError(error: PlaybackException) { handleError(error) }
        })
        viewModelScope.launch {
            var n = 0
            while (isActive) {
                delay(500)
                positionMs = player.currentPosition
                if (player.duration > 0) durationMs = player.duration
                if (++n % 20 == 0 && player.isPlaying) saveProgress()
            }
        }
    }

    fun start(r: PlayRequest) {
        if (request == r) return
        saveProgress()
        request = r
        tried.clear()
        refreshedOnce = false
        resolve(refresh = false, keepProvider = null, startMs = g.progress.resumeMs(r.type, r.id, r.season, r.episode))
    }

    private fun resolve(refresh: Boolean, keepProvider: String?, startMs: Long) {
        val r = request ?: return
        resolveJob?.cancel()
        player.stop()
        phase = Phase.Resolving
        status = if (refresh) "Refreshing links" else "Finding the best source"
        resolveJob = viewModelScope.launch {
            val list = try {
                val resp = g.api.streams(r.type, r.id, r.season, r.episode, refresh)
                Ranking.fromResponse(resp, g.prefs.preferredAudio(), g.codecs, keepProvider ?: g.lastProvider.get(r.type, r.id))
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                phase = Phase.Failed("Could not reach the server (${e.message ?: e.javaClass.simpleName}).")
                return@launch
            }
            sources = list
            if (list.isEmpty()) { phase = Phase.Failed("No playable source found."); return@launch }
            play(list.first(), startMs)
        }
    }

    fun play(s: Source, startMs: Long = player.currentPosition.coerceAtLeast(0)) {
        tried += s.id
        current = s
        cues = ""
        videoSize = VideoSize.UNKNOWN
        val subs = s.subtitles.take(12).map { sub ->
            val mime = if (sub.url.contains(".srt", ignoreCase = true)) MimeTypes.APPLICATION_SUBRIP else MimeTypes.TEXT_VTT
            MediaItem.SubtitleConfiguration.Builder(Uri.parse(sub.url))
                .setMimeType(mime).setLabel(sub.lang ?: "Subtitles").setLanguage(sub.lang?.lowercase()).build()
        }
        val item = MediaItem.Builder()
            .setUri(s.url)
            .apply { if (!s.progressive) setMimeType(MimeTypes.APPLICATION_M3U8) }
            .setSubtitleConfigurations(subs)
            .setMediaMetadata(metadata(request))
            .build()
        // Prefer the viewer's language inside multi-audio masters; subtitles off by default.
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
            .clearOverrides()
            .setPreferredAudioLanguages(*isoFor(g.prefs.preferredAudio()))
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
            .build()
        player.setMediaItem(item, startMs)
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
        if (http != null && (http.responseCode == 403 || http.responseCode == 410) && !refreshedOnce) {
            refreshedOnce = true
            tried.clear()
            resolve(refresh = true, keepProvider = current?.provider, startMs = pos)
            return
        }
        failover("${current?.provider ?: "Source"}: ${e.errorCodeName}", pos)
    }

    private fun failover(reason: String, pos: Long) {
        val next = sources.firstOrNull { it.id !in tried && !it.unsupported } ?: sources.firstOrNull { it.id !in tried }
        if (next == null) {
            phase = Phase.Failed("Every source failed. Last: $reason")
            player.stop()
            return
        }
        status = "Switching server ($reason)"
        play(next, pos)
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

    private fun onEnded() {
        saveProgress()
        val r = request ?: return
        if (r.type != "tv" || r.season == 0) return
        val count = r.seasons.firstOrNull { it.number == r.season }?.episodes ?: 0
        val next = when {
            count == 0 || r.episode < count -> r.copy(episode = r.episode + 1, epTitle = null)
            r.seasons.any { it.number == r.season + 1 } -> r.copy(season = r.season + 1, episode = 1, epTitle = null)
            else -> return
        }
        start(next)
    }

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
        guardJob?.cancel()
        player.stop()
        player.clearMediaItems()
        request = null
        current = null
        sources = emptyList()
        phase = Phase.Resolving
    }

    fun retry() {
        val r = request ?: return
        tried.clear()
        refreshedOnce = false
        resolve(refresh = true, keepProvider = null, startMs = g.progress.resumeMs(r.type, r.id, r.season, r.episode))
    }

    fun togglePlay() { if (player.isPlaying) player.pause() else { if (player.playbackState == Player.STATE_ENDED) player.seekTo(0); player.play() } }
    fun seekBy(ms: Long) { player.seekTo((player.currentPosition + ms).coerceIn(0, if (player.duration > 0) player.duration else Long.MAX_VALUE)); positionMs = player.currentPosition }

    // ---- Menus ---------------------------------------------------------------

    fun serverItems(): List<MenuItem> {
        val labels = Ranking.labels(sources)
        return sources.mapIndexed { i, s ->
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
            "src" -> sources.firstOrNull { it.id == key.removePrefix("src:") }?.let { tried.clear(); play(it) }
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
        session.release()
        player.release()
    }

    companion object {
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
