package com.chitram.app.ui.common

import android.app.Activity
import android.content.pm.ActivityInfo
import android.view.SurfaceView
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
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
 * Touch: tap shows the bar. No animation besides a progress bar.
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

    var controls by remember { mutableStateOf(true) }
    var menu by remember { mutableStateOf<Menu?>(null) }
    var lastInput by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val playFocus = remember { FocusRequester() }
    val rootFocus = remember { FocusRequester() }
    fun poke() { lastInput = System.currentTimeMillis() }

    // Auto-hide the bar after 4s of no input while playing.
    LaunchedEffect(controls, menu, vm.isPlaying, lastInput) {
        if (controls && menu == null && vm.isPlaying) {
            delay(4000)
            controls = false
        }
    }
    LaunchedEffect(controls, menu) {
        runCatching { if (controls && menu == null) playFocus.requestFocus() else if (!controls) rootFocus.requestFocus() }
    }

    val back = {
        when {
            menu != null -> menu = null
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
                if (menu != null) return@onPreviewKeyEvent false
                when (e.key) {
                    // Media keys go on to the system, which hands them to the
                    // MediaSession (PlayerVm). Here they only show the bar.
                    Key.MediaPlayPause, Key.MediaPlay, Key.MediaPause, Key.MediaFastForward, Key.MediaRewind -> { controls = true; false }
                    else -> if (!controls) {
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
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {
                poke(); controls = !controls
            },
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
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = if (controls) 140.dp else 40.dp, start = 48.dp, end = 48.dp)
                    .background(Color.Black.copy(alpha = 0.55f), Tok.radiusMd).padding(horizontal = 12.dp, vertical = 4.dp),
            )
        }

        when (val ph = vm.phase) {
            is PlayerVm.Phase.Resolving -> CenterNote(vm.status.ifEmpty { "Loading" }, spinner = true)
            is PlayerVm.Phase.Failed -> FailedPanel(ph.message, onRetry = { vm.retry() }, onBack = onBack)
            is PlayerVm.Phase.Playing -> if (vm.buffering) CenterNote(vm.status, spinner = true)
        }

        if (controls && vm.phase is PlayerVm.Phase.Playing) {
            ControlBar(vm, req, isTv, playFocus, onMenu = { menu = it; poke() }, onBack = onBack, poke = ::poke)
        }

        menu?.let { m ->
            val items = when (m) {
                Menu.Server -> vm.serverItems()
                Menu.Audio -> vm.audioItems()
                Menu.Quality -> vm.qualityItems()
                Menu.Subtitles -> vm.subtitleItems()
            }
            MenuPanel(m.title, items, onPick = { vm.choose(it); menu = null; poke() })
        }
    }
}

@Composable
private fun CenterNote(text: String, spinner: Boolean) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            if (spinner) Dots()
            if (text.isNotEmpty()) BasicText(text, style = TextStyle(color = Tok.textSecondary, fontSize = 16.sp), modifier = Modifier.padding(top = 12.dp))
        }
    }
}

/** Three-dot loader stepped at 300ms: cheaper than an infinite animation. */
@Composable
private fun Dots() {
    var step by remember { mutableStateOf(0) }
    LaunchedEffect(Unit) { while (true) { delay(300); step = (step + 1) % 3 } }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        repeat(3) { i -> Box(Modifier.size(10.dp).background(if (i == step) Tok.accent else Tok.fill3, Tok.pill)) }
    }
}

@Composable
private fun FailedPanel(message: String, onRetry: () -> Unit, onBack: () -> Unit) {
    val f = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { f.requestFocus() } }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(32.dp)) {
            BasicText("Can't play this right now", style = TextStyle(color = Tok.text, fontSize = 22.sp, fontWeight = FontWeight.SemiBold))
            BasicText(message, style = TextStyle(color = Tok.textMuted, fontSize = 14.sp, textAlign = TextAlign.Center), modifier = Modifier.padding(top = 8.dp, bottom = 20.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                PillButton("Try again", primary = true, modifier = Modifier.focusRequester(f), onClick = onRetry)
                PillButton("Back", onClick = onBack)
            }
        }
    }
}

@Composable
private fun ControlBar(
    vm: PlayerVm, req: PlayRequest, isTv: Boolean, playFocus: FocusRequester,
    onMenu: (Menu) -> Unit, onBack: () -> Unit, poke: () -> Unit,
) {
    Box(Modifier.fillMaxSize()) {
        // Top: title.
        Column(
            Modifier.fillMaxWidth().background(androidx.compose.ui.graphics.Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.7f), Color.Transparent)))
                .padding(horizontal = if (isTv) 48.dp else 20.dp, vertical = 20.dp),
        ) {
            BasicText(req.title, style = TextStyle(color = Tok.text, fontSize = if (isTv) 24.sp else 18.sp, fontWeight = FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
            val sub = listOfNotNull(
                if (req.type == "tv") "S${req.season} E${req.episode}" + (req.epTitle?.let { " · $it" } ?: "") else null,
                vm.current?.let { "${it.provider} · ${it.languages.firstOrNull() ?: it.quality}" },
            ).joinToString("   ")
            if (sub.isNotEmpty()) BasicText(sub, style = TextStyle(color = Tok.textMuted, fontSize = 14.sp), maxLines = 1)
        }
        // Bottom: progress and buttons.
        Column(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                .background(androidx.compose.ui.graphics.Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.8f))))
                .padding(horizontal = if (isTv) 48.dp else 20.dp, vertical = if (isTv) 28.dp else 16.dp),
        ) {
            val dur = vm.durationMs
            val pos = vm.positionMs
            Row(verticalAlignment = Alignment.CenterVertically) {
                BasicText(fmtTime(pos), style = TextStyle(color = Tok.textSecondary, fontSize = 13.sp))
                Box(Modifier.weight(1f).padding(horizontal = 12.dp).height(4.dp).background(Tok.fill3, Tok.pill)) {
                    val frac = if (dur > 0) (pos.toFloat() / dur).coerceIn(0f, 1f) else 0f
                    Box(Modifier.fillMaxHeight().fillMaxWidth(frac).background(Tok.accent, Tok.pill))
                }
                BasicText(if (dur > 0) fmtTime(dur) else "--:--", style = TextStyle(color = Tok.textSecondary, fontSize = 13.sp))
            }
            Spacer(Modifier.height(14.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                if (!isTv) PillButton("Back", onClick = onBack)
                PillButton("-10s", onClick = { vm.seekBy(-10_000); poke() })
                PillButton(if (vm.isPlaying) "Pause" else "Play", primary = true, modifier = Modifier.focusRequester(playFocus).width(96.dp)) { vm.togglePlay(); poke() }
                PillButton("+10s", onClick = { vm.seekBy(10_000); poke() })
                Spacer(Modifier.weight(1f))
                PillButton("Server") { onMenu(Menu.Server) }
                PillButton("Audio") { onMenu(Menu.Audio) }
                PillButton("Quality") { onMenu(Menu.Quality) }
                PillButton("Subtitles") { onMenu(Menu.Subtitles) }
            }
        }
    }
}

/** Focus-aware pill. Focus = accent ring; no scale animation in the player. */
@Composable
fun PillButton(text: String, modifier: Modifier = Modifier, primary: Boolean = false, onClick: () -> Unit) {
    val src = remember { MutableInteractionSource() }
    val focused by src.collectIsFocusedAsState()
    val bg = when {
        primary -> Color.White
        focused -> Tok.fill3
        else -> Tok.fill2
    }
    Box(
        modifier
            .clip(Tok.pill)
            .background(bg)
            .border(2.dp, if (focused) Tok.accent else Color.Transparent, Tok.pill)
            .clickable(interactionSource = src, indication = null, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 9.dp),
        contentAlignment = Alignment.Center,
    ) {
        BasicText(text, style = TextStyle(color = if (primary) Tok.bg else Tok.text, fontSize = 15.sp, fontWeight = FontWeight.Medium))
    }
}

@Composable
private fun MenuPanel(title: String, items: List<MenuItem>, onPick: (String) -> Unit) {
    val first = remember { FocusRequester() }
    LaunchedEffect(title) { runCatching { first.requestFocus() } }
    Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.4f)), contentAlignment = Alignment.CenterEnd) {
        Column(Modifier.fillMaxHeight().width(360.dp).background(Tok.surface).padding(vertical = 24.dp)) {
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
                        if (item.selected) BasicText("✓", style = TextStyle(color = Tok.accent, fontSize = 18.sp))
                    }
                }
            }
        }
    }
}
