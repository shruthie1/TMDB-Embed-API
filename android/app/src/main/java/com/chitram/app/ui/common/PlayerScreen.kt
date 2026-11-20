package com.chitram.app.ui.common

import android.app.Activity
import android.os.Build
import android.view.WindowManager
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Shape
import com.chitram.app.App
import com.chitram.app.data.VideoFit
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.view.SurfaceView
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateZoom
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
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import android.widget.Toast
import com.chitram.app.player.WvcCast
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
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
        // Edge to edge, explicitly: the player must never sit inside the bar insets.
        window?.let { WindowCompat.setDecorFitsSystemWindows(it, false) }
        val ctl = window?.let { WindowCompat.getInsetsController(it, view) }
        ctl?.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        ctl?.hide(WindowInsetsCompat.Type.systemBars())
        val oldOrientation = activity?.requestedOrientation
        if (!isTv) activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        // Draw into the notch / cutout too, so the picture can use the whole panel.
        val oldCutout = window?.attributes?.let { if (Build.VERSION.SDK_INT >= 28) it.layoutInDisplayCutoutMode else null }
        if (window != null && Build.VERSION.SDK_INT >= 28) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode = if (Build.VERSION.SDK_INT >= 30) WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                else WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }
        onDispose {
            vm.leave()
            view.keepScreenOn = false
            ctl?.show(WindowInsetsCompat.Type.systemBars())
            if (window != null && oldCutout != null && Build.VERSION.SDK_INT >= 28) window.attributes = window.attributes.apply { layoutInDisplayCutoutMode = oldCutout }
            if (!isTv && oldOrientation != null) activity.requestedOrientation = oldOrientation
        }
    }

    // Hide the bars again on every resume. Some phones (OxygenOS among them)
    // bring the status and gesture bars back after the shade, a call or an
    // app switch, and they then stay on top of the picture.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val obs = LifecycleEventObserver { _, e ->
            if (e == Lifecycle.Event.ON_RESUME) activity?.window?.let {
                WindowCompat.getInsetsController(it, view).hide(WindowInsetsCompat.Type.systemBars())
            }
        }
        lifecycle.addObserver(obs)
        onDispose { lifecycle.removeObserver(obs) }
    }

    // What is on screen now: the request, or the episode the player rolled on to.
    val now = vm.request ?: req
    var controls by remember { mutableStateOf(true) }
    var menu by remember { mutableStateOf<Menu?>(null) }
    var lastInput by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var seekHint by remember { mutableIntStateOf(0) } // -1 back, 1 forward, for the double-tap badge
    val playerPrefs = App.instance.playerPrefs
    var fit by remember { mutableStateOf(playerPrefs.fitFor(isTv)) }
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
                    // Pinch out fills the screen, pinch in shows the whole picture.
                    awaitEachGesture {
                        awaitFirstDown(requireUnconsumed = false)
                        var zoom = 1f
                        do {
                            val ev = awaitPointerEvent()
                            if (ev.changes.count { it.pressed } >= 2) zoom *= ev.calculateZoom()
                        } while (ev.changes.any { it.pressed })
                        val pick = when { zoom > 1.15f -> VideoFit.Fill; zoom < 0.87f -> VideoFit.Fit; else -> null }
                        if (pick != null && pick != fit) { fit = pick; playerPrefs.fit = pick; poke() }
                    }
                }.pointerInput(Unit) {
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
        // Video surface. Fit: the whole picture, inside the screen both ways (a
        // fixed width overflowed 16:9 video on a 20:9 phone). Fill: cover the
        // screen and crop. Stretch: the full screen, distorted.
        val vs = vm.videoSize
        val ratio = if (vs.width > 0 && vs.height > 0) vs.width * vs.pixelWidthHeightRatio / vs.height else 16f / 9f
        BoxWithConstraints(Modifier.fillMaxSize().clipToBounds(), contentAlignment = Alignment.Center) {
            val surface = when (fit) {
                VideoFit.Fit -> Modifier.aspectRatio(ratio)
                VideoFit.Stretch -> Modifier.fillMaxSize()
                VideoFit.Fill -> if (maxWidth / maxHeight > ratio) Modifier.requiredSize(maxWidth, maxWidth / ratio)
                    else Modifier.requiredSize(maxHeight * ratio, maxHeight)
            }
            AndroidView(
                factory = { ctx -> SurfaceView(ctx).also { vm.player.setVideoSurfaceView(it) } },
                onRelease = { vm.player.clearVideoSurfaceView(it) },
                modifier = surface,
            )
        }

        if (vm.cues.isNotEmpty()) {
            BasicText(
                vm.cues,
                style = TextStyle(color = Color.White, fontSize = if (isTv) 24.sp else 18.sp, textAlign = TextAlign.Center),
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = if (controls) (if (isTv) 170.dp else 130.dp) else 40.dp, start = 48.dp, end = 48.dp)
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
                    CenterNote(note, sub = if (note.isNotEmpty() && count > 1 && !vm.offline) "Source ${(vm.sources.indexOf(vm.current) + 1).coerceIn(1, count)} of $count" else "")
                }
            }
        }

        if (seekHint != 0) {
            Box(Modifier.fillMaxSize(), contentAlignment = if (seekHint < 0) Alignment.CenterStart else Alignment.CenterEnd) {
                Box(Modifier.padding(horizontal = 72.dp).size(72.dp).background(Color.Black.copy(alpha = 0.45f), Tok.pill), contentAlignment = Alignment.Center) {
                    Glyph(if (seekHint < 0) Glyphs.seekBack else Glyphs.seekFwd, contentDescription = null, tint = Color.White, size = 36.dp, numeral = "10")
                }
            }
        }

        // A phone can still be portrait for a few frames before the forced landscape lands.
        // The control row cannot fit that width, so wait for landscape before drawing it.
        val landscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
        if (controls && (isTv || landscape) && vm.phase is PlayerVm.Phase.Playing && vm.nextUp == null) {
            Controls(vm, now, isTv, playFocus, fit, onFit = { fit = fit.next(); playerPrefs.fit = fit; poke() }, onMenu = { menu = it; poke() }, onBack = onBack, poke = ::poke)
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
    PillButton("Back", modifier = modifier, icon = Glyphs.back, onClick = onBack)
}

/** Web overlays.jsx Resolving: art, one spinner, title, status, Back, and Try again after 8s. */
@Composable
private fun LoadingScreen(r: PlayRequest, status: String, isTv: Boolean, onRetry: () -> Unit, onBack: () -> Unit) {
    var secs by remember { mutableIntStateOf(0) }
    LaunchedEffect(r) { secs = 0; while (true) { delay(1000); secs++ } }
    Box(Modifier.fillMaxSize()) {
        DimArt(r)
        if (!isTv) BackChip(false, onBack, Modifier.padding(16.dp))
        Column(Modifier.align(Alignment.Center).padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            CircularProgressIndicator(color = Tok.accent, trackColor = Tok.fill2, strokeWidth = 3.dp, modifier = Modifier.size(44.dp))
            BasicText(r.title, style = TextStyle(color = Tok.text, fontSize = if (isTv) 26.sp else 20.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center), modifier = Modifier.padding(top = 20.dp))
            subtitleFor(r)?.let { BasicText(it, style = TextStyle(color = Tok.textMuted, fontSize = 14.sp), modifier = Modifier.padding(top = 4.dp)) }
            BasicText(status, style = TextStyle(color = Tok.textSecondary, fontSize = 15.sp), modifier = Modifier.padding(top = 12.dp))
            if (secs >= 8) {
                val f = remember { FocusRequester() }
                LaunchedEffect(Unit) { if (isTv) runCatching { f.requestFocus() } }
                Row(Modifier.padding(top = 20.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    PillButton("Try again", icon = Glyphs.restart, modifier = Modifier.focusRequester(f), onClick = onRetry)
                    if (isTv) PillButton("Back", icon = Glyphs.back, onClick = onBack)
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
                PillButton("Try again", primary = true, icon = Glyphs.restart, modifier = Modifier.focusRequester(f), onClick = onRetry)
                PillButton("Back", icon = Glyphs.back, onClick = onBack)
            }
        }
    }
}

/**
 * Control layout, after the web desktop player (PlayerControls.jsx) and the
 * MX Player convention:
 * - top: back, title and episode, source chip on the right;
 * - bottom: one seek line with the time on its left and the length on its
 *   right, then a row with play and the 10 s skips on the left and the
 *   secondary actions (next, server, audio, quality, subtitles, fit) on the
 *   right. No centre play: double-tap owns the middle of the picture.
 * Phone and TV share the structure; TV only scales the targets up.
 */
@Composable
private fun Controls(
    vm: PlayerVm, r: PlayRequest, isTv: Boolean, playFocus: FocusRequester,
    fit: VideoFit, onFit: () -> Unit,
    onMenu: (Menu) -> Unit, onBack: () -> Unit, poke: () -> Unit,
) {
    val m = CtlMetrics.of(isTv)
    val next = vm.nextEpisode
    // Buttons carry their own padding round the glyph, so the row starts that
    // much further out: glyph edges then line up with the time text.
    val inset = m.side - (m.target - m.glyph) / 2
    // Full screen, same bounds as the video. No display-cutout padding: in
    // landscape a phone's camera cutout sits on one short edge, so that inset
    // pushed every control in from that side only (about 48dp on a Pixel 6,
    // more on OnePlus) while the other side kept 20dp. The punch hole sits at
    // mid-height, clear of the top and bottom rows.
    Box(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.7f), Color.Transparent)))
                .padding(start = if (isTv) m.side else inset, end = m.side, top = if (isTv) 24.dp else 6.dp, bottom = 32.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (!isTv) CtlButton(Glyphs.back, "Back", m, onClick = onBack)
            Column(Modifier.weight(1f).padding(start = if (isTv) 0.dp else 4.dp, end = 12.dp)) {
                BasicText(r.title, style = TextStyle(color = Tok.text, fontSize = m.title, fontWeight = FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
                subtitleFor(r)?.let { BasicText(it, style = TextStyle(color = Tok.textSecondary, fontSize = m.small), maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
            vm.current?.let { s ->
                // The language actually playing, not the source's first listed one.
                val lang = vm.audioItems().firstOrNull { it.selected }?.label?.takeUnless { it == "Default" } ?: s.languages.firstOrNull()
                BasicText(listOfNotNull(s.provider, lang).joinToString(" · "), style = TextStyle(color = Tok.textSecondary, fontSize = m.small),
                    maxLines = 1, modifier = Modifier.background(Color.Black.copy(alpha = 0.45f), Tok.pill).border(1.dp, Tok.border, Tok.pill).padding(horizontal = 12.dp, vertical = 5.dp))
            }
            // Cast to TV through Web Video Caster. Phone only: the TV layout has no use for it.
            if (!isTv && vm.current != null) {
                val ctx = LocalContext.current
                Spacer(Modifier.width(8.dp))
                CtlButton(Glyphs.cast, "Cast to TV", m) {
                    val spec = vm.castSpec() ?: return@CtlButton
                    when (WvcCast.open(ctx, spec)) {
                        is WvcCast.Launch.Wvc -> spec.hint?.let { Toast.makeText(ctx, it, Toast.LENGTH_LONG).show() }
                        is WvcCast.Launch.Store -> Toast.makeText(ctx, "Install Web Video Caster to cast to your TV", Toast.LENGTH_LONG).show()
                        null -> Toast.makeText(ctx, "Could not open Web Video Caster", Toast.LENGTH_LONG).show()
                    }
                }
            }
        }

        Column(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.45f), Color.Black.copy(alpha = 0.85f))))
                .padding(top = 36.dp, bottom = if (isTv) 24.dp else 6.dp),
        ) {
            // Time | seek line | length. Tap the length for time remaining.
            var remaining by remember { mutableStateOf(false) }
            Row(Modifier.fillMaxWidth().padding(horizontal = m.side), verticalAlignment = Alignment.CenterVertically) {
                val tw = Modifier.width(m.timeWidth)
                BasicText(fmtTime(vm.positionMs), style = TextStyle(color = Tok.text, fontSize = m.time, fontWeight = FontWeight.Medium), modifier = tw)
                Box(Modifier.weight(1f).padding(horizontal = 12.dp)) { SeekBar(vm, isTv, poke) }
                BasicText(
                    when { vm.durationMs <= 0 -> "--:--"; remaining -> "-" + fmtTime(vm.durationMs - vm.positionMs); else -> fmtTime(vm.durationMs) },
                    style = TextStyle(color = Tok.text, fontSize = m.time, fontWeight = FontWeight.Medium, textAlign = TextAlign.End),
                    modifier = tw.then(if (isTv) Modifier else Modifier.clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { remaining = !remaining; poke() }),
                )
            }
            BoxWithConstraints(Modifier.fillMaxWidth().padding(start = inset, end = inset, top = if (isTv) 10.dp else 0.dp)) {
                // Labels only where all of them fit at full size; icons always do.
                // Measured need: about 840dp on TV and 700dp on a phone, plus
                // about 100dp more when the Next episode pill is in the row.
                val labels = maxWidth >= (if (isTv) 750.dp else 700.dp) + (if (next != null) 100.dp else 0.dp)
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(m.gap)) {
                    CtlButton(if (vm.isPlaying) Glyphs.pause else Glyphs.play, if (vm.isPlaying) "Pause" else "Play", m, primary = true,
                        modifier = Modifier.focusRequester(playFocus)) { vm.togglePlay(); poke() }
                    CtlButton(Glyphs.seekBack, "Back 10 seconds", m, numeral = "10") { vm.seekBy(-10_000); poke() }
                    CtlButton(Glyphs.seekFwd, "Forward 10 seconds", m, numeral = "10") { vm.seekBy(10_000); poke() }
                    Spacer(Modifier.weight(1f))
                    if (next != null) CtlButton(Glyphs.next, "Next episode", m, label = "Next") { vm.start(next) }
                    CtlButton(Glyphs.server, "Server", m, label = if (labels) "Server" else null) { onMenu(Menu.Server) }
                    CtlButton(Glyphs.audio, "Audio", m, label = if (labels) "Audio" else null) { onMenu(Menu.Audio) }
                    CtlButton(Glyphs.quality, "Quality", m, label = if (labels) "Quality" else null) { onMenu(Menu.Quality) }
                    CtlButton(Glyphs.subtitles, "Subtitles", m, label = if (labels) "Subtitles" else null) { onMenu(Menu.Subtitles) }
                    // Picture fit: one press cycles Fit, Fill, Stretch; the label names the current mode.
                    // Phone only (owner, 1.1.3): a TV is already full screen and the remote has no use for it.
                    if (!isTv) CtlButton(
                        when (fit) { VideoFit.Fit -> Glyphs.fitContain; VideoFit.Fill -> Glyphs.fitCover; VideoFit.Stretch -> Glyphs.fitFill },
                        "Picture: ${fit.label}", m, label = fit.label, onClick = onFit,
                    )
                }
            }
        }
    }
}

/** Sizes per form factor. Phone targets are 48dp (touch floor); TV targets 60dp. */
private class CtlMetrics(
    val side: Dp, val target: Dp, val primary: Dp, val glyph: Dp, val primaryGlyph: Dp, val gap: Dp,
    val title: TextUnit, val small: TextUnit, val time: TextUnit, val label: TextUnit, val timeWidth: Dp,
) {
    companion object {
        private val phone = CtlMetrics(20.dp, 48.dp, 52.dp, 24.dp, 28.dp, 4.dp, 17.sp, 13.sp, 13.sp, 13.sp, 58.dp)
        private val tv = CtlMetrics(48.dp, 60.dp, 64.dp, 28.dp, 32.dp, 12.dp, 26.sp, 16.sp, 17.sp, 17.sp, 84.dp)
        fun of(isTv: Boolean) = if (isTv) tv else phone
    }
}

/**
 * Progress with buffered range and a knob. Touch: tap or drag to seek; the
 * seek happens on release. TV: the line takes focus (Up from the buttons) and
 * Left/Right then seek 10 s. Focus shows as a thicker line and a bigger knob,
 * no outline round the bar.
 */
@Composable
private fun SeekBar(vm: PlayerVm, isTv: Boolean, poke: () -> Unit) {
    val dur = vm.durationMs
    var drag by remember { mutableStateOf<Float?>(null) }
    val src = remember { MutableInteractionSource() }
    val focused by src.collectIsFocusedAsState()
    val frac = drag ?: if (dur > 0) (vm.positionMs.toFloat() / dur).coerceIn(0f, 1f) else 0f
    val buf = if (dur > 0) (vm.bufferedMs.toFloat() / dur).coerceIn(0f, 1f) else 0f
    BoxWithConstraints(
        Modifier.fillMaxWidth().height(if (isTv) 28.dp else 32.dp)
            .then(
                if (isTv) Modifier
                    .onPreviewKeyEvent { e ->
                        if (!focused || e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                        when (e.key) {
                            Key.DirectionLeft -> { vm.seekBy(-10_000); poke(); true }
                            Key.DirectionRight -> { vm.seekBy(10_000); poke(); true }
                            else -> false
                        }
                    }
                    .focusable(interactionSource = src)
                else if (dur <= 0) Modifier
                else Modifier
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
        val active = drag != null || focused
        // Web .pctl-track: a thin white line on a faint track, buffered in between.
        val line = when { focused -> 8.dp; isTv -> 5.dp; drag != null -> 5.dp; else -> 3.dp }
        Box(Modifier.fillMaxWidth().height(line).clip(Tok.pill).background(Color.White.copy(alpha = 0.2f))) {
            Box(Modifier.fillMaxHeight().fillMaxWidth(buf).background(Color.White.copy(alpha = 0.34f)))
            Box(Modifier.fillMaxHeight().fillMaxWidth(frac).background(Color.White))
        }
        val knob = when { focused -> 26.dp; active -> 18.dp; isTv -> 16.dp; else -> 14.dp }
        Box(Modifier.offset(x = (w - knob) * frac).size(knob).shadow(3.dp, Tok.pill).background(Color.White, Tok.pill))
    }
}

/**
 * A player control: a round icon target, or a pill with a label. Focus is the
 * app's one control focus (white fill, dark ink, shadow, lift; see Focus).
 */
@Composable
private fun CtlButton(
    icon: ImageVector, description: String, m: CtlMetrics,
    modifier: Modifier = Modifier, label: String? = null, primary: Boolean = false, numeral: String? = null, onClick: () -> Unit,
) {
    val src = remember { MutableInteractionSource() }
    val focused by src.collectIsFocusedAsState()
    val bg = when {
        focused -> Focus.fill
        primary -> Focus.primaryFill
        else -> Color.Transparent
    }
    val fg = if (focused) Focus.ink else Color.White
    val h = if (primary) m.primary else m.target
    val shape = Tok.pill
    Row(
        modifier
            .height(h)
            .then(if (label == null) Modifier.width(h) else Modifier)
            .controlFocus(focused, shape)
            .clip(shape)
            .background(bg)
            .clickable(interactionSource = src, indication = null, onClick = onClick)
            .padding(horizontal = if (label == null) 0.dp else 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        Glyph(icon, contentDescription = description, tint = fg, size = if (primary) m.primaryGlyph else m.glyph, numeral = numeral)
        if (label != null) BasicText(label, style = TextStyle(color = fg, fontSize = m.label, fontWeight = FontWeight.Medium), maxLines = 1, modifier = Modifier.padding(start = 8.dp))
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
                PillButton("Play next · ${left}s", primary = true, icon = Glyphs.play, modifier = Modifier.focusRequester(f), onClick = onPlay)
                PillButton("Not now", onClick = onDismiss)
            }
        }
    }
}

/** Focus-aware pill (see Focus): white fill, dark ink, shadow; no scale in the player. */
@Composable
fun PillButton(text: String, modifier: Modifier = Modifier, primary: Boolean = false, icon: ImageVector? = null, onClick: () -> Unit) {
    val src = remember { MutableInteractionSource() }
    val focused by src.collectIsFocusedAsState()
    val bg = if (focused) Focus.fill else if (primary) Focus.primaryButton else Tok.fill2
    val fg = if (focused || primary) Focus.ink else Tok.text
    Row(
        modifier
            // Ring space is always reserved so focus never shifts the layout.
            .then(if (primary && !focused) Modifier.padding(Focus.ringOffset + Focus.ringWidth) else Modifier)
            .controlFocus(focused, Tok.pill, ring = primary)
            .clip(Tok.pill)
            .background(bg)
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
                            .controlFocus(focused, Tok.radiusMd, lift = false)
                            .clip(Tok.radiusMd)
                            .background(if (focused) Focus.fill else Color.Transparent)
                            .clickable(interactionSource = src, indication = null) { onPick(item.key) }
                            .padding(horizontal = 12.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            BasicText(item.label, style = TextStyle(color = if (focused) Focus.ink else if (item.dim) Tok.textDim else Tok.text, fontSize = if (isTv) 18.sp else 16.sp))
                            if (item.detail.isNotEmpty()) BasicText(item.detail, style = TextStyle(color = if (focused) Focus.ink.copy(alpha = 0.7f) else Tok.textMuted, fontSize = if (isTv) 14.sp else 12.sp), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        if (item.selected) Icon(Glyphs.check, contentDescription = "Selected", tint = if (focused) Focus.ink else Color.White, modifier = Modifier.size(20.dp))
                    }
                }
            }
        }
    }
}
