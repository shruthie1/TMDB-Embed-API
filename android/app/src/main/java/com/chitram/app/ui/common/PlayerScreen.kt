package com.chitram.app.ui.common

import android.app.Activity
import android.content.pm.ActivityInfo
import android.view.SurfaceView
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.text.BasicText
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material.icons.filled.Forward10
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.HighQuality
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Replay10
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.Subtitles
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import com.chitram.app.player.MenuItem
import com.chitram.app.player.PlayRequest
import com.chitram.app.player.PlayerVm
import kotlinx.coroutines.delay

private enum class Menu(val title: String) { Server("Server"), Audio("Audio"), Quality("Quality"), Subtitles("Subtitles") }

/**
 * Player for both shells. D-pad: when the bar is hidden, Left/Right seek 10s
 * and Center toggles play. When shown, focus moves across the buttons.
 * Touch: tap toggles the controls, double-tap a side seeks 10s, the bar scrubs.
 */
@Composable
fun PlayerScreen(req: PlayRequest, isTv: Boolean, onBack: () -> Unit) {
    val vm: PlayerVm = viewModel()
    LaunchedEffect(req) { vm.start(req) }
    val view = LocalView.current
    val activity = LocalContext.current as? Activity

    DisposableEffect(Unit) {
        view.keepScreenOn = true
        val window = activity?.window
        val ctl = window?.let { WindowCompat.getInsetsController(it, view) }
        ctl?.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        ctl?.hide(WindowInsetsCompat.Type.systemBars())
        val oldOrientation = activity?.requestedOrientation
        if (!isTv) activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        onDispose {
            vm.leave()
            view.keepScreenOn = false
            ctl?.show(WindowInsetsCompat.Type.systemBars())
            if (!isTv && oldOrientation != null) activity.requestedOrientation = oldOrientation
        }
    }

    // What is on screen now: the request, or the episode the player rolled on to.
    val now = vm.request ?: req
    var controls by remember { mutableStateOf(true) }
    var menu by remember { mutableStateOf<Menu?>(null) }
    var lastInput by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var seekHint by remember { mutableIntStateOf(0) } // -1 back, 1 forward, for the double-tap badge
    val playFocus = remember { FocusRequester() }
    val rootFocus = remember { FocusRequester() }
    fun poke() { lastInput = System.currentTimeMillis() }

    // Auto-hide the controls after 4s of no input while playing.
    LaunchedEffect(controls, menu, vm.isPlaying, lastInput) {
        if (controls && menu == null && vm.isPlaying) {
            delay(4000)
            controls = false
        }
    }
    LaunchedEffect(controls, menu, vm.phase) {
        if (vm.phase !is PlayerVm.Phase.Playing) return@LaunchedEffect
        runCatching { if (controls && menu == null) playFocus.requestFocus() else if (!controls) rootFocus.requestFocus() }
    }
    LaunchedEffect(seekHint, lastInput) { if (seekHint != 0) { delay(600); seekHint = 0 } }

    val back = {
        when {
            menu != null -> menu = null
            vm.nextUp != null -> vm.dismissNext()
            controls && vm.isPlaying -> controls = false
            else -> onBack()
        }
    }
    // Touch and gesture back. The remote's Back key is handled in the preview
    // handler below: with a button focused, Compose otherwise spends Back on
    // moving focus out of the bar and the viewer has to press it again.
    BackHandler { back() }

    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black)
            .focusRequester(rootFocus)
            .onPreviewKeyEvent { e ->
                if (e.key == Key.Back) {
                    if (e.type == KeyEventType.KeyUp) { poke(); back() }
                    return@onPreviewKeyEvent true
                }
                if (e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                poke()
                if (menu != null || vm.nextUp != null) return@onPreviewKeyEvent false
                when (e.key) {
                    // Media keys go on to the system, which hands them to the
                    // MediaSession (PlayerVm). Here they only show the bar.
                    Key.MediaPlayPause, Key.MediaPlay, Key.MediaPause, Key.MediaFastForward, Key.MediaRewind -> { controls = true; false }
                    else -> if (!controls && vm.phase is PlayerVm.Phase.Playing) {
                        when (e.key) {
                            Key.DirectionLeft -> { vm.seekBy(-10_000); controls = true; true }
                            Key.DirectionRight -> { vm.seekBy(10_000); controls = true; true }
                            Key.DirectionCenter, Key.Enter -> { vm.togglePlay(); controls = true; true }
                            Key.DirectionUp, Key.DirectionDown, Key.Menu -> { controls = true; true }
                            else -> false
                        }
                    } else false
                }
            }
            .focusable()
            .then(
                if (isTv) Modifier.clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { poke(); controls = !controls }
                else Modifier.pointerInput(Unit) {
                    detectTapGestures(
                        onTap = { poke(); if (menu != null) menu = null else controls = !controls },
                        onDoubleTap = { o ->
                            poke()
                            val dir = if (o.x < size.width / 2f) -1 else 1
                            vm.seekBy(dir * 10_000L)
                            seekHint = dir
                        },
                    )
                },
            ),
    ) {
        // Video surface, letterboxed to the stream's aspect ratio.
        val vs = vm.videoSize
        val ratio = if (vs.width > 0 && vs.height > 0) vs.width * vs.pixelWidthHeightRatio / vs.height else 16f / 9f
        AndroidView(
            factory = { ctx -> SurfaceView(ctx).also { vm.player.setVideoSurfaceView(it) } },
            onRelease = { vm.player.clearVideoSurfaceView(it) },
            // Fit inside the screen both ways: a fixed width overflowed 16:9 video
            // on a 20:9 phone in landscape.
            modifier = Modifier.align(Alignment.Center).aspectRatio(ratio),
        )

        if (vm.cues.isNotEmpty()) {
            BasicText(
                vm.cues,
                style = TextStyle(color = Color.White, fontSize = if (isTv) 24.sp else 18.sp, textAlign = TextAlign.Center),
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = if (controls) 150.dp else 40.dp, start = 48.dp, end = 48.dp)
                    .background(Color.Black.copy(alpha = 0.55f), Tok.radiusMd).padding(horizontal = 12.dp, vertical = 4.dp),
            )
        }

        when (val ph = vm.phase) {
            is PlayerVm.Phase.Resolving -> LoadingScreen(now, vm.status.ifEmpty { "Getting your stream ready" }, isTv, onRetry = { vm.retry() }, onBack = onBack)
            is PlayerVm.Phase.Failed -> FailedPanel(now, ph.message, isTv, onRetry = { vm.retry() }, onBack = onBack)
            is PlayerVm.Phase.Playing -> {
                val note = vm.notice
                if (vm.buffering || note.isNotEmpty()) {
                    val count = vm.sources.size
                    CenterNote(note, sub = if (note.isNotEmpty() && count > 1) "Source ${(vm.sources.indexOf(vm.current) + 1).coerceIn(1, count)} of $count" else "")
                }
            }
        }

        if (seekHint != 0) {
            Box(Modifier.fillMaxSize(), contentAlignment = if (seekHint < 0) Alignment.CenterStart else Alignment.CenterEnd) {
                Box(Modifier.padding(horizontal = 72.dp).size(72.dp).background(Color.Black.copy(alpha = 0.45f), Tok.pill), contentAlignment = Alignment.Center) {
                    Icon(if (seekHint < 0) Icons.Filled.Replay10 else Icons.Filled.Forward10, contentDescription = null, tint = Color.White, modifier = Modifier.size(36.dp))
                }
            }
        }

        if (controls && vm.phase is PlayerVm.Phase.Playing && vm.nextUp == null) {
            Controls(vm, now, isTv, playFocus, onMenu = { menu = it; poke() }, onBack = onBack, poke = ::poke)
        }

        vm.nextUp?.let { next -> NextUpCard(next, isTv, onPlay = { vm.start(next) }, onDismiss = { vm.dismissNext(); controls = true }) }

        menu?.let { m ->
            val items = when (m) {
                Menu.Server -> vm.serverItems()
                Menu.Audio -> vm.audioItems()
                Menu.Quality -> vm.qualityItems()
                Menu.Subtitles -> vm.subtitleItems()
            }
            MenuPanel(m.title, items, isTv, onClose = { menu = null }, onPick = { vm.choose(it); menu = null; poke() })
        }
    }
}

private fun subtitleFor(r: PlayRequest): String? =
    if (r.type == "tv" && r.season > 0) "S${r.season} E${r.episode}" + (r.epTitle?.let { " · $it" } ?: "") else null

/** Backdrop, dimmed. No blur: the Fire TV stick pays for every blur pass. */
@Composable
private fun DimArt(r: PlayRequest) {
    if (r.backdrop == null) return
    Box(Modifier.fillMaxSize()) {
        Art(r.backdrop, "w780", Modifier.fillMaxSize().alpha(0.35f))
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.5f), Color.Black.copy(alpha = 0.85f)))))
    }
}

@Composable
private fun BackChip(isTv: Boolean, onBack: () -> Unit, modifier: Modifier = Modifier) {
    CtlButton(Icons.AutoMirrored.Filled.ArrowBack, "Back", showLabel = true, isTv = isTv, modifier = modifier, onClick = onBack)
}

/** Web overlays.jsx Resolving: art, one spinner, title, status, Back, and Try again after 8s. */
@Composable
private fun LoadingScreen(r: PlayRequest, status: String, isTv: Boolean, onRetry: () -> Unit, onBack: () -> Unit) {
    var secs by remember { mutableIntStateOf(0) }
    LaunchedEffect(r) { secs = 0; while (true) { delay(1000); secs++ } }
    Box(Modifier.fillMaxSize()) {
        DimArt(r)
        if (!isTv) BackChip(false, onBack, Modifier.windowInsetsPadding(WindowInsets.displayCutout).padding(16.dp))
        Column(Modifier.align(Alignment.Center).padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            CircularProgressIndicator(color = Tok.accent, trackColor = Tok.fill2, strokeWidth = 3.dp, modifier = Modifier.size(44.dp))
            BasicText(r.title, style = TextStyle(color = Tok.text, fontSize = if (isTv) 26.sp else 20.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center), modifier = Modifier.padding(top = 20.dp))
            subtitleFor(r)?.let { BasicText(it, style = TextStyle(color = Tok.textMuted, fontSize = 14.sp), modifier = Modifier.padding(top = 4.dp)) }
            BasicText(status, style = TextStyle(color = Tok.textSecondary, fontSize = 15.sp), modifier = Modifier.padding(top = 12.dp))
            if (secs >= 8) {
                val f = remember { FocusRequester() }
                LaunchedEffect(Unit) { if (isTv) runCatching { f.requestFocus() } }
                Row(Modifier.padding(top = 20.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    PillButton("Try again", icon = Icons.Filled.Refresh, modifier = Modifier.focusRequester(f), onClick = onRetry)
                    if (isTv) PillButton("Back", icon = Icons.AutoMirrored.Filled.ArrowBack, onClick = onBack)
                }
            }
        }
    }
}

@Composable
private fun CenterNote(text: String, sub: String) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.background(Color.Black.copy(alpha = if (text.isEmpty()) 0f else 0.5f), Tok.radiusLg).padding(20.dp)) {
            CircularProgressIndicator(color = Tok.accent, trackColor = Tok.fill2, strokeWidth = 3.dp, modifier = Modifier.size(40.dp))
            if (text.isNotEmpty()) BasicText(text, style = TextStyle(color = Tok.text, fontSize = 16.sp), modifier = Modifier.padding(top = 12.dp))
            if (sub.isNotEmpty()) BasicText(sub, style = TextStyle(color = Tok.textMuted, fontSize = 13.sp), modifier = Modifier.padding(top = 4.dp))
        }
    }
}

@Composable
private fun FailedPanel(r: PlayRequest, message: String, isTv: Boolean, onRetry: () -> Unit, onBack: () -> Unit) {
    val f = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { f.requestFocus() } }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        DimArt(r)
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(32.dp)) {
            BasicText("Can't play this right now", style = TextStyle(color = Tok.text, fontSize = 22.sp, fontWeight = FontWeight.SemiBold))
            BasicText(r.title + (subtitleFor(r)?.let { " · $it" } ?: ""), style = TextStyle(color = Tok.textSecondary, fontSize = 14.sp), modifier = Modifier.padding(top = 4.dp))
            BasicText(message, style = TextStyle(color = Tok.textMuted, fontSize = 14.sp, textAlign = TextAlign.Center), modifier = Modifier.padding(top = 8.dp, bottom = 20.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                PillButton("Try again", primary = true, icon = Icons.Filled.Refresh, modifier = Modifier.focusRequester(f), onClick = onRetry)
                PillButton("Back", icon = Icons.AutoMirrored.Filled.ArrowBack, onClick = onBack)
            }
        }
    }
}

@Composable
private fun Controls(
    vm: PlayerVm, r: PlayRequest, isTv: Boolean, playFocus: FocusRequester,
    onMenu: (Menu) -> Unit, onBack: () -> Unit, poke: () -> Unit,
) {
    val side = if (isTv) 48.dp else 20.dp
    val next = vm.nextEpisode
    Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.displayCutout)) {
        // Top: back, title, episode and source.
        Row(
            Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.75f), Color.Transparent)))
                .padding(start = if (isTv) side else 8.dp, end = side, top = if (isTv) 28.dp else 8.dp, bottom = 28.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (!isTv) CtlButton(Icons.AutoMirrored.Filled.ArrowBack, "Back", showLabel = false, isTv = false, onClick = onBack)
            Column(Modifier.weight(1f).padding(start = if (isTv) 0.dp else 4.dp)) {
                BasicText(r.title, style = TextStyle(color = Tok.text, fontSize = if (isTv) 24.sp else 18.sp, fontWeight = FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
                subtitleFor(r)?.let { BasicText(it, style = TextStyle(color = Tok.textSecondary, fontSize = 14.sp), maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
            vm.current?.let { s ->
                // The language actually playing, not the source's first listed one.
                val lang = vm.audioItems().firstOrNull { it.selected }?.label?.takeUnless { it == "Default" } ?: s.languages.firstOrNull()
                BasicText(listOfNotNull(s.provider, lang).joinToString(" · "), style = TextStyle(color = Tok.textSecondary, fontSize = 13.sp),
                    modifier = Modifier.background(Tok.fill2, Tok.pill).padding(horizontal = 12.dp, vertical = 5.dp))
            }
        }

        // Phone: large centre controls, as in most Android players.
        // Hidden while the centre status card shows, so the two never overlap.
        if (!isTv && !vm.buffering && vm.notice.isEmpty()) {
            Row(Modifier.align(Alignment.Center), horizontalArrangement = Arrangement.spacedBy(40.dp), verticalAlignment = Alignment.CenterVertically) {
                RoundIcon(Icons.Filled.Replay10, "Back 10 seconds", 56.dp) { vm.seekBy(-10_000); poke() }
                RoundIcon(if (vm.isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow, if (vm.isPlaying) "Pause" else "Play", 76.dp, filled = true) { vm.togglePlay(); poke() }
                RoundIcon(Icons.Filled.Forward10, "Forward 10 seconds", 56.dp) { vm.seekBy(10_000); poke() }
            }
        }

        // Bottom: seek bar, time, buttons.
        Column(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.85f))))
                .padding(start = side, end = side, top = 24.dp, bottom = if (isTv) 28.dp else 12.dp),
        ) {
            SeekBar(vm, isTv, poke)
            Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                BasicText(fmtTime(vm.positionMs) + "  /  " + (if (vm.durationMs > 0) fmtTime(vm.durationMs) else "--:--"),
                    style = TextStyle(color = Tok.textSecondary, fontSize = 13.sp))
                Spacer(Modifier.weight(1f))
                if (vm.durationMs > 0) BasicText("-" + fmtTime(vm.durationMs - vm.positionMs), style = TextStyle(color = Tok.textMuted, fontSize = 13.sp))
            }
            Spacer(Modifier.height(if (isTv) 14.dp else 6.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(if (isTv) 10.dp else 4.dp)) {
                if (isTv) {
                    CtlButton(Icons.Filled.Replay10, "-10s", showLabel = false, isTv = true) { vm.seekBy(-10_000); poke() }
                    CtlButton(if (vm.isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow, if (vm.isPlaying) "Pause" else "Play", showLabel = false, isTv = true, primary = true, modifier = Modifier.focusRequester(playFocus)) { vm.togglePlay(); poke() }
                    CtlButton(Icons.Filled.Forward10, "+10s", showLabel = false, isTv = true) { vm.seekBy(10_000); poke() }
                }
                if (next != null) CtlButton(Icons.Filled.SkipNext, "Next episode", showLabel = true, isTv = isTv,
                    modifier = if (!isTv) Modifier.focusRequester(playFocus) else Modifier) { vm.start(next) }
                Spacer(Modifier.weight(1f))
                CtlButton(Icons.Filled.Dns, "Server", showLabel = true, isTv = isTv, modifier = if (!isTv && next == null) Modifier.focusRequester(playFocus) else Modifier) { onMenu(Menu.Server) }
                CtlButton(Icons.Filled.GraphicEq, "Audio", showLabel = true, isTv = isTv) { onMenu(Menu.Audio) }
                CtlButton(Icons.Filled.HighQuality, "Quality", showLabel = true, isTv = isTv) { onMenu(Menu.Quality) }
                CtlButton(Icons.Filled.Subtitles, "Subtitles", showLabel = true, isTv = isTv) { onMenu(Menu.Subtitles) }
            }
        }
    }
}

/** Progress with buffered range and a knob. Touch: tap or drag to seek; the seek happens on release. */
@Composable
private fun SeekBar(vm: PlayerVm, isTv: Boolean, poke: () -> Unit) {
    val dur = vm.durationMs
    var drag by remember { mutableStateOf<Float?>(null) }
    val frac = drag ?: if (dur > 0) (vm.positionMs.toFloat() / dur).coerceIn(0f, 1f) else 0f
    val buf = if (dur > 0) (vm.bufferedMs.toFloat() / dur).coerceIn(0f, 1f) else 0f
    BoxWithConstraints(
        Modifier.fillMaxWidth().height(if (isTv) 20.dp else 28.dp)
            .then(
                if (isTv || dur <= 0) Modifier else Modifier
                    .pointerInput(dur) {
                        detectTapGestures { o -> poke(); vm.seekTo((o.x / size.width * dur).toLong()) }
                    }
                    .pointerInput(dur) {
                        detectHorizontalDragGestures(
                            onDragStart = { o -> drag = (o.x / size.width).coerceIn(0f, 1f); poke() },
                            onHorizontalDrag = { ch, _ -> drag = (ch.position.x / size.width).coerceIn(0f, 1f); poke() },
                            onDragEnd = { drag?.let { vm.seekTo((it * dur).toLong()) }; drag = null },
                            onDragCancel = { drag = null },
                        )
                    },
            ),
        contentAlignment = Alignment.CenterStart,
    ) {
        val w = maxWidth
        Box(Modifier.fillMaxWidth().height(4.dp).clip(Tok.pill).background(Tok.fill2)) {
            Box(Modifier.fillMaxHeight().fillMaxWidth(buf).background(Tok.fill3))
            Box(Modifier.fillMaxHeight().fillMaxWidth(frac).background(Tok.accent))
        }
        val knob = if (drag != null) 18.dp else 12.dp
        Box(Modifier.offset(x = (w - knob) * frac).size(knob).background(Tok.accent, Tok.pill))
    }
}

@Composable
private fun RoundIcon(icon: ImageVector, label: String, size: Dp, filled: Boolean = false, onClick: () -> Unit) {
    Box(
        Modifier.size(size).clip(Tok.pill).background(if (filled) Color.White.copy(alpha = 0.92f) else Color.Black.copy(alpha = 0.35f))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = label, tint = if (filled) Tok.bg else Color.White, modifier = Modifier.size(size * 0.55f))
    }
}

/**
 * Icon control. On TV it always reads as a button with a focus ring; with
 * `showLabel` it carries a text label too.
 */
@Composable
private fun CtlButton(
    icon: ImageVector, label: String, showLabel: Boolean, isTv: Boolean,
    modifier: Modifier = Modifier, primary: Boolean = false, onClick: () -> Unit,
) {
    val src = remember { MutableInteractionSource() }
    val focused by src.collectIsFocusedAsState()
    val bg = when {
        primary -> Color.White
        focused -> Tok.fill3
        isTv -> Tok.fill2
        else -> Color.Transparent
    }
    val fg = if (primary) Tok.bg else Tok.text
    Row(
        modifier
            .clip(Tok.pill)
            .background(bg)
            .border(2.dp, if (focused) Tok.accent else Color.Transparent, Tok.pill)
            .clickable(interactionSource = src, indication = null, onClick = onClick)
            .padding(horizontal = if (showLabel) 12.dp else 10.dp, vertical = if (isTv) 9.dp else 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = label, tint = fg, modifier = Modifier.size(if (isTv) 24.dp else 22.dp))
        if (showLabel) BasicText(label, style = TextStyle(color = fg, fontSize = if (isTv) 15.sp else 13.sp, fontWeight = FontWeight.Medium), modifier = Modifier.padding(start = 6.dp))
    }
}

/** End-of-episode card with a 10 s autoplay countdown (web overlays.jsx NextUp). */
@Composable
private fun NextUpCard(next: PlayRequest, isTv: Boolean, onPlay: () -> Unit, onDismiss: () -> Unit) {
    var left by remember(next) { mutableIntStateOf(10) }
    val f = remember { FocusRequester() }
    LaunchedEffect(next) { runCatching { f.requestFocus() } }
    LaunchedEffect(next, left) {
        if (left <= 0) { onPlay(); return@LaunchedEffect }
        delay(1000); left--
    }
    Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.displayCutout).padding(if (isTv) 48.dp else 24.dp), contentAlignment = Alignment.BottomEnd) {
        Column(Modifier.background(Tok.surface, Tok.radiusLg).padding(20.dp)) {
            BasicText("Next episode", style = TextStyle(color = Tok.textMuted, fontSize = 13.sp))
            BasicText(subtitleFor(next) ?: next.title, style = TextStyle(color = Tok.text, fontSize = 17.sp, fontWeight = FontWeight.SemiBold), modifier = Modifier.padding(top = 4.dp, bottom = 14.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PillButton("Play next · ${left}s", primary = true, icon = Icons.Filled.PlayArrow, modifier = Modifier.focusRequester(f), onClick = onPlay)
                PillButton("Not now", onClick = onDismiss)
            }
        }
    }
}

/** Focus-aware pill. Focus = accent ring; no scale animation in the player. */
@Composable
fun PillButton(text: String, modifier: Modifier = Modifier, primary: Boolean = false, icon: ImageVector? = null, onClick: () -> Unit) {
    val src = remember { MutableInteractionSource() }
    val focused by src.collectIsFocusedAsState()
    val bg = when {
        primary -> Color.White
        focused -> Tok.fill3
        else -> Tok.fill2
    }
    val fg = if (primary) Tok.bg else Tok.text
    Row(
        modifier
            .clip(Tok.pill)
            .background(bg)
            .border(2.dp, if (focused) Tok.accent else Color.Transparent, Tok.pill)
            .clickable(interactionSource = src, indication = null, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) Icon(icon, contentDescription = null, tint = fg, modifier = Modifier.size(18.dp).padding(end = 2.dp))
        BasicText(text, style = TextStyle(color = fg, fontSize = 15.sp, fontWeight = FontWeight.Medium), modifier = Modifier.padding(start = if (icon != null) 4.dp else 0.dp))
    }
}

@Composable
private fun MenuPanel(title: String, items: List<MenuItem>, isTv: Boolean, onClose: () -> Unit, onPick: (String) -> Unit) {
    val first = remember { FocusRequester() }
    LaunchedEffect(title) { runCatching { first.requestFocus() } }
    Box(
        Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.4f))
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onClose),
        contentAlignment = Alignment.CenterEnd,
    ) {
        Column(
            Modifier.fillMaxHeight().width(360.dp).background(Tok.surface)
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { }
                .windowInsetsPadding(WindowInsets.displayCutout)
                .padding(vertical = if (isTv) 24.dp else 12.dp),
        ) {
            BasicText(title, style = TextStyle(color = Tok.text, fontSize = 20.sp, fontWeight = FontWeight.SemiBold), modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
            if (items.isEmpty()) BasicText("Nothing to choose here.", style = TextStyle(color = Tok.textMuted, fontSize = 14.sp), modifier = Modifier.padding(24.dp))
            val start = items.indexOfFirst { it.selected }.coerceAtLeast(0)
            LazyColumn(Modifier.fillMaxWidth()) {
                itemsIndexed(items, key = { _, it -> it.key }) { i, item ->
                    val src = remember { MutableInteractionSource() }
                    val focused by src.collectIsFocusedAsState()
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 2.dp)
                            .then(if (i == start) Modifier.focusRequester(first) else Modifier)
                            .clip(Tok.radiusMd)
                            .background(if (focused) Tok.fill2 else Color.Transparent)
                            .border(2.dp, if (focused) Tok.accent else Color.Transparent, Tok.radiusMd)
                            .clickable(interactionSource = src, indication = null) { onPick(item.key) }
                            .padding(horizontal = 12.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            BasicText(item.label, style = TextStyle(color = if (item.dim) Tok.textDim else Tok.text, fontSize = 16.sp))
                            if (item.detail.isNotEmpty()) BasicText(item.detail, style = TextStyle(color = Tok.textMuted, fontSize = 12.sp), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        if (item.selected) Icon(Icons.Filled.Check, contentDescription = "Selected", tint = Tok.accent, modifier = Modifier.size(20.dp))
                    }
                }
            }
        }
    }
}
