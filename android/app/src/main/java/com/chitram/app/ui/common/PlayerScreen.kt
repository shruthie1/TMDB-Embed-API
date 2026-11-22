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
import androidx.compose.foundation.focusGroup
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.layout
import kotlin.math.roundToInt
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import com.chitram.app.player.LoadingModel
import androidx.compose.foundation.text.BasicText
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.key
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
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
import kotlinx.coroutines.launch
import androidx.compose.runtime.rememberCoroutineScope

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
    var serverProvider by remember { mutableStateOf<String?>(null) }
    // Where each menu button sits, so its sheet opens just above it (phone).
    val menuAnchors = remember { mutableStateMapOf<Menu, Rect>() }
    var lastInput by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var seekHint by remember { mutableIntStateOf(0) } // -1 back, 1 forward, for the double-tap badge
    val playerPrefs = App.instance.playerPrefs
    var fit by remember { mutableStateOf(playerPrefs.fitFor(isTv)) }
    val playFocus = remember { FocusRequester() }
    val rootFocus = remember { FocusRequester() }
    // TV: each sheet's button, so closing a sheet hands focus back to the button
    // that opened it, not to Play/Pause.
    val menuFocus = remember { Menu.entries.associateWith { FocusRequester() } }
    var returnTo by remember { mutableStateOf<Menu?>(null) }
    // Loading-screen Details panel (LoadingModel rows).
    var details by remember { mutableStateOf(false) }
    // Before the first frame the loading screen owns the screen, also in Playing.
    val loading = vm.phase is PlayerVm.Phase.Resolving || (vm.phase is PlayerVm.Phase.Playing && !vm.framed)
    fun poke() { lastInput = System.currentTimeMillis() }

    // Auto-hide the controls after 4s of no input while playing.
    LaunchedEffect(controls, menu, vm.isPlaying, lastInput) {
        if (controls && menu == null && vm.isPlaying) {
            delay(4000)
            controls = false
        }
    }
    LaunchedEffect(controls, menu, vm.phase, vm.framed) {
        if (vm.phase !is PlayerVm.Phase.Playing || !vm.framed) return@LaunchedEffect
        details = false
        if (isTv && controls && menu == null) {
            // A sheet just closed: back to its button. Otherwise (bar shown) Play/Pause.
            val back = returnTo?.let { menuFocus.getValue(it) }
            returnTo = null
            (back ?: playFocus).focusWhenAttached()
            return@LaunchedEffect
        }
        runCatching { if (controls && menu == null) playFocus.requestFocus() else if (!controls) rootFocus.requestFocus() }
    }
    LaunchedEffect(seekHint, lastInput) { if (seekHint != 0) { delay(600); seekHint = 0 } }

    val back: () -> Unit = {
        android.util.Log.i("Chitram", "[back] menu=$menu provider=$serverProvider details=$details")
        when {
            details -> details = false
            menu == Menu.Server && serverProvider != null -> serverProvider = null
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
                    else -> if (!controls && vm.phase is PlayerVm.Phase.Playing && vm.framed) {
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
                        if (pick != null && pick != fit) { fit = pick; playerPrefs.save(isTv, pick); poke() }
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
        // screen and crop. Fit width (TV sheet): full width, crop top and bottom.
        // Stretch: the full screen, distorted. Bare SurfaceView, so media3
        // resize modes do not apply; the surface is sized here (fitSize rules).
        val vs = vm.videoSize
        val ratio = if (vs.width > 0 && vs.height > 0) vs.width * vs.pixelWidthHeightRatio / vs.height else 16f / 9f
        BoxWithConstraints(Modifier.fillMaxSize().clipToBounds(), contentAlignment = Alignment.Center) {
            val surface = when (fit) {
                VideoFit.Fit -> Modifier.aspectRatio(ratio)
                VideoFit.Stretch -> Modifier.fillMaxSize()
                VideoFit.Fill, VideoFit.FitWidth -> fitSize(fit, maxWidth.value, maxHeight.value, ratio).let { (w, h) -> Modifier.requiredSize(w.dp, h.dp) }
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
                style = TextStyle(color = Color.White, fontSize = if (isTv) 20.sp else 14.sp, textAlign = TextAlign.Center),
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = if (controls) (if (isTv) 170.dp else 130.dp) else 40.dp, start = 48.dp, end = 48.dp)
                    .background(Color.Black.copy(alpha = 0.55f), Tok.radiusMd).padding(horizontal = 12.dp, vertical = 4.dp),
            )
        }

        if (loading || vm.phase is PlayerVm.Phase.Failed) {
            LoadingScreen(now, vm, isTv, details, onDetails = { details = it }, onChooseServer = { details = false; serverProvider = null; menu = Menu.Server }, onBack = onBack)
        } else {
            val note = vm.notice
            if (vm.buffering || note.isNotEmpty()) {
                val count = vm.sources.size
                CenterNote(note, sub = if (note.isNotEmpty() && count > 1 && !vm.offline) "${vm.attempts.size.coerceAtLeast(1)} of $count tried" else "")
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
        if (controls && (isTv || landscape) && vm.phase is PlayerVm.Phase.Playing && vm.framed && vm.nextUp == null) {
            Controls(vm, now, isTv, playFocus, menuFocus, fit, onFit = { fit = fit.next(); playerPrefs.save(isTv, fit); poke() }, onMenu = { menu = it; returnTo = it; serverProvider = null; poke() }, onBack = onBack, poke = ::poke,
                onAnchor = { k, r -> if (menuAnchors[k] != r) menuAnchors[k] = r })
        }

        vm.nextUp?.let { next -> NextUpCard(next, isTv, onPlay = { vm.start(next) }, onDismiss = { vm.dismissNext(); controls = true }) }

        // Live countdown and auto-hiding result line on the "Refresh sources" row.
        var refreshTick by remember { mutableLongStateOf(System.currentTimeMillis()) }
        LaunchedEffect(menu == Menu.Server) { while (menu == Menu.Server) { refreshTick = System.currentTimeMillis(); delay(500) } }
        menu?.let { m ->
            val items = when (m) {
                Menu.Server -> vm.serverItems(serverProvider, refreshTick)
                Menu.Audio -> vm.audioItems()
                // TV has no bar fit button: picture fit is a section of the Quality sheet.
                Menu.Quality -> if (isTv) vm.qualityItems() + fitItems(fit) else vm.qualityItems()
                Menu.Subtitles -> vm.subtitleItems()
            }
            val shown = if (m == Menu.Server && serverProvider.equals("netmirror", true)) items + MenuItem("check:netmirror", if (vm.checkingNetmirror) "Checking sources…" else "Check for more streams", vm.netmirrorNote ?: "Current playback continues") else items
            MenuPanel(m, shown, isTv, anchor = if (vm.phase is PlayerVm.Phase.Playing) menuAnchors[m] else null, titleOverride = if (m == Menu.Server) serverProvider else null,
                onUp = if (m == Menu.Server && serverProvider != null) ({ serverProvider = null }) else null,
                onClose = { menu = null }, onPick = { key ->
                    when (menuTap(shown.firstOrNull { it.key == key })) {
                        MenuTap.Drill -> {
                            serverProvider = key.removePrefix("group:")
                            if (serverProvider.equals("netmirror", true) && vm.serverItems(serverProvider).isEmpty()) vm.checkNetmirror()
                        }
                        MenuTap.Check -> vm.checkNetmirror()
                        // Stays in the list; focus stays on the row (same key) through refreshing and cooldown.
                        MenuTap.Refresh -> { vm.refreshSources(); refreshTick = System.currentTimeMillis() }
                        // TV picture fit: apply and stay in the sheet. Row keys do not change,
                        // so focus stays on the picked row (never falls to Play/Pause).
                        MenuTap.Fit -> VideoFit.parse(key.removePrefix(FIT_KEY))?.let { fit = it; playerPrefs.save(isTv, it) }
                        // A2: the selected row is already playing; just close.
                        MenuTap.Close -> menu = null
                        // TV, sheet opened from the bar: apply and stay in the sheet; focus
                        // follows the new selection (MenuPanel). Re-tap closes (A2 above).
                        // Phones, and a server picked on the loading screen, close as before.
                        MenuTap.Choose -> { vm.choose(key); if (!(isTv && vm.phase is PlayerVm.Phase.Playing && vm.framed)) menu = null }
                    }
                    poke()
                })
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

/**
 * Loading screen and end card, driven by LoadingModel (loading-ux spec, same
 * copy as the web). Back and Details from 0s. No Try again while anything is
 * loading. TV focus starts on Details and never jumps when a button appears.
 */
@Composable
private fun LoadingScreen(r: PlayRequest, vm: PlayerVm, isTv: Boolean, details: Boolean, onDetails: (Boolean) -> Unit, onChooseServer: () -> Unit, onBack: () -> Unit) {
    var tick by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { tick = System.currentTimeMillis(); delay(500) } }
    val v = vm.loadingView(tick)
    val failed = v.phase == LoadingModel.Phase.FAILED
    val detailsFocus = remember { FocusRequester() }
    val retryFocus = remember { FocusRequester() }
    var focusRow by remember { mutableStateOf<String?>(null) }
    // Initial TV focus: Details while loading; Refresh sources on the failure card (LoadingModel.tvFocus).
    LaunchedEffect(failed) { if (isTv) runCatching { if (LoadingModel.tvFocus(v) == LoadingModel.Focus.REFRESH) retryFocus.requestFocus() else detailsFocus.requestFocus() } }
    var wasOpen by remember { mutableStateOf(false) }
    LaunchedEffect(details) {
        if (isTv && wasOpen && !details) runCatching { detailsFocus.requestFocus() }
        wasOpen = details
    }
    Box(Modifier.fillMaxSize()) {
        DimArt(r)
        Row(Modifier.fillMaxSize()) {
            Box(Modifier.weight(1f).fillMaxHeight()) {
                if (!isTv) BackChip(false, onBack, Modifier.padding(16.dp))
                Column(Modifier.align(Alignment.Center).padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    if (failed) BasicText("!", style = TextStyle(color = Tok.text, fontSize = 30.sp, fontWeight = FontWeight.SemiBold), modifier = Modifier.clearAndSetSemantics { })
                    else CircularProgressIndicator(color = Tok.accent, trackColor = Tok.fill2, strokeWidth = 3.dp, modifier = Modifier.size(44.dp).clearAndSetSemantics { })
                    BasicText(r.title, style = TextStyle(color = Tok.text, fontSize = if (isTv) 26.sp else 20.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center), modifier = Modifier.padding(top = 20.dp))
                    subtitleFor(r)?.let { BasicText(it, style = TextStyle(color = Tok.textMuted, fontSize = 14.sp), modifier = Modifier.padding(top = 4.dp)) }
                    // Only the headline is a live region: TalkBack hears a phase change, not a tick.
                    BasicText(
                        v.headline,
                        style = TextStyle(color = Tok.text, fontSize = if (isTv) 19.sp else 16.sp, textAlign = TextAlign.Center),
                        modifier = Modifier.padding(top = 12.dp).semantics { liveRegion = LiveRegionMode.Polite },
                    )
                    if (v.detail.isNotEmpty()) {
                        val ticking = v.phase == LoadingModel.Phase.FINDING
                        BasicText(
                            v.detail,
                            style = TextStyle(color = Tok.textMuted, fontSize = 14.sp, textAlign = TextAlign.Center),
                            modifier = Modifier.padding(top = 4.dp).then(if (ticking) Modifier.clearAndSetSemantics { } else Modifier),
                        )
                    }
                    Row(Modifier.padding(top = 20.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        if (v.showRefresh) {
                            val m = vm.refreshModel
                            val label = m.label(tick)
                            PillButton(label, primary = true, icon = Glyphs.restart, busy = m.running,
                                modifier = Modifier.focusRequester(retryFocus).semantics { contentDescription = listOfNotNull(label, m.noteAt(tick)).joinToString(". ") },
                                onClick = { vm.refreshSources() })
                            PillButton("Back", icon = Glyphs.back, onClick = onBack)
                        } else if (isTv) PillButton("Back", icon = Glyphs.back, onClick = onBack)
                        if (v.showChooser) PillButton("Choose a server", icon = Glyphs.server) {
                            onChooseServer()
                        }
                        if (v.showTryAgain) PillButton("Try again", primary = failed, icon = Glyphs.restart, modifier = Modifier.focusRequester(retryFocus), onClick = { vm.retry() })
                        PillButton(
                            if (details) "Details ⌃" else "Details ⌄",
                            modifier = Modifier.focusRequester(detailsFocus).semantics { stateDescription = if (details) "Expanded" else "Collapsed" },
                        ) { focusRow = null; onDetails(!details) }
                    }
                    if (v.showRefresh) {
                        val m = vm.refreshModel
                        // Result line (auto-hides after 3 s) or the providers answering so far.
                        val line = m.noteAt(tick) ?: if (m.running) m.chips() else ""
                        BasicText(line, style = TextStyle(color = Tok.textMuted, fontSize = 14.sp, textAlign = TextAlign.Center),
                            modifier = Modifier.padding(top = 10.dp).semantics { liveRegion = LiveRegionMode.Polite })
                    }
                }
            }
            if (details) LoadingDetails(v, isTv, focusRow, onPick = { onDetails(false); vm.playSource(it) }, onClose = { onDetails(false) })
        }
    }
}

/** Details: one row per source (or per search check), in try order. Rows that can play are focusable. */
@Composable
private fun LoadingDetails(v: LoadingModel.View, isTv: Boolean, focusId: String?, onPick: (String) -> Unit, onClose: () -> Unit) {
    val first = remember { FocusRequester() }
    val target = focusId ?: v.rows.firstOrNull { it.clickable }?.id
    LaunchedEffect(Unit) { if (isTv && target != null) runCatching { first.requestFocus() } }
    // Phones: the panel ends after its last row (same height cap as the player sheets), no empty band below.
    // Plain Box, not BoxWithConstraints: its subcomposed content went stale on the player sheets (dead taps/back).
    val screen = LocalConfiguration.current
    Box(Modifier.fillMaxWidth(0.4f).fillMaxHeight(), contentAlignment = Alignment.Center) {
    val layout = playerMenuLayout(screen.screenWidthDp.toFloat().coerceAtLeast(1f), screen.screenHeightDp.toFloat().coerceAtLeast(1f), isTv)
    Column(
        Modifier.fillMaxWidth()
            .then(if (isTv) Modifier.fillMaxHeight() else Modifier.padding(vertical = layout.inset.dp).heightIn(max = layout.height.dp).clip(Tok.radiusLg))
            .background(Tok.surface.copy(alpha = 0.94f))
            .windowInsetsPadding(WindowInsets.displayCutout.only(WindowInsetsSides.End))
            .onPreviewKeyEvent { e ->
                if (e.type == KeyEventType.KeyDown && e.key == Key.DirectionLeft) { onClose(); true } else false
            }
            .padding(vertical = if (isTv) 24.dp else 4.dp),
    ) {
        BasicText("Sources", style = TextStyle(color = Tok.text, fontSize = if (isTv) 20.sp else 14.sp, fontWeight = FontWeight.SemiBold), modifier = Modifier.padding(horizontal = if (isTv) 18.dp else 14.dp, vertical = if (isTv) 6.dp else 8.dp))
        LazyColumn(Modifier.fillMaxWidth().weight(1f, fill = isTv)) {
            items(v.rows, key = { it.id }) { row ->
                val src = remember { MutableInteractionSource() }
                val focused by src.collectIsFocusedAsState()
                val mark = when (row.state) {
                    LoadingModel.RowState.WAITING -> "○"
                    LoadingModel.RowState.CHECKING -> "◌"
                    LoadingModel.RowState.STARTING -> "●"
                    LoadingModel.RowState.PLAYING -> "✓"
                    LoadingModel.RowState.SKIPPED -> "-"
                    LoadingModel.RowState.FAILED -> "✕"
                    LoadingModel.RowState.LEFT -> "○"
                }
                Column(
                    Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp)
                        .then(if (row.id == target) Modifier.focusRequester(first) else Modifier)
                        .then(
                            if (row.clickable) Modifier.controlFocus(focused, Tok.radiusMd, lift = false).clip(Tok.radiusMd)
                                .background(if (focused) Focus.fill else Color.Transparent)
                                .clickable(interactionSource = src, indication = null) { onPick(row.id) }
                            else Modifier,
                        )
                        .semantics(mergeDescendants = true) {
                            contentDescription = row.description
                            if (row.clickable) role = Role.Button
                        }
                        .then(if (isTv) Modifier.padding(horizontal = 10.dp, vertical = 7.dp) else Modifier.heightIn(min = 40.dp).padding(horizontal = 10.dp, vertical = 4.dp)),
                    verticalArrangement = Arrangement.Center,
                ) {
                    val ink = if (focused) Focus.ink else Tok.text
                    BasicText("$mark ${row.title}", style = if (isTv) TextStyle(color = ink, fontSize = 17.sp) else TextStyle(color = ink, fontSize = 14.sp, lineHeight = 17.sp, lineHeightStyle = TightLines), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    BasicText(
                        row.status + if (focused && isTv) " · OK to play" else "",
                        style = if (isTv) TextStyle(color = if (focused) Focus.ink.copy(alpha = 0.75f) else Tok.textSecondary, fontSize = 14.sp)
                            else TextStyle(color = if (focused) Focus.ink.copy(alpha = 0.75f) else Tok.textSecondary, fontSize = 12.sp, lineHeight = 14.sp, lineHeightStyle = TightLines),
                        modifier = Modifier.padding(start = 16.dp, top = if (isTv) 1.dp else 0.dp),
                    )
                }
            }
        }
        BasicText(v.footer, style = TextStyle(color = Tok.textMuted, fontSize = 12.sp), modifier = Modifier.padding(horizontal = if (isTv) 18.dp else 14.dp, vertical = if (isTv) 6.dp else 4.dp).clearAndSetSemantics { })
    }
    }
}

/** Phone sheet text: trims the font's extra leading so a row's name and detail sit together. */
private val TightLines = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.Both)

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
    menuFocus: Map<Menu, FocusRequester>,
    fit: VideoFit, onFit: () -> Unit,
    onMenu: (Menu) -> Unit, onBack: () -> Unit, poke: () -> Unit,
    onAnchor: (Menu, Rect) -> Unit = { _, _ -> },
) {
    val m = CtlMetrics.of(isTv)
    fun anchor(k: Menu) = Modifier.onGloballyPositioned { onAnchor(k, it.boundsInRoot()) }.focusRequester(menuFocus.getValue(k))
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
                val lang = vm.audioItems().firstOrNull { it.selected }?.label?.takeUnless { it == "Default" } ?: LoadingModel.langOf(s, App.instance.prefs.preferredAudio())
                BasicText(listOfNotNull(s.provider, lang).joinToString(" · "), style = TextStyle(color = Tok.textSecondary, fontSize = m.small),
                    maxLines = 1, modifier = Modifier.background(Color.Black.copy(alpha = 0.45f), Tok.pill).border(1.dp, Tok.border, Tok.pill).padding(horizontal = 12.dp, vertical = 5.dp))
            }
            // Cast to TV through Web Video Caster. Phone only: the TV layout has no use for it.
            if (!isTv && vm.current != null) {
                val ctx = LocalContext.current
                val castScope = rememberCoroutineScope()
                Spacer(Modifier.width(8.dp))
                CtlButton(Glyphs.cast, "Cast to TV", m) {
                    castScope.launch {
                        val spec = vm.castSpec() ?: return@launch
                        when (WvcCast.open(ctx, spec)) {
                            is WvcCast.Launch.Wvc -> spec.hint?.let { Toast.makeText(ctx, it, Toast.LENGTH_LONG).show() }
                            is WvcCast.Launch.Store -> Toast.makeText(ctx, "Install Web Video Caster to cast to your TV", Toast.LENGTH_LONG).show()
                            null -> Toast.makeText(ctx, "Could not open Web Video Caster", Toast.LENGTH_LONG).show()
                        }
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
                    CtlButton(Glyphs.server, "Server", m, modifier = anchor(Menu.Server), label = if (labels) "Server" else null) { onMenu(Menu.Server) }
                    CtlButton(Glyphs.audio, "Audio", m, modifier = anchor(Menu.Audio), label = if (labels) "Audio" else null) { onMenu(Menu.Audio) }
                    CtlButton(Glyphs.quality, "Quality", m, modifier = anchor(Menu.Quality), label = if (labels) "Quality" else null) { onMenu(Menu.Quality) }
                    CtlButton(Glyphs.subtitles, "Subtitles", m, modifier = anchor(Menu.Subtitles), label = if (labels) "Subtitles" else null) { onMenu(Menu.Subtitles) }
                    // Picture fit: one press cycles Fit, Fill, Stretch; the label names the current mode.
                    // Phone only (owner, 1.1.3): a TV is already full screen and the remote has no use for it.
                    if (!isTv) CtlButton(
                        when (fit) { VideoFit.Fit -> Glyphs.fitContain; VideoFit.Fill, VideoFit.FitWidth -> Glyphs.fitCover; VideoFit.Stretch -> Glyphs.fitFill },
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
fun PillButton(text: String, modifier: Modifier = Modifier, primary: Boolean = false, icon: ImageVector? = null, busy: Boolean = false, onClick: () -> Unit) {
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
        if (busy) CircularProgressIndicator(color = fg, strokeWidth = 2.dp, modifier = Modifier.size(16.dp).clearAndSetSemantics { })
        else if (icon != null) Icon(icon, contentDescription = null, tint = fg, modifier = Modifier.size(18.dp).padding(end = 2.dp))
        BasicText(text, style = TextStyle(color = fg, fontSize = 15.sp, fontWeight = FontWeight.Medium), modifier = Modifier.padding(start = if (icon != null || busy) 4.dp else 0.dp))
    }
}

@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun MenuPanel(menu: Menu, items: List<MenuItem>, isTv: Boolean, anchor: Rect? = null, titleOverride: String? = null, onUp: (() -> Unit)? = null, onClose: () -> Unit, onPick: (String) -> Unit) {
    val title = titleOverride ?: menu.title
    val icon = when (menu) { Menu.Server -> Glyphs.server; Menu.Audio -> Glyphs.audio; Menu.Quality -> Glyphs.quality; Menu.Subtitles -> Glyphs.subtitles }
    val first = remember(title) { FocusRequester() }
    val closeFocus = remember { FocusRequester() }
    val start = items.indexOfFirst { it.selected }.coerceAtLeast(0)
    val scroll = key(title) { rememberScrollState() }
    val scope = rememberCoroutineScope()
    var scrolledTo by remember(title) { mutableStateOf(false) }
    // TV only: on touch a focused row pulls the list back to it when late rows arrive (dead scroll).
    // No rows (empty level): focus the close button so focus never stays on the control behind the scrim.
    LaunchedEffect(title, items.isEmpty()) { if (isTv) { if (items.isEmpty()) closeFocus.focusWhenAttached() else first.focusWhenAttached() } }
    // TV: a pick keeps the sheet open; when the selection moves, focus the new
    // selected row, so it never falls to the controls behind the scrim.
    var picks by remember(title) { mutableIntStateOf(0) }
    val selectedKey = items.firstOrNull { it.selected }?.key
    LaunchedEffect(selectedKey) { if (isTv && picks > 0 && selectedKey != null) first.focusWhenAttached() }
    // Registered last, so the open sheet takes Back before the player does, whatever holds focus.
    BackHandler {
        android.util.Log.i("Chitram", "[back] menupanel up=${onUp != null}")
        (onUp ?: onClose)()
    }
    // Plain Box, not BoxWithConstraints: on device the subcomposed rows kept drawing the old level after a tap
    // or Back changed state (the BackHandler outside saw the new level), so taps and Back looked dead.
    val screen = LocalConfiguration.current
    val screenW = screen.screenWidthDp.toFloat().coerceAtLeast(1f)
    // Phone landscape and TV with a known button: a popover just above that button (YouTube/Netflix style).
    val anchored = menuAnchored(anchor != null, isTv, screenW, screen.screenHeightDp.toFloat())
    val tvMenu = if (anchored && isTv) tvAnchoredMenu(screenW, screen.screenHeightDp.toFloat().coerceAtLeast(1f)) else null
    Box(
        Modifier.fillMaxSize().background(Color.Black.copy(alpha = if (anchored) 0.2f else 0.4f))
            // The scrim closes on tap but never takes D-pad focus.
            .focusProperties { canFocus = false }
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onClose),
        contentAlignment = Alignment.Center,
    ) {
        val layout = playerMenuLayout(screenW, screen.screenHeightDp.toFloat().coerceAtLeast(1f), isTv)
        val shape = if (layout.bottomSheet) RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp) else if (isTv && !anchored) RoundedCornerShape(0.dp) else Tok.radiusLg
        Column(
            // Anchored (phone landscape, TV): just above its button. Otherwise TV keeps its right-edge panel.
            (if (anchored) Modifier.layout { measurable, c ->
                // Centre on the button, keep inside the screen, bottom edge 8dp above the button.
                val margin = (tvMenu?.margin ?: layout.inset).dp.roundToPx()
                val bottom = (anchor!!.top - 8.dp.toPx()).roundToInt()
                val p = measurable.measure(c.copy(minWidth = 0, minHeight = 0, maxHeight = minOf(c.maxHeight, (bottom - margin).coerceAtLeast(0))))
                val x = (anchor.center.x - p.width / 2f).roundToInt().coerceIn(margin, (c.maxWidth - p.width - margin).coerceAtLeast(margin))
                val y = (bottom - p.height).coerceAtLeast(margin)
                layout(c.maxWidth, c.maxHeight) { p.place(x, y) }
            } else Modifier.align(if (layout.bottomSheet) Alignment.BottomCenter else if (isTv) Alignment.CenterEnd else Alignment.Center)
                .padding(layout.inset.dp))
                // Phone side panel sizes to its widest row; TV and the portrait bottom sheet keep fixed widths.
                .then(if (tvMenu != null) Modifier.widthIn(min = tvMenu.minWidth.dp, max = tvMenu.maxWidth.dp).width(IntrinsicSize.Max)
                    else if (isTv || layout.bottomSheet) Modifier.width(layout.width.dp)
                    else Modifier.widthIn(min = 200.dp, max = minOf(360f, screenW - layout.inset * 2).dp).width(IntrinsicSize.Max))
                .heightIn(max = (tvMenu?.maxHeight ?: layout.height).dp)
                .clip(shape).background(Tok.surfaceSolid).border(1.dp, Tok.border, shape)
                .focusProperties { canFocus = false }
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { }
                // TV: D-pad focus stays inside the open sheet; the controls behind the scrim are unreachable.
                .then(if (isTv) Modifier.focusProperties { exit = { FocusRequester.Cancel } }.focusGroup() else Modifier)
                .windowInsetsPadding(WindowInsets.displayCutout.only(if (layout.bottomSheet) WindowInsetsSides.Bottom else WindowInsetsSides.End))
                .padding(top = if (isTv && !anchored) 24.dp else 0.dp),
        ) {
            if (layout.bottomSheet) Box(Modifier.fillMaxWidth().padding(top = 6.dp), contentAlignment = Alignment.Center) {
                Box(Modifier.width(36.dp).height(4.dp).clip(Tok.pill).background(Tok.fill3))
            }
            val headIcon = if (isTv) 20.dp else 16.dp
            Row(Modifier.fillMaxWidth().heightIn(min = if (isTv) 44.dp else 40.dp).padding(horizontal = if (isTv) 8.dp else 4.dp), verticalAlignment = Alignment.CenterVertically) {
                if (onUp != null) Box(Modifier.size(if (isTv) 44.dp else 40.dp).clickable(onClick = onUp).semantics { contentDescription = "Back to servers" }, contentAlignment = Alignment.Center) {
                    Icon(Glyphs.back, contentDescription = null, tint = Tok.text, modifier = Modifier.size(headIcon))
                }
                Icon(icon, contentDescription = null, tint = Tok.textSecondary, modifier = Modifier.padding(start = 4.dp).size(if (isTv) 18.dp else 16.dp))
                BasicText(title, style = TextStyle(color = Tok.text, fontSize = if (isTv) 20.sp else 14.sp, fontWeight = FontWeight.SemiBold), modifier = Modifier.weight(1f).padding(horizontal = if (isTv) 10.dp else 8.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
                val closeSource = remember { MutableInteractionSource() }
                val closeFocused by closeSource.collectIsFocusedAsState()
                Box(Modifier.size(if (isTv) 48.dp else 40.dp).focusRequester(closeFocus).controlFocus(closeFocused, Tok.radiusMd)
                    .clickable(interactionSource = closeSource, indication = null, onClick = onClose)
                    .semantics { contentDescription = "Close $title" }, contentAlignment = Alignment.Center) {
                    Icon(Glyphs.close, contentDescription = null, tint = if (closeFocused) Focus.ink else Tok.text, modifier = Modifier.size(headIcon))
                }
            }
            Box(Modifier.fillMaxWidth().height(1.dp).background(Tok.fill2))
            if (items.isEmpty()) BasicText("Nothing to choose here.", style = TextStyle(color = Tok.textMuted, fontSize = 14.sp), modifier = Modifier.padding(24.dp))
            // A plain scrolling Column: the phone panel's IntrinsicSize.Max width needs intrinsic measurement, which LazyColumn lacks.
            Column(Modifier.fillMaxWidth().weight(1f, fill = false).verticalScroll(scroll).padding(horizontal = if (isTv) 6.dp else 4.dp, vertical = if (isTv) 4.dp else 2.dp)) {
                items.forEachIndexed { i, item -> key(item.key) {
                    val src = remember { MutableInteractionSource() }
                    val focused by src.collectIsFocusedAsState()
                    // Audio rows sit under "In this stream" / "Other servers".
                    if (item.group.isNotEmpty() && (i == 0 || items[i - 1].group != item.group)) BasicText(item.group,
                        style = TextStyle(color = Tok.textMuted, fontSize = if (isTv) 13.sp else 11.sp, fontWeight = FontWeight.Medium),
                        modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = if (i == 0) 4.dp else if (isTv) 10.dp else 8.dp, bottom = 2.dp))
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = if (isTv) 2.dp else 0.dp)
                            .then(if (i == start) Modifier.focusRequester(first) else Modifier)
                            // Open with the selected row in view, once; later rows never pull the list back.
                            .then(if (i == start && start > 0) Modifier.onGloballyPositioned { c ->
                                if (!scrolledTo) { scrolledTo = true; val y = c.positionInParent().y.toInt(); scope.launch { scroll.scrollTo(y) } }
                            } else Modifier)
                            .controlFocus(focused, Tok.radiusMd, lift = false)
                            .clip(Tok.radiusMd)
                            .background(if (focused) Focus.fill else if (item.selected) Tok.fill2 else Color.Transparent)
                            // Press feedback on touch only; TV keeps the white focus fill.
                            .clickable(interactionSource = src, indication = if (isTv) null else ripple(color = Color.White)) { picks++; onPick(item.key) }
                            .semantics {
                                if (item.key == com.chitram.app.player.REFRESH_KEY) { contentDescription = "${item.label}. ${item.detail}"; role = Role.Button; liveRegion = LiveRegionMode.Polite }
                                else stateDescription = if (item.selected) "Selected" else "Not selected"
                            }
                            .heightIn(min = if (isTv) 56.dp else 40.dp)
                            .padding(horizontal = if (isTv) 12.dp else 10.dp, vertical = if (isTv) 10.dp else 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.size(if (isTv) 20.dp else 16.dp), contentAlignment = Alignment.Center) {
                            // "Refresh sources": a small spinner while it runs, the refresh glyph otherwise.
                            if (item.key == com.chitram.app.player.REFRESH_KEY) {
                                if (item.label == com.chitram.app.player.RefreshModel.Copy.RUNNING) CircularProgressIndicator(color = if (focused) Focus.ink else Tok.accent, strokeWidth = 2.dp, modifier = Modifier.size(if (isTv) 16.dp else 13.dp).clearAndSetSemantics { })
                                else Icon(Glyphs.restart, contentDescription = null, tint = if (focused) Focus.ink else Tok.text, modifier = Modifier.size(if (isTv) 18.dp else 14.dp))
                            } else if (item.selected) Icon(Glyphs.check, contentDescription = "Selected", tint = if (focused) Focus.ink else Tok.text, modifier = Modifier.size(if (isTv) 18.dp else 14.dp))
                        }
                        Spacer(Modifier.width(if (isTv) 12.dp else 8.dp))
                        Column(Modifier.weight(1f)) {
                            val labelColor = if (focused) Focus.ink else if (item.dim) Tok.textDim else Tok.text
                            val weight = if (item.selected) FontWeight.Medium else FontWeight.Normal
                            BasicText(item.label, style = if (isTv) TextStyle(color = labelColor, fontSize = 18.sp, fontWeight = weight)
                                else TextStyle(color = labelColor, fontSize = 14.sp, lineHeight = 17.sp, lineHeightStyle = TightLines, fontWeight = weight), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            val detailColor = if (focused) Focus.ink.copy(alpha = 0.7f) else Tok.textMuted
                            if (item.detail.isNotEmpty()) BasicText(item.detail, style = if (isTv) TextStyle(color = detailColor, fontSize = 14.sp)
                                else TextStyle(color = detailColor, fontSize = 12.sp, lineHeight = 14.sp, lineHeightStyle = TightLines), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                } }
            }
        }
    }
}
