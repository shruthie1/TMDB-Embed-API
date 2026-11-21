package com.chitram.app.ui.tv

import androidx.activity.compose.BackHandler
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.gestures.BringIntoViewSpec
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridScope
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.itemsIndexed as gridItemsIndexed
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Replay
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Translate
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.BiasAlignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.tv.material3.Border
import androidx.tv.material3.Button
import androidx.tv.material3.ButtonDefaults
import androidx.tv.material3.Card
import androidx.tv.material3.CardDefaults
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Glow
import androidx.tv.material3.LocalContentColor
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import androidx.tv.material3.darkColorScheme
import com.chitram.app.App
import com.chitram.app.data.BrowseFilters
import com.chitram.app.data.BrowseOptions
import com.chitram.app.data.Credit
import com.chitram.app.data.LanguagePrefs
import com.chitram.app.data.Progress
import com.chitram.app.data.Title
import com.chitram.app.ui.common.Art
import com.chitram.app.ui.common.BrowseVm
import com.chitram.app.ui.common.DetailVm
import com.chitram.app.ui.common.Focus
import com.chitram.app.ui.common.focusWhenAttached
import com.chitram.app.ui.common.Glyphs
import com.chitram.app.ui.common.HomeVm
import com.chitram.app.ui.common.Nav
import com.chitram.app.ui.common.PersonVm
import com.chitram.app.ui.common.PlayerScreen
import com.chitram.app.ui.common.Row as HomeRow
import com.chitram.app.ui.common.Screen
import com.chitram.app.ui.common.SearchFocus
import com.chitram.app.ui.common.SearchVm
import com.chitram.app.ui.common.Tok
import com.chitram.app.ui.common.langName
import com.chitram.app.ui.common.metaLine
import com.chitram.app.ui.common.runtimeText
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// ── Sizes: web TV CSS px -> dp/sp (see TvWeb in TvNav.kt for every source value).
private val Float.px: Dp get() = (this * TvWeb.CSS_PX_DP).dp
private val Float.pxSp: TextUnit get() = (this * TvWeb.CSS_PX_DP).sp

private val RAIL_W = TvWeb.RAIL_W.px
private val RAIL_OPEN_W = TvWeb.RAIL_OPEN_W.px
/** Page side margin next to the rail (web --tv-gap). */
private val GUTTER = TvWeb.GUTTER.px
private val CARD_W = TvWeb.CARD_W.px
private val POSTER_H = TvWeb.POSTER_H.px
private val CARD_GAP = TvWeb.CARD_GAP.px
private val FOCUS_PAD = TvWeb.FOCUS_PAD.px
private val RADIUS = androidx.compose.foundation.shape.RoundedCornerShape(TvWeb.RADIUS.px)

// ── Focus: pictures get a white frame, shadow and lift; controls invert to white.
private val CardEase: Easing = CubicBezierEasing(.2f, .8f, .2f, 1f)
private val ControlEase: Easing = CubicBezierEasing(.16f, 1f, .3f, 1f)
private val cardRing = Border(BorderStroke(TvWeb.RING.px, Focus.ring), inset = TvWeb.RING_OFFSET.px, shape = RADIUS)
private val cardGlow = Glow(elevationColor = Color.Black.copy(alpha = 0.75f), elevation = TvWeb.LIFT_SHADOW.px)
private val controlGlow = Glow(elevationColor = Color.Black.copy(alpha = 0.55f), elevation = TvWeb.GLOW.px)

/**
 * Web focus motion: scale from the centre with the web's duration and easing.
 * Cards: 1.07, 200ms, cubic-bezier(.2,.8,.2,1). Controls: 1.09 and 2px up,
 * 180ms, cubic-bezier(.16,1,.3,1). The focused item draws above its neighbours.
 */
@Composable
private fun Modifier.lift(focused: Boolean, scale: Float, ms: Int, easing: Easing, rise: Dp = 0.dp): Modifier {
    val f by animateFloatAsState(if (focused) 1f else 0f, tween(ms, easing = easing), label = "lift")
    return this.zIndex(if (focused) 1f else 0f).graphicsLayer {
        val s = 1f + (scale - 1f) * f
        scaleX = s; scaleY = s
        translationY = -rise.toPx() * f
    }
}

@Composable
private fun Modifier.cardLift(focused: Boolean) = lift(focused, TvWeb.CARD_SCALE, TvWeb.CARD_MS, CardEase)

@Composable
private fun Modifier.controlLift(focused: Boolean) = lift(focused, TvWeb.CONTROL_SCALE, TvWeb.CONTROL_MS, ControlEase, TvWeb.CONTROL_RISE.px)

/** Give a lazy row's focus padding back to the layout (web .rail padding + negative margin). */
private fun Modifier.bleedVertical(pad: Dp) = layout { m, c ->
    val p = pad.roundToPx()
    val placeable = m.measure(c.copy(maxHeight = if (c.hasBoundedHeight) c.maxHeight + 2 * p else Constraints.Infinity))
    layout(placeable.width, (placeable.height - 2 * p).coerceAtLeast(0)) { placeable.place(0, -p) }
}

@Composable
@OptIn(ExperimentalComposeUiApi::class)
fun TvApp(nav: Nav) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Color.White, onPrimary = Tok.bg, background = Tok.bg, onBackground = Tok.text,
            surface = Tok.surface, onSurface = Tok.text, onSurfaceVariant = Tok.textMuted, border = Focus.ring,
        ),
    ) {
        // Where focus was on Home, so Back lands on the same card.
        val restore = remember { mutableStateOf<String?>(null) }
        val homeList = rememberLazyListState()
        BackHandler(enabled = nav.stack.size > 1) { nav.pop() }
        Box(Modifier.fillMaxSize().background(Tok.bg)) {
            val s = nav.top
            // Web AppNav is on every page; only the full-screen player and the
            // first-run language picker are drawn without it.
            val rail = s !is Screen.Player && !(s is Screen.Langs && s.firstRun)
            // Initial focus belongs to the page, never the rail. The rail is
            // composed from frame 0 while a page's controls arrive later (lazy
            // items, network), so any focus search in that gap (a key press, a
            // window-focus change) landed on the rail's first item, Search
            // (Fire TV, intermittent on Home). The rail stays unfocusable on each
            // screen entry until the page has held focus (Left then reaches it
            // as before) or the page gave up claiming it (an empty page).
            val content = remember { FocusRequester() }
            var contentHas by remember { mutableStateOf(false) }
            var railArmed by remember(s) { mutableStateOf(false) }
            LaunchedEffect(s) {
                if (!rail) return@LaunchedEffect
                // The page claims its own main control first (Home: Watch now,
                // Detail: Play, Search: the field). Home waits on the network.
                delay(if (s == Screen.Home) 4000 else 500)
                // Nothing claimed: the page's first control, retried until it lands.
                if (!contentHas) content.focusWhenAttached(landed = { contentHas })
                railArmed = true
            }
            CompositionLocalProvider(
                LocalLastFocus provides remember { mutableStateOf<FocusRequester?>(null) },
                LocalRailEntry provides remember { mutableStateOf<FocusRequester?>(null) },
            ) {
                Box(
                    Modifier.fillMaxSize().padding(start = if (rail) RAIL_W else 0.dp)
                        .focusRequester(content)
                        .onFocusChanged { contentHas = it.hasFocus; if (it.hasFocus) railArmed = true }
                        .focusGroup(),
                ) {
                    when (s) {
                        Screen.Home -> TvHome(nav, restore, homeList)
                        Screen.Search -> TvSearch(nav)
                        Screen.MyList -> TvGrid(nav, "My list", App.instance.myList.all(), empty = "Titles you add show up here.")
                        is Screen.Langs -> TvLangs(s.firstRun) { if (s.firstRun) nav.replaceAll(Screen.Home) else nav.pop() }
                        is Screen.Detail -> TvDetail(nav, s.type, s.id)
                        is Screen.Person -> TvPerson(nav, s.id, s.name)
                        is Screen.Browse -> TvBrowse(nav, s.initial)
                        is Screen.Player -> PlayerScreen(s.req, isTv = true, onBack = { nav.pop() })
                    }
                }
                if (rail) TvRail(nav, s, railArmed)
            }
        }
    }
}

// ── Home ────────────────────────────────────────────────────────────────────

private const val HERO = "hero"

/**
 * Where every D-pad stop on Home sits, so Up/Down can pick the card directly
 * below the focused one (web dpad.js cardBelow) instead of a remembered column.
 */
private class NavGeo {
    private val reqs = HashMap<String, FocusRequester>()
    private val rects = HashMap<String, Rect>()
    private val rows = HashMap<String, HashSet<String>>()
    var at: String? = null

    fun requester(kind: String, key: String) = reqs.getOrPut("$kind|$key") { FocusRequester() }
    fun place(kind: String, key: String, r: Rect, target: Boolean) {
        rects["$kind|$key"] = r
        if (target) rows.getOrPut(kind) { HashSet() } += key
    }
    fun forget(kind: String, key: String) {
        rects.remove("$kind|$key"); reqs.remove("$kind|$key"); rows[kind]?.remove(key)
    }

    /** The on-screen stop in row [kind] under the focused one; null when none is laid out yet. */
    fun below(kind: String, viewLeft: Float, viewRight: Float): FocusRequester? {
        val src = at?.let { rects[it] } ?: return null
        val cands = rows[kind].orEmpty().mapNotNull { k ->
            rects["$kind|$k"]?.takeIf { it.right > viewLeft && it.left < viewRight }?.let { k to (it.left to it.right) }
        }
        return pickBelow(src.left, src.right, cands)?.let { reqs["$kind|$it"] }
    }
}

@Composable
private fun Modifier.navSlot(geo: NavGeo, kind: String, key: String, target: Boolean = true): Modifier {
    val fr = remember(kind, key) { geo.requester(kind, key) }
    DisposableEffect(kind, key) { onDispose { geo.forget(kind, key) } }
    return this.focusRequester(fr)
        .onGloballyPositioned { geo.place(kind, key, it.boundsInRoot(), target) }
        .onFocusChanged { if (it.isFocused) geo.at = "$kind|$key" }
}

@Composable
@OptIn(ExperimentalFoundationApi::class)
private fun TvHome(nav: Nav, restore: MutableState<String?>, listState: LazyListState) {
    val vm: HomeVm = viewModel()
    LaunchedEffect(Unit) { vm.load() }
    val geo = remember { NavGeo() }
    val scope = rememberCoroutineScope()
    val pool = vm.heroTitles?.filter { it.backdrop != null }?.take(TvWeb.HERO_COUNT)
    val hasHero = !pool.isNullOrEmpty()
    var heroAt by remember { mutableIntStateOf(0) }
    val visible = vm.rows.filter { it.shown }
    val rowFocus = remember { HashMap<String, FocusRequester>() }
    val firstLoaded = visible.firstOrNull { !it.loading && it.titles.isNotEmpty() }
    // First visit: like web dpad.js, start on the page's main action (Watch
    // now) when the hero is up, else the first card of the first loaded row.
    LaunchedEffect(vm.heroTitles, firstLoaded?.kind) {
        if (restore.value != null || vm.heroTitles == null) return@LaunchedEffect
        if (hasHero) restore.value = "$HERO|watch"
        else firstLoaded?.let { restore.value = "${it.kind}|${it.titles.first().key}" }
    }

    // D-pad slots top to bottom: the hero's buttons, then each row.
    val slots = (if (hasHero) listOf(HERO) else emptyList()) + visible.map { it.kind }
    val focusable = (if (hasHero) listOf(true) else emptyList()) + visible.map { !it.loading }
    val density = LocalDensity.current
    val screenW = with(density) { LocalConfiguration.current.screenWidthDp.dp.toPx() }
    val railPx = with(density) { RAIL_W.toPx() }
    fun goTo(j: Int) {
        val kind = slots[j]
        val item = if (kind == HERO) 0 else 1 + visible.indexOfFirst { it.kind == kind }
        scope.launch {
            if (listState.layoutInfo.visibleItemsInfo.none { it.index == item }) { listState.scrollToItem(item); withFrameNanos { } }
            val fr = geo.below(kind, railPx, screenW) ?: rowFocus[kind]
            runCatching { fr?.requestFocus() }
        }
    }
    /** Up/Down from slot [kind]: always consumed, so focus never falls into the rail or off the page. */
    fun move(kind: String, dir: Int): Boolean {
        nextSlot(slots.indexOf(kind), dir, focusable)?.let { goTo(it) }
        return true
    }
    fun enter(kind: String) { slots.indexOf(kind).takeIf { it >= 0 }?.let { goTo(it) } }

    Box(Modifier.fillMaxSize()) {
        // Hero art runs under the rail (web .page-backdrop left: -rail-w) and
        // scrolls away with the hero, which lives in the list below.
        if (hasHero) {
            val heroH = TvWeb.HERO_H.px
            Box(
                Modifier.layout { m, c ->
                    val extra = RAIL_W.roundToPx()
                    val h = heroH.roundToPx()
                    val p = m.measure(Constraints.fixed(c.maxWidth + extra, h))
                    layout(c.maxWidth, h) {
                        val first = listState.firstVisibleItemIndex
                        if (first == 0) p.place(-extra, -listState.firstVisibleItemScrollOffset)
                    }
                },
            ) {
                // Web .home-hero-art fades in over .7s per slide.
                Crossfade(pool!![heroAt % pool.size], animationSpec = tween(700, easing = ControlEase), label = "hero") { t ->
                    Box(Modifier.fillMaxSize()) {
                        Art(t.backdrop, "w1280", Modifier.fillMaxSize(), alignment = BiasAlignment(0f, -0.64f))
                        // One bottom-weighted scrim (web .home-hero-art::after).
                        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(
                            0f to Color.Transparent, 0.22f to Color.Transparent, 0.45f to Tok.bg.copy(alpha = 0.12f),
                            0.70f to Tok.bg.copy(alpha = 0.5f), 0.88f to Tok.bg.copy(alpha = 0.9f), 1f to Tok.bg,
                        )))
                        // Left wash so the copy reads over bright art.
                        Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(
                            0f to Tok.bg.copy(alpha = 0.55f), 0.45f to Tok.bg.copy(alpha = 0.18f), 0.7f to Color.Transparent,
                        )))
                    }
                }
            }
        }
        val rowScroll = CenterScroll
        CompositionLocalProvider(LocalBringIntoViewSpec provides MinimalScroll) {
            LazyColumn(state = listState, contentPadding = PaddingValues(bottom = 48.dp), verticalArrangement = Arrangement.spacedBy(TvWeb.ROW_GAP.px)) {
                item(key = HERO) {
                    if (vm.heroTitles == null) HeroSkeleton()
                    else if (hasHero) TvHero(pool!!, heroAt, onIndex = { heroAt = it }, nav, restore, geo, onDown = { move(HERO, 1) })
                    else Brand(Modifier.padding(start = GUTTER, top = 9.dp, bottom = 9.dp))
                }
                itemsIndexed(visible, key = { _, r -> r.kind }) { _, row ->
                    val fr = rowFocus.getOrPut(row.kind) { FocusRequester() }
                    // Rows centre the focused card (web scrollIntoView inline:'center').
                    CompositionLocalProvider(LocalBringIntoViewSpec provides rowScroll) {
                        TvRow(row, nav, restore, geo, fr, onMove = { d -> move(row.kind, d) }, onEnter = { enter(row.kind) }, onRetry = { vm.retry(row.kind) })
                    }
                }
            }
        }
    }
}

@Composable
private fun Brand(modifier: Modifier = Modifier) {
    Text("Chitram", style = TextStyle(color = Tok.text, fontSize = TvWeb.BRAND.pxSp, fontWeight = FontWeight.Bold), modifier = modifier)
}

@Composable
private fun HeroSkeleton() {
    Box(Modifier.fillMaxWidth().height(TvWeb.HERO_H.px).padding(start = GUTTER, bottom = TvWeb.HERO_PAD_BOTTOM.px), contentAlignment = Alignment.BottomStart) {
        Column(Modifier.widthIn(max = TvWeb.HERO_MAX_W.px), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.fillMaxWidth(0.62f).height(TvWeb.HERO_TITLE.px).background(Tok.surfaceSolid, RADIUS))
            Box(Modifier.width(80.dp).height(10.dp).background(Tok.surfaceSolid, RADIUS))
            Box(Modifier.fillMaxWidth(0.92f).height(11.dp).background(Tok.surfaceSolid, RADIUS))
            Row(horizontalArrangement = Arrangement.spacedBy(TvWeb.ACTION_GAP.px)) {
                Box(Modifier.width(95.dp).height(TvWeb.BTN_H.px).background(Tok.surfaceSolid, Tok.pill))
                Box(Modifier.width(80.dp).height(TvWeb.BTN_H.px).background(Tok.surfaceSolid, Tok.pill))
            }
        }
    }
}

/**
 * Web Hero.jsx on TV: a six-title spotlight that auto-advances every 8s and
 * pauses while it holds focus. Watch now opens the title; My List toggles.
 * Right from the last button shows the next title; Left leaves for the rail.
 */
@Composable
@OptIn(ExperimentalComposeUiApi::class)
private fun TvHero(pool: List<Title>, at: Int, onIndex: (Int) -> Unit, nav: Nav, restore: MutableState<String?>, geo: NavGeo, onDown: () -> Boolean) {
    val i = at % pool.size
    val t = pool[i]
    var paused by remember { mutableStateOf(false) }
    val fill = remember { Animatable(0f) }
    LaunchedEffect(i, paused, pool.size) {
        if (pool.size < 2) return@LaunchedEffect
        if (paused) { fill.snapTo(1f); return@LaunchedEffect }
        fill.snapTo(0f)
        fill.animateTo(1f, tween(TvWeb.HERO_ROTATE_MS.toInt(), easing = LinearEasing))
        onIndex((i + 1) % pool.size)
    }
    val myList = App.instance.myList
    var saved by remember(t.key) { mutableStateOf(myList.contains(t)) }
    val density = LocalDensity.current
    var actionsH by remember { mutableStateOf(0.dp) }
    Box(Modifier.fillMaxWidth().height(TvWeb.HERO_H.px).onFocusChanged { paused = it.hasFocus }) {
        Brand(Modifier.padding(start = GUTTER, top = 9.dp))
        Crossfade(t, animationSpec = tween(400, easing = ControlEase), label = "hero-copy", modifier = Modifier.align(Alignment.BottomStart)) { shown ->
            // The copy ends above the button row: its measured height (at least
            // the web .btn min-height) plus the web .actions margin-top. A fixed
            // guess left the overview drawn through the buttons (Fire TV, 1.2.17).
            Column(
                Modifier.padding(start = GUTTER, end = GUTTER, top = TvWeb.HERO_PAD_TOP.px,
                    bottom = TvWeb.HERO_PAD_BOTTOM.px + actionsH.coerceAtLeast(TvWeb.BTN_H.px) + TvWeb.HERO_ACTIONS_TOP.px)
                    .widthIn(max = TvWeb.HERO_MAX_W.px),
            ) {
                Text(shown.title, style = TextStyle(color = Tok.text, fontSize = TvWeb.HERO_TITLE.pxSp, lineHeight = TvWeb.HERO_TITLE.pxSp, fontWeight = FontWeight.Light),
                    maxLines = 2, overflow = TextOverflow.Ellipsis)
                MetaLine(shown.year, shown.rating, null, shown.originalLang, TvWeb.HERO_META, Modifier.padding(top = 7.dp))
                shown.overview?.takeIf { it.isNotBlank() }?.let {
                    Text(it, style = TextStyle(color = Tok.textSecondary, fontSize = TvWeb.HERO_OVERVIEW.pxSp, lineHeight = (TvWeb.HERO_OVERVIEW * 1.45f).pxSp),
                        maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 7.dp))
                }
            }
        }
        // Buttons outside the crossfade so focus is never torn down by a slide change.
        Row(
            Modifier.align(Alignment.BottomStart).padding(start = GUTTER, bottom = TvWeb.HERO_PAD_BOTTOM.px)
                .onSizeChanged { actionsH = with(density) { it.height.toDp() } }
                .onPreviewKeyEvent { e ->
                    if (e.type != KeyEventType.KeyDown) false
                    else when (e.key) {
                        Key.DirectionDown -> onDown()
                        Key.DirectionUp -> true // top of the page
                        else -> false
                    }
                },
            horizontalArrangement = Arrangement.spacedBy(TvWeb.ACTION_GAP.px),
        ) {
            val watch = remember { geo.requester(HERO, "watch") }
            // The hero is a lazy item: one requestFocus() a frame after composing
            // could throw (not attached yet, swallowed) and nothing retried, so the
            // next focus search took the rail. Retry each frame until Watch now holds it.
            if (restore.value == "$HERO|watch") LaunchedEffect(Unit) { watch.focusWhenAttached(landed = { geo.at == "$HERO|watch" }) }
            TvButton("Watch now", primary = true, modifier = Modifier.navSlot(geo, HERO, "watch"), icon = Icons.Filled.PlayArrow) {
                restore.value = "$HERO|watch"
                nav.push(Screen.Detail(t.mediaType, t.tmdbId))
            }
            TvButton(if (saved) "In My List" else "+ My List", primary = false,
                modifier = Modifier.navSlot(geo, HERO, "list").onPreviewKeyEvent { e ->
                    if (e.type == KeyEventType.KeyDown && e.key == Key.DirectionRight && pool.size > 1) { onIndex((i + 1) % pool.size); true } else false
                },
                icon = if (saved) Icons.Filled.Check else null) { saved = myList.toggle(t) }
        }
        // Carousel indicator: centred bars, the active one fills over one interval.
        if (pool.size > 1) Row(
            Modifier.align(Alignment.BottomCenter).padding(bottom = 12.dp).width(100.dp),
            horizontalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            pool.indices.forEach { k ->
                Box(Modifier.weight(1f).height(1.5.dp).clip(Tok.pill).background(Tok.fill3)) {
                    if (k == i) Box(Modifier.fillMaxHeight().fillMaxWidth(fill.value).background(Tok.text))
                }
            }
        }
    }
}

@Composable
private fun MetaLine(year: Int?, rating: Double?, extra: String?, lang: String?, cssPx: Float, modifier: Modifier = Modifier) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(metaLine(year, rating, extra), color = Tok.textSecondary, fontSize = cssPx.pxSp)
        langName(lang)?.let { LangBadge(it) }
    }
}

/** Web Badge on TV: 16px, padding 2px 8px, hairline border. */
@Composable
private fun LangBadge(text: String) {
    Text(text, color = Tok.text, fontSize = 16f.pxSp, fontWeight = FontWeight.Medium,
        modifier = Modifier.border(0.5.dp, Tok.fill3, androidx.compose.foundation.shape.RoundedCornerShape(3.dp)).padding(horizontal = 4.dp, vertical = 1.dp))
}

@Composable
@OptIn(ExperimentalComposeUiApi::class)
private fun TvRow(
    row: HomeRow, nav: Nav, restore: MutableState<String?>, geo: NavGeo, rowFocus: FocusRequester,
    onMove: (Int) -> Boolean, onEnter: () -> Unit, onRetry: () -> Unit,
) {
    val railEntry = LocalRailEntry.current
    Column {
        // Row head: label left, "See all" right (web .row-head).
        val all = row.seeAll
        val hasMore = all != null || row.kind == "list"
        val seeAll = remember { FocusRequester() }
        Row(Modifier.fillMaxWidth().padding(start = GUTTER, end = GUTTER, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(row.label, style = TextStyle(color = Tok.textSecondary, fontSize = TvWeb.ROW_LABEL.pxSp, fontWeight = FontWeight.Medium),
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(bottom = TvWeb.ROW_LABEL_BOTTOM.px))
            if (hasMore && !row.loading && row.titles.isNotEmpty()) {
                if (restore.value == "${row.kind}|see-all") LaunchedEffect(Unit) { seeAll.focusWhenAttached() }
                TvLink("See all", TvWeb.SEE_ALL,
                    Modifier.focusRequester(seeAll).navSlot(geo, "see-all", row.kind, target = false).onPreviewKeyEvent { e ->
                        if (e.type != KeyEventType.KeyDown) false
                        else when (e.key) {
                            // Web: Down reaches this row's card under the link; Up the row above.
                            Key.DirectionDown -> { onEnter(); true }
                            Key.DirectionUp -> onMove(-1)
                            // Nothing focusable left of it on its line: open the rail.
                            Key.DirectionLeft -> { railEntry.value?.let { runCatching { it.requestFocus() } }; true }
                            Key.DirectionRight -> true
                            else -> false
                        }
                    }) {
                    restore.value = "${row.kind}|see-all"
                    nav.push(if (all != null) Screen.Browse(all) else Screen.MyList)
                }
            }
        }
        LazyRow(
            modifier = Modifier
                .bleedVertical(FOCUS_PAD)
                .focusRequester(rowFocus)
                .focusRestorer()
                .onPreviewKeyEvent { e ->
                    if (e.type != KeyEventType.KeyDown) false
                    else when (e.key) {
                        Key.DirectionUp -> onMove(-1)
                        Key.DirectionDown -> onMove(1)
                        else -> false
                    }
                },
            // Room above and below for the focus lift and frame.
            contentPadding = PaddingValues(start = GUTTER, end = GUTTER, top = FOCUS_PAD, bottom = FOCUS_PAD),
            horizontalArrangement = Arrangement.spacedBy(CARD_GAP),
        ) {
            if (row.error) {
                item(key = "error") {
                    Row(Modifier.height(POSTER_H), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Couldn’t load this section.", color = Tok.textMuted, fontSize = 16f.pxSp)
                        TvChip("Retry", modifier = Modifier.navSlot(geo, row.kind, "retry"), onClick = onRetry)
                    }
                }
            } else if (row.loading) {
                items(10) { CardSkeleton() }
            } else {
                itemsIndexed(row.titles, key = { _, t -> t.key }) { i, t ->
                    val rk = "${row.kind}|${t.key}"
                    val fr = remember(rk) { geo.requester(row.kind, t.key) }
                    if (restore.value == rk) LaunchedEffect(rk) { fr.focusWhenAttached() }
                    val last = i == row.titles.lastIndex
                    val mod = Modifier.navSlot(geo, row.kind, t.key).onPreviewKeyEvent { e ->
                        // Right from the last card reaches the row's "See all".
                        if (last && hasMore && e.type == KeyEventType.KeyDown && e.key == Key.DirectionRight) { runCatching { seeAll.requestFocus() }; true } else false
                    }
                    PosterCard(t, mod, rank = if (row.ranked) i + 1 else null, progress = row.progress[t.key]) {
                        restore.value = rk
                        nav.push(Screen.Detail(t.mediaType, t.tmdbId))
                    }
                }
            }
        }
    }
}

@Composable
private fun CardSkeleton() {
    Column(Modifier.width(CARD_W)) {
        Box(Modifier.size(CARD_W, POSTER_H).background(Tok.surfaceSolid, RADIUS))
        Box(Modifier.padding(top = TvWeb.CARD_TITLE_TOP.px).fillMaxWidth(0.84f).height(TvWeb.CARD_TITLE.px).background(Tok.surfaceSolid, RADIUS))
        Box(Modifier.padding(top = 2f.px).fillMaxWidth(0.4f).height(TvWeb.CARD_META.px).background(Tok.surfaceSolid, RADIUS))
    }
}

/**
 * Web Card on TV: 2/3 poster, then one title line and one meta line (both
 * always reserved, so cards in a row line up), then the progress bar when
 * there is one. Focus scales the whole card 1.07 with the white frame.
 */
@Composable
fun PosterCard(t: Title, modifier: Modifier = Modifier, rank: Int? = null, showType: Boolean = false, progress: Progress? = null, onClick: () -> Unit) {
    val src = remember { MutableInteractionSource() }
    val focused by src.collectIsFocusedAsState()
    Column(Modifier.width(CARD_W).cardLift(focused)) {
        Card(
            onClick = onClick,
            modifier = modifier.returnTarget().size(CARD_W, POSTER_H),
            shape = CardDefaults.shape(RADIUS),
            scale = CardDefaults.scale(focusedScale = 1f),
            border = CardDefaults.border(border = Border(BorderStroke(0.5.dp, Tok.border), shape = RADIUS), focusedBorder = cardRing),
            glow = CardDefaults.glow(focusedGlow = cardGlow),
            colors = CardDefaults.colors(containerColor = Tok.surfaceSolid),
            interactionSource = src,
        ) {
            Box(Modifier.fillMaxSize()) {
                Art(t.poster, "w342", Modifier.fillMaxSize(), t.title)
                if (t.poster == null) Text(t.title, color = Tok.textSecondary, fontSize = TvWeb.CARD_TITLE.pxSp, modifier = Modifier.padding(6.dp))
                if (showType && t.mediaType == "tv") Text("Series", color = Tok.text, fontSize = 16f.pxSp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.align(Alignment.TopStart).padding(4.dp).background(Tok.bg.copy(alpha = 0.75f), RADIUS).padding(horizontal = 4.dp, vertical = 1.dp))
                if (rank != null) Text("$rank", style = TextStyle(color = Color.White, fontSize = TvWeb.CARD_RANK.pxSp, lineHeight = TvWeb.CARD_RANK.pxSp, fontWeight = FontWeight.Bold),
                    modifier = Modifier.align(Alignment.BottomStart).padding(start = 6f.px, bottom = 2f.px))
            }
        }
        Text(t.title, color = if (focused) Tok.text else Tok.textSecondary, fontSize = TvWeb.CARD_TITLE.pxSp, lineHeight = (TvWeb.CARD_TITLE * 1.25f).pxSp,
            fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = TvWeb.CARD_TITLE_TOP.px))
        val ep = progress?.takeIf { it.mediaType == "tv" && it.episode > 0 }
        val meta = if (ep != null) "S${ep.season}E${ep.episode}" + (ep.epTitle?.let { " · $it" } ?: "") else t.year?.toString().orEmpty()
        Text(meta, color = Tok.textMuted, fontSize = TvWeb.CARD_META.pxSp, lineHeight = (TvWeb.CARD_META * 1.35f).pxSp, minLines = 1, maxLines = 1,
            overflow = TextOverflow.Ellipsis, fontWeight = if (ep != null) FontWeight.SemiBold else FontWeight.Normal, modifier = Modifier.padding(top = 2f.px))
        val pct = progress?.let { if (it.finished) 1f else it.pct } ?: 0f
        if (pct > 0f) Box(Modifier.padding(top = TvWeb.CARD_PROG_TOP.px).fillMaxWidth().height(TvWeb.CARD_PROG.px).clip(Tok.pill).background(Tok.fill3)) {
            Box(Modifier.fillMaxHeight().fillMaxWidth(pct).background(Tok.accent))
        }
    }
}

/** A text control (web .see-all, .detail-overview-toggle): inverts to white on focus. */
@Composable
private fun TvLink(text: String, cssPx: Float, modifier: Modifier = Modifier, icon: ImageVector? = null, onClick: () -> Unit) {
    val src = remember { MutableInteractionSource() }
    val focused by src.collectIsFocusedAsState()
    Surface(
        onClick = onClick,
        modifier = modifier.returnTarget().controlLift(focused).heightIn(min = TvWeb.CHIP_H.px),
        shape = ClickableSurfaceDefaults.shape(Tok.pill),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1f),
        colors = ClickableSurfaceDefaults.colors(containerColor = Color.Transparent, contentColor = Tok.textMuted, focusedContainerColor = Focus.fill, focusedContentColor = Focus.ink),
        glow = ClickableSurfaceDefaults.glow(focusedGlow = controlGlow),
        interactionSource = src,
    ) {
        Row(Modifier.heightIn(min = TvWeb.CHIP_H.px).padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            if (icon != null) Icon(icon, null, Modifier.padding(end = 3.dp).size(cssPx.px), tint = LocalContentColor.current)
            Text(text, fontSize = cssPx.pxSp, fontWeight = FontWeight.Medium)
        }
    }
}

@Composable
private fun TvChip(text: String, selected: Boolean = false, modifier: Modifier = Modifier, icon: ImageVector? = null, onClick: () -> Unit) {
    val src = remember { MutableInteractionSource() }
    val focused by src.collectIsFocusedAsState()
    Surface(
        onClick = onClick,
        modifier = modifier.returnTarget().controlLift(focused),
        shape = ClickableSurfaceDefaults.shape(Tok.pill),
        // Focus inverts to white with dark ink; selected stays quiet so the
        // two never look alike.
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1f),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = if (selected) Focus.selectedFill else Tok.fill2,
            contentColor = Tok.text,
            focusedContainerColor = Focus.fill,
            focusedContentColor = Focus.ink,
        ),
        border = ClickableSurfaceDefaults.border(
            border = if (selected) Border(BorderStroke(0.75.dp, Color.White.copy(alpha = 0.55f)), shape = Tok.pill) else Border.None,
            focusedBorder = Border.None,
        ),
        glow = ClickableSurfaceDefaults.glow(focusedGlow = controlGlow),
        interactionSource = src,
    ) {
        Row(Modifier.heightIn(min = TvWeb.CHIP_H.px).padding(horizontal = 18f.px, vertical = 10f.px), verticalAlignment = Alignment.CenterVertically) {
            if (icon != null) Icon(icon, null, Modifier.padding(end = 4.dp).size(TvWeb.CHIP_FONT.px), tint = LocalContentColor.current)
            Text(text, fontSize = TvWeb.CHIP_FONT.pxSp, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium)
        }
    }
}

@Composable
private fun TvButton(text: String, primary: Boolean, modifier: Modifier = Modifier, icon: ImageVector? = null, onClick: () -> Unit) {
    val src = remember { MutableInteractionSource() }
    val focused by src.collectIsFocusedAsState()
    Button(
        onClick = onClick,
        modifier = modifier.returnTarget().controlLift(focused).heightIn(min = TvWeb.BTN_H.px),
        // Focus: white fill, dark ink, lift and shadow. Only focus is white.
        scale = ButtonDefaults.scale(focusedScale = 1f),
        colors = ButtonDefaults.colors(
            containerColor = if (primary) Focus.primaryButton else Tok.fill2,
            contentColor = if (primary) Focus.ink else Tok.text,
            focusedContainerColor = Focus.fill,
            focusedContentColor = Focus.ink,
        ),
        // Web .btn.primary:focus keeps its white fill and adds the ring, 3px out.
        border = if (primary) ButtonDefaults.border(focusedBorder = Border(BorderStroke(TvWeb.RING.px, Focus.ring), inset = TvWeb.RING_OFFSET.px, shape = Tok.pill)) else ButtonDefaults.border(),
        glow = ButtonDefaults.glow(focusedGlow = controlGlow),
        contentPadding = PaddingValues(horizontal = TvWeb.BTN_PAD_X.px),
        interactionSource = src,
    ) {
        if (icon != null) Icon(icon, null, Modifier.padding(end = 4.dp).size(TvWeb.BTN_FONT.px), tint = LocalContentColor.current)
        Text(text, fontSize = TvWeb.BTN_FONT.pxSp, fontWeight = FontWeight.SemiBold)
    }
}

// ── Detail ──────────────────────────────────────────────────────────────────

@Composable
@OptIn(ExperimentalFoundationApi::class, ExperimentalLayoutApi::class)
private fun TvDetail(nav: Nav, type: String, id: Long) {
    val vm: DetailVm = viewModel(key = "detail-$type-$id")
    LaunchedEffect(type, id) { vm.load(type, id) }
    val t = vm.full
    val playFocus = remember { FocusRequester() }
    Box(Modifier.fillMaxSize()) {
        // The art sits lower than the screen edge (owner, 2026-11-20, same as the
        // web detail hero: about 14% of the hero), and a top fade runs from the page
        // colour at its edge through 70% to clear, so the edge never shows.
        val artTop = 96.dp
        Art(t?.backdrop, "w1280", Modifier.align(Alignment.TopEnd).padding(top = artTop).fillMaxWidth(0.72f).fillMaxHeight(0.8f), alignment = Alignment.TopCenter)
        Box(Modifier.padding(top = artTop).fillMaxWidth().fillMaxHeight(0.3f).background(Brush.verticalGradient(0f to Tok.bg, 0.2f to Tok.bg.copy(alpha = 0.7f), 1f to Color.Transparent)))
        Box(Modifier.fillMaxSize().background(Tok.scrimLeft))
        Box(Modifier.fillMaxSize().background(Tok.scrimBottom))
        if (t == null) {
            Column(Modifier.padding(start = GUTTER, top = TvWeb.DETAIL_TOP.px)) {
                BackPill { nav.pop() }
                Text(vm.error ?: "Loading", color = Tok.textMuted, fontSize = TvWeb.DETAIL_META.pxSp, modifier = Modifier.padding(top = 16.dp))
            }
            return@Box
        }
        val detailList = rememberLazyListState()
        val scope = rememberCoroutineScope()
        // Focus Play, then pin the list to the top: focusing scrolls Play into
        // view and would otherwise clip the title.
        // Play lives in a lazy item, composed during the first measure pass, after
        // this effect starts: a bare requestFocus() threw (swallowed), nothing held
        // focus and the next D-pad press fell to the rail's first item (Search).
        LaunchedEffect(t.tmdbId) { playFocus.focusWhenAttached(); detailList.scrollToItem(0) }
        // Compose's TV default pivots the focused item to 30% of the height,
        // which pushed the title off the top. Scroll only as far as needed and
        // return to the very top when Play takes focus.
        CompositionLocalProvider(LocalBringIntoViewSpec provides MinimalScroll) {
            LazyColumn(state = detailList, contentPadding = PaddingValues(top = TvWeb.DETAIL_TOP.px, bottom = 48.dp)) {
                item(key = "head") {
                    Column(Modifier.padding(horizontal = GUTTER)) {
                        // Web: Back top-left, the wordmark top-right.
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            BackPill { nav.pop() }
                            Spacer(Modifier.weight(1f))
                            Brand()
                        }
                        // Hero: poster + text column, settled to the bottom of a 70vh block.
                        Box(Modifier.fillMaxWidth().heightIn(min = (TvWeb.HERO_H - TvWeb.BTN_H - TvWeb.DETAIL_PAD_BOTTOM - 66f).px), contentAlignment = Alignment.BottomStart) {
                            Row(Modifier.padding(top = TvWeb.DETAIL_PAD_TOP.px), verticalAlignment = Alignment.Bottom) {
                                if (t.poster != null) Box(Modifier.size(TvWeb.DETAIL_POSTER_W.px, (TvWeb.DETAIL_POSTER_W * 1.5f).px).clip(RADIUS).border(0.5.dp, Tok.border, RADIUS)) {
                                    Art(t.poster, "w342", Modifier.fillMaxSize(), t.title)
                                }
                                Column(Modifier.padding(start = TvWeb.DETAIL_POSTER_GAP.px).fillMaxWidth(0.7f)) {
                                    Text(t.title, style = TextStyle(color = Tok.text, fontSize = TvWeb.DETAIL_TITLE.pxSp, lineHeight = TvWeb.DETAIL_TITLE.pxSp, fontWeight = FontWeight.Light), maxLines = 2)
                                    // Always reserved, so the lines below do not jump when it lands.
                                    Text(t.tagline.orEmpty(), color = Tok.textMuted, fontSize = TvWeb.TAGLINE.pxSp, fontStyle = FontStyle.Italic, lineHeight = (TvWeb.TAGLINE * 1.4f).pxSp,
                                        maxLines = 1, modifier = Modifier.padding(top = 5.dp))
                                    val extra = listOfNotNull(
                                        runtimeText(t.runtimeMin),
                                        t.seasons?.takeIf { t.mediaType == "tv" && it > 0 }?.let { "$it season${if (it == 1) "" else "s"}" },
                                    ).joinToString("  ·  ")
                                    MetaLine(t.year, t.rating, extra.ifEmpty { null }, t.originalLang, TvWeb.DETAIL_META, Modifier.padding(vertical = 6.dp))
                                    var open by remember(t.tmdbId) { mutableStateOf(false) }
                                    var clamped by remember(t.tmdbId) { mutableStateOf(false) }
                                    Text(t.overview.orEmpty(), color = Tok.textSecondary, fontSize = TvWeb.DETAIL_OVERVIEW.pxSp, lineHeight = (TvWeb.DETAIL_OVERVIEW * 1.5f).pxSp,
                                        minLines = 3, maxLines = if (open) Int.MAX_VALUE else 3, overflow = TextOverflow.Ellipsis,
                                        onTextLayout = { if (!open) clamped = it.hasVisualOverflow })
                                    // Read more only when the clamp hides text (web data-clamped).
                                    if (clamped || open) TvLink(if (open) "Show less" else "Read more", 15f) { open = !open }
                                }
                            }
                        }
                    }
                }
                item(key = "actions") {
                    // Lined up with the text column, clear of the poster (web padding-left 198px).
                    Row(Modifier.padding(start = GUTTER + (if (t.poster != null) (TvWeb.DETAIL_POSTER_W + TvWeb.DETAIL_POSTER_GAP).px else 0.dp), top = 6.dp, bottom = TvWeb.DETAIL_PAD_BOTTOM.px),
                        horizontalArrangement = Arrangement.spacedBy(TvWeb.ACTION_GAP.px)) {
                        TvButton(vm.playLabel(), primary = true, modifier = Modifier.focusRequester(playFocus).onFocusChanged { if (it.isFocused) scope.launch { detailList.animateScrollToItem(0) } }, icon = Icons.Filled.PlayArrow) {
                            vm.playRequest()?.let { nav.push(Screen.Player(it)) }
                        }
                        if (vm.canStartOver) TvButton("Start over", primary = false, icon = Icons.Filled.Replay) {
                            vm.playRequest(fromStart = true)?.let { nav.push(Screen.Player(it)) }
                        }
                        TvButton(if (vm.inList) "In My List" else "My List", primary = false, icon = if (vm.inList) Icons.Filled.Check else Icons.Filled.Add) { vm.toggleList() }
                    }
                }
                if (t.mediaType == "tv" && t.seasonList.isNotEmpty()) {
                    item(key = "seasons") {
                        Column(Modifier.padding(top = TvWeb.ROW_GAP.px)) {
                            TvSection("Episodes")
                            val seasons = t.seasonList.filter { it.number > 0 }
                            if (seasons.size > 1) LazyRow(horizontalArrangement = Arrangement.spacedBy(5.dp), contentPadding = PaddingValues(horizontal = GUTTER, vertical = 6.dp)) {
                                items(seasons, key = { it.number }) { s ->
                                    TvChip(s.name.ifEmpty { "Season ${s.number}" }, selected = s.number == vm.season) { vm.selectSeason(s.number) }
                                }
                            }
                        }
                    }
                    item(key = "episodes") {
                        val epW = TvWeb.EP_W.px
                        val epH = (TvWeb.EP_W * 9f / 16f).px
                        CompositionLocalProvider(LocalBringIntoViewSpec provides CenterScroll) {
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(CARD_GAP), contentPadding = PaddingValues(horizontal = GUTTER, vertical = FOCUS_PAD), modifier = Modifier.bleedVertical(FOCUS_PAD / 2)) {
                                if (vm.episodesLoading) items(5) { Box(Modifier.size(epW, epH).background(Tok.surfaceSolid, RADIUS)) }
                                else items(vm.episodes, key = { "${it.season}-${it.episode}" }) { ep ->
                                    val p = vm.episodeProgress(ep)
                                    val r = vm.resume
                                    val isNext = r != null && r.season == ep.season && r.episode == ep.episode
                                    val src = remember { MutableInteractionSource() }
                                    val focused by src.collectIsFocusedAsState()
                                    Column(Modifier.width(epW).cardLift(focused)) {
                                        Card(
                                            onClick = { vm.playRequest(ep)?.let { nav.push(Screen.Player(it)) } },
                                            modifier = Modifier.returnTarget().size(epW, epH),
                                            shape = CardDefaults.shape(RADIUS),
                                            scale = CardDefaults.scale(focusedScale = 1f),
                                            border = CardDefaults.border(focusedBorder = cardRing),
                                            glow = CardDefaults.glow(focusedGlow = cardGlow),
                                            colors = CardDefaults.colors(containerColor = Tok.surfaceSolid),
                                            interactionSource = src,
                                        ) {
                                            Box(Modifier.fillMaxSize()) {
                                                Art(ep.still, "w300", Modifier.fillMaxSize())
                                                Text("E${ep.episode}", color = Tok.text, fontSize = 16f.pxSp, fontWeight = FontWeight.SemiBold,
                                                    modifier = Modifier.padding(4.dp).background(Tok.bg.copy(alpha = 0.7f), RADIUS).padding(horizontal = 4.dp, vertical = 1.dp))
                                                if (p != null) Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(TvWeb.CARD_PROG.px).background(Tok.fill3)) {
                                                    Box(Modifier.fillMaxHeight().fillMaxWidth(if (p.finished) 1f else p.pct).background(Tok.accent))
                                                }
                                            }
                                        }
                                        Text(ep.title.ifEmpty { "Episode ${ep.episode}" }, color = Tok.text, fontSize = TvWeb.EP_TITLE.pxSp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 5.dp))
                                        val meta = listOfNotNull(if (isNext) "Next up" else null, ep.runtimeMin?.let { "$it min" }, if (p?.finished == true) "Watched" else null).joinToString(" · ")
                                        if (meta.isNotEmpty()) Text(meta, color = if (isNext) Tok.accent else Tok.textMuted, fontSize = TvWeb.EP_META.pxSp)
                                        ep.overview?.let { Text(it, color = Tok.textMuted, fontSize = TvWeb.EP_META.pxSp, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 1.dp)) }
                                    }
                                }
                            }
                        }
                    }
                }
                if (t.credits.isNotEmpty()) item(key = "cast") {
                    Column(Modifier.padding(top = TvWeb.ROW_GAP.px)) {
                        TvSection("Cast")
                        CompositionLocalProvider(LocalBringIntoViewSpec provides CenterScroll) {
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(CARD_GAP), contentPadding = PaddingValues(horizontal = GUTTER, vertical = FOCUS_PAD), modifier = Modifier.bleedVertical(FOCUS_PAD / 2)) {
                                items(t.credits, key = { it.id }) { c -> TvCastCard(c) { nav.push(Screen.Person(c.id, c.name)) } }
                            }
                        }
                    }
                }
                val sim = vm.similar
                if (sim == null || sim.isNotEmpty()) item(key = "similar") {
                    Column(Modifier.padding(top = TvWeb.ROW_GAP.px)) {
                        TvSection("More like this")
                        CompositionLocalProvider(LocalBringIntoViewSpec provides CenterScroll) {
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(CARD_GAP), contentPadding = PaddingValues(horizontal = GUTTER, vertical = FOCUS_PAD), modifier = Modifier.bleedVertical(FOCUS_PAD)) {
                                if (sim == null) items(6) { CardSkeleton() }
                                else items(sim, key = { it.key }) { s -> PosterCard(s) { nav.push(Screen.Detail(s.mediaType, s.tmdbId)) } }
                            }
                        }
                    }
                }
                item(key = "facts") {
                    // Web .facts: Genres, Director, Writers, Country, under a hairline.
                    val facts = listOf("Genres" to t.genres.joinToString(" · "), "Director" to t.director.joinToString(", "),
                        "Writers" to t.writers.joinToString(", "), "Country" to t.country.joinToString(", ")).filter { it.second.isNotEmpty() }
                    if (facts.isNotEmpty()) Column(Modifier.padding(start = GUTTER, end = GUTTER, top = 40f.px).widthIn(max = 430.dp)) {
                        Box(Modifier.fillMaxWidth().height(0.5.dp).background(Tok.border))
                        FlowRow(Modifier.padding(top = 24f.px), horizontalArrangement = Arrangement.spacedBy(32f.px), verticalArrangement = Arrangement.spacedBy(22f.px)) {
                            facts.forEach { (k, v) ->
                                Column(Modifier.widthIn(min = 190f.px, max = 215.dp)) {
                                    Text(k.uppercase(), color = Tok.textDim, fontSize = TvWeb.FACT_K.pxSp, letterSpacing = (TvWeb.FACT_K * 0.15f).pxSp, modifier = Modifier.padding(bottom = 2.dp))
                                    Text(v, color = Tok.textSecondary, fontSize = TvWeb.FACT_V.pxSp, lineHeight = (TvWeb.FACT_V * 1.5f).pxSp)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** Web .detail-back on TV: a pill with the back glyph, 56px tall, 21px label. */
@Composable
private fun BackPill(onClick: () -> Unit) {
    TvLink("Back", TvWeb.BACK_FONT, icon = Glyphs.back, onClick = onClick)
}

@Composable
private fun TvSection(label: String) {
    Text(label, style = TextStyle(color = Tok.textSecondary, fontSize = TvWeb.ROW_LABEL.pxSp, fontWeight = FontWeight.Medium),
        modifier = Modifier.padding(start = GUTTER, bottom = TvWeb.ROW_LABEL_BOTTOM.px))
}

@Composable
private fun TvCastCard(c: Credit, onClick: () -> Unit) {
    val src = remember { MutableInteractionSource() }
    val focused by src.collectIsFocusedAsState()
    val size = TvWeb.PERSON.px
    Column(Modifier.width(size).cardLift(focused), horizontalAlignment = Alignment.CenterHorizontally) {
        Surface(
            onClick = onClick,
            modifier = Modifier.returnTarget().size(size),
            shape = ClickableSurfaceDefaults.shape(CircleShape),
            scale = ClickableSurfaceDefaults.scale(focusedScale = 1f),
            border = ClickableSurfaceDefaults.border(focusedBorder = Border(BorderStroke(TvWeb.RING.px, Focus.ring), inset = TvWeb.RING_OFFSET.px, shape = CircleShape)),
            glow = ClickableSurfaceDefaults.glow(focusedGlow = cardGlow),
            colors = ClickableSurfaceDefaults.colors(containerColor = Tok.surfaceSolid, focusedContainerColor = Tok.surfaceSolid),
            interactionSource = src,
        ) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                if (c.profile != null) Art(c.profile, "w185", Modifier.fillMaxSize().clip(CircleShape), c.name)
                else Text(c.name.take(1), color = Tok.textSecondary, fontSize = 18.sp)
            }
        }
        Text(c.name, color = Tok.text, fontSize = TvWeb.PERSON_NAME.pxSp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 5.dp))
        c.character?.let { Text(it, color = Tok.textMuted, fontSize = TvWeb.PERSON_ROLE.pxSp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
    }
}

private fun LazyGridScope.full(key: String, content: @Composable () -> Unit) =
    item(key = key, span = { GridItemSpan(maxLineSpan) }) { content() }

// ── Person, browse, search, list ────────────────────────────────────────────

@Composable
private fun TvPerson(nav: Nav, id: Long, name: String) {
    val vm: PersonVm = viewModel(key = "person-$id")
    LaunchedEffect(id) { vm.load(id) }
    val d = vm.data
    val first = remember { FocusRequester() }
    LaunchedEffect(d) { if (d?.titles?.isNotEmpty() == true) first.focusWhenAttached() }
    LazyVerticalGrid(
        GridCells.Adaptive(CARD_W), Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = GUTTER, end = GUTTER, top = TvWeb.DETAIL_TOP.px, bottom = 32.dp),
        horizontalArrangement = Arrangement.spacedBy(CARD_GAP), verticalArrangement = Arrangement.spacedBy(CARD_GAP),
    ) {
        full("head") {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 12.dp)) {
                val p = d?.person
                Box(Modifier.size(TvWeb.PERSON.px).clip(CircleShape).background(Tok.surfaceSolid), contentAlignment = Alignment.Center) {
                    if (p?.profile != null) Art(p.profile, "w185", Modifier.fillMaxSize(), p.name)
                    else Text((p?.name ?: name).take(1), color = Tok.textSecondary, fontSize = 18.sp)
                }
                Column(Modifier.padding(start = 12.dp)) {
                    Text(p?.name ?: name, style = TextStyle(color = Tok.text, fontSize = TvWeb.PAGE_TITLE.pxSp, fontWeight = FontWeight.Bold))
                    p?.knownFor?.let { Text(it, color = Tok.textMuted, fontSize = TvWeb.SUMMARY.pxSp) }
                    when {
                        d == null -> Text("Loading", color = Tok.textMuted, fontSize = TvWeb.SUMMARY.pxSp)
                        d.person == null -> Text("That profile is not in the catalog.", color = Tok.textMuted, fontSize = TvWeb.SUMMARY.pxSp)
                        d.titles.isEmpty() -> Text("No titles to show.", color = Tok.textMuted, fontSize = TvWeb.SUMMARY.pxSp)
                        else -> Text("Known for", color = Tok.textSecondary, fontSize = TvWeb.ROW_LABEL.pxSp, fontWeight = FontWeight.Medium, modifier = Modifier.padding(top = 6.dp))
                    }
                }
            }
        }
        val titles = d?.titles.orEmpty()
        gridItemsIndexed(titles, key = { _, t -> t.key }) { i, t ->
            PosterCard(t, if (i == 0) Modifier.focusRequester(first) else Modifier, showType = true) { nav.push(Screen.Detail(t.mediaType, t.tmdbId)) }
        }
    }
}

@Composable
private fun TvBrowse(nav: Nav, initial: BrowseFilters) {
    val vm: BrowseVm = viewModel(key = "browse-$initial")
    LaunchedEffect(initial) { vm.start(initial) }
    val f = vm.filters
    LazyVerticalGrid(
        GridCells.Adaptive(CARD_W), Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = GUTTER, end = GUTTER, top = TvWeb.DETAIL_TOP.px, bottom = 32.dp),
        horizontalArrangement = Arrangement.spacedBy(CARD_GAP), verticalArrangement = Arrangement.spacedBy(CARD_GAP),
    ) {
        full("head") {
            Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Browse", style = TextStyle(color = Tok.text, fontSize = TvWeb.PAGE_TITLE.pxSp, fontWeight = FontWeight.Bold), modifier = Modifier.padding(end = 10.dp))
                    Text(listOfNotNull(vm.total?.let { "%,d titles".format(it) }).joinToString(), color = Tok.textMuted, fontSize = TvWeb.SUMMARY.pxSp)
                }
                TvFilterRow("Type", listOf("movie" to "Movies", "tv" to "Series"), { it == f.type }) { vm.set(f.copy(type = it)) }
                TvFilterRow("Language", LanguagePrefs.LANGS.map { it.code to it.label }, { it in f.langs }) { c -> vm.set(f.copy(langs = if (c in f.langs) f.langs - c else f.langs + c)) }
                TvFilterRow("Genre", BrowseOptions.GENRES.map { it.id to it.name }, { it in f.genres }) { g -> vm.set(f.copy(genres = if (g in f.genres) f.genres - g else f.genres + g)) }
                TvFilterRow("Decade", BrowseOptions.DECADES.map { it.id to it.name }, { it == f.decade }) { d -> vm.set(f.copy(decade = if (f.decade == d) null else d)) }
                TvFilterRow("Rating", BrowseOptions.RATINGS.map { it to "★ $it+" }, { it == f.minRating }) { r -> vm.set(f.copy(minRating = if (f.minRating == r) null else r)) }
                TvFilterRow("Sort", BrowseOptions.SORTS.map { it.id to it.name }, { it == f.sort }) { vm.set(f.copy(sort = it)) }
                vm.error?.let { Text(it, color = Tok.danger, fontSize = TvWeb.SUMMARY.pxSp) }
                if (!vm.loading && vm.titles.isEmpty() && vm.total != null) Text("No titles match those filters. Try removing a filter.", color = Tok.textMuted, fontSize = 22f.pxSp)
            }
        }
        gridItemsIndexed(vm.titles, key = { _, t -> t.key }) { i, t ->
            // Nearing the end loads the next page.
            if (i >= vm.titles.size - 6) LaunchedEffect(vm.titles.size) { vm.loadMore() }
            PosterCard(t, showType = true) { nav.push(Screen.Detail(t.mediaType, t.tmdbId)) }
        }
        if (vm.loading) items(if (vm.titles.isEmpty()) 12 else 6, key = { "sk$it" }) { CardSkeleton() }
    }
}

@Composable
private fun <T> TvFilterRow(label: String, opts: List<Pair<T, String>>, on: (T) -> Boolean, pick: (T) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = Tok.textMuted, fontSize = TvWeb.SUMMARY.pxSp, modifier = Modifier.width(60.dp))
        LazyRow(horizontalArrangement = Arrangement.spacedBy(5.dp), contentPadding = PaddingValues(vertical = 4.dp, horizontal = 4.dp)) {
            items(opts, key = { it.first.toString() }) { (id, name) -> TvChip(name, selected = on(id)) { pick(id) } }
        }
    }
}

private val TV_SUGGEST = listOf(
    "Telugu" to BrowseFilters(langs = listOf("te")), "Tamil" to BrowseFilters(langs = listOf("ta")),
    "Kannada" to BrowseFilters(langs = listOf("kn")), "Action" to BrowseFilters(genres = listOf(28)),
    "Top rated" to BrowseFilters(sort = "vote_average.desc"),
)

@Composable
private fun TvSearch(nav: Nav) {
    val vm: SearchVm = viewModel()
    val field = remember { FocusRequester() }
    val firstCard = remember { FocusRequester() }
    val grid = rememberLazyGridState()
    val kb = LocalSoftwareKeyboardController.current
    // Set by the IME action or D-pad Down: focus the first card once results are in.
    var toResults by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { field.focusWhenAttached() }
    LaunchedEffect(toResults, vm.resultsFor, vm.loading, vm.results) {
        if (SearchFocus.ready(toResults, vm.query, vm.resultsFor, vm.loading, vm.results.size)) {
            grid.scrollToItem(0)
            withFrameNanos { } // let the first card compose before focusing it
            runCatching { firstCard.requestFocus() }
            // Reset last: toResults is a key of this effect, so changing it cancels it.
            toResults = false
        }
    }
    fun goToResults() {
        kb?.hide()
        vm.submit()
        toResults = true
    }
    Column(Modifier.fillMaxSize().padding(start = GUTTER, end = GUTTER, top = TvWeb.DETAIL_TOP.px)) {
        var fieldFocused by remember { mutableStateOf(false) }
        val searchSize = TvWeb.SEARCH_INPUT.pxSp
        BasicTextField(
            value = vm.query,
            onValueChange = { vm.onQuery(it); toResults = false },
            singleLine = true,
            textStyle = TextStyle(color = Tok.text, fontSize = searchSize),
            cursorBrush = SolidColor(Color.White),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            // The IME action closes the keyboard and moves to the first result.
            // While the keyboard is open it keeps D-pad Down for itself.
            keyboardActions = KeyboardActions(onSearch = { goToResults() }, onDone = { goToResults() }, onGo = { goToResults() }),
            modifier = Modifier
                .widthIn(max = 440.dp).fillMaxWidth()
                .returnTarget()
                .focusRequester(field)
                .onFocusChanged { fieldFocused = it.isFocused }
                .onPreviewKeyEvent { e ->
                    when {
                        // D-pad Down leaves the field for the first result.
                        e.type == KeyEventType.KeyDown && e.key == Key.DirectionDown -> {
                            if (vm.results.isNotEmpty() || vm.loading || vm.resultsFor != vm.query.trim()) goToResults()
                            true
                        }
                        // D-pad centre opens the on-screen keyboard.
                        e.type == KeyEventType.KeyUp && (e.key == Key.DirectionCenter || e.key == Key.Enter) -> { kb?.show(); true }
                        else -> false
                    }
                },
            decorationBox = { inner ->
                // One ring around the whole field (web .search-field:has(:focus)).
                val ring by animateFloatAsState(if (fieldFocused) 1f else 0f, tween(TvWeb.CONTROL_MS, easing = ControlEase), label = "field")
                Row(
                    Modifier.background(Tok.surfaceSolid, Tok.pill)
                        .border(TvWeb.RING.px, if (ring > 0.5f) Focus.ring else Tok.border, Tok.pill)
                        .padding(start = 16f.px, end = 8f.px, top = 12f.px, bottom = 12f.px),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Filled.Search, null, tint = Tok.textMuted, modifier = Modifier.padding(end = 6.dp).size(28f.px))
                    Box(Modifier.weight(1f)) {
                        if (vm.query.isEmpty()) Text("Search movies and shows", color = Tok.textDim, fontSize = searchSize)
                        inner()
                    }
                }
            },
        )
        Spacer(Modifier.height(10.dp))
        when {
            vm.error != null -> Text(vm.error!!, color = Tok.danger, fontSize = TvWeb.SUMMARY.pxSp)
            vm.loading && vm.results.isEmpty() -> Text("Searching", color = Tok.textMuted, fontSize = TvWeb.SUMMARY.pxSp)
            vm.query.length >= 2 && vm.results.isEmpty() && !vm.loading -> Text("No results for \"${vm.query}\"", color = Tok.textMuted, fontSize = 22f.pxSp)
            vm.results.isNotEmpty() -> Text("${vm.results.size} results for “${vm.resultsFor}”", color = Tok.textMuted, fontSize = TvWeb.SUMMARY.pxSp)
            vm.query.isBlank() -> Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                if (vm.recent.isNotEmpty()) {
                    Text("Recent", color = Tok.textSecondary, fontSize = TvWeb.ROW_LABEL.pxSp, fontWeight = FontWeight.Medium)
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(5.dp), contentPadding = PaddingValues(4.dp)) {
                        items(vm.recent, key = { it }) { q -> TvChip(q, icon = Icons.Filled.Search) { vm.onQuery(q); vm.submit(); toResults = true } }
                        item(key = "clear") { TvChip("Clear") { vm.clearRecent() } }
                    }
                }
                Text("Browse instead", color = Tok.textSecondary, fontSize = TvWeb.ROW_LABEL.pxSp, fontWeight = FontWeight.Medium)
                LazyRow(horizontalArrangement = Arrangement.spacedBy(5.dp), contentPadding = PaddingValues(4.dp)) {
                    items(TV_SUGGEST, key = { it.first }) { (label, f) -> TvChip(label) { nav.push(Screen.Browse(f)) } }
                }
            }
        }
        LazyVerticalGrid(GridCells.Adaptive(CARD_W), state = grid, horizontalArrangement = Arrangement.spacedBy(CARD_GAP), verticalArrangement = Arrangement.spacedBy(CARD_GAP), contentPadding = PaddingValues(vertical = FOCUS_PAD / 2, horizontal = 4.dp)) {
            gridItemsIndexed(vm.results, key = { _, t -> t.key }) { i, t ->
                PosterCard(t, if (i == 0) Modifier.focusRequester(firstCard) else Modifier, showType = true) { vm.remember(); nav.push(Screen.Detail(t.mediaType, t.tmdbId)) }
            }
        }
    }
}

@Composable
private fun TvGrid(nav: Nav, title: String, titles: List<Title>, empty: String) {
    Column(Modifier.fillMaxSize().padding(start = GUTTER, end = GUTTER, top = TvWeb.DETAIL_TOP.px)) {
        Text(title, style = TextStyle(color = Tok.text, fontSize = TvWeb.PAGE_TITLE.pxSp, fontWeight = FontWeight.Bold), modifier = Modifier.padding(bottom = 10.dp))
        if (titles.isEmpty()) Text(empty, color = Tok.textMuted, fontSize = 22f.pxSp)
        LazyVerticalGrid(GridCells.Adaptive(CARD_W), horizontalArrangement = Arrangement.spacedBy(CARD_GAP), verticalArrangement = Arrangement.spacedBy(CARD_GAP), contentPadding = PaddingValues(vertical = FOCUS_PAD / 2, horizontal = 4.dp)) {
            items(titles, key = { it.key }) { t -> PosterCard(t) { nav.push(Screen.Detail(t.mediaType, t.tmdbId)) } }
        }
    }
}

@Composable
private fun TvLangs(firstRun: Boolean, onDone: () -> Unit) {
    val prefs = App.instance.prefs
    // First run opens with Telugu chosen and ready to save: it is the library's
    // standing default, so a first-time viewer lands on it without hunting.
    val chosen = remember { mutableStateListOf<String>().apply { if (firstRun) add("te") else addAll(prefs.langs()) } }
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) { first.focusWhenAttached() }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        // Web .lang-modal on TV: min(760px,90vw) wide, --space-8 padding, 34px title, 20px hint.
        Column(Modifier.widthIn(max = 380.dp).background(Tok.surface, Tok.radiusLg).padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("Your languages", style = TextStyle(color = Tok.text, fontSize = 34f.pxSp, fontWeight = FontWeight.Bold))
            Text("Pick the languages you watch.", color = Tok.textMuted, fontSize = 20f.pxSp, modifier = Modifier.padding(top = 3.dp, bottom = 12.dp))
            FlowRowCompat {
                LanguagePrefs.LANGS.forEachIndexed { i, l ->
                    val on = l.code in chosen
                    TvChip(if (on) "✓ ${l.label}" else l.label, selected = on, modifier = if (i == 0) Modifier.focusRequester(first) else Modifier) {
                        if (on) chosen.remove(l.code) else chosen.add(l.code)
                    }
                }
            }
            Spacer(Modifier.height(14.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(TvWeb.ACTION_GAP.px)) {
                TvButton(if (chosen.isEmpty()) "Done" else "Done (${chosen.size})", primary = true) {
                    prefs.save(chosen.toList()); onDone()
                }
                if (firstRun) TvButton("Skip", primary = false) { prefs.save(emptyList()); onDone() }
            }
        }
    }
}

@Composable
@OptIn(ExperimentalLayoutApi::class)
private fun FlowRowCompat(content: @Composable () -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally), verticalArrangement = Arrangement.spacedBy(6.dp)) { content() }
}

/** Scroll only as far as needed to show the focused item (web block:'nearest'). */
@OptIn(ExperimentalFoundationApi::class)
private val MinimalScroll = object : BringIntoViewSpec {
    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float {
        val trailing = offset + size
        return when {
            offset >= 0 && trailing <= containerSize -> 0f
            offset < 0 && trailing > containerSize -> 0f
            kotlin.math.abs(offset) < kotlin.math.abs(trailing - containerSize) -> offset
            else -> trailing - containerSize
        }
    }
}

/** Centre the focused card in its row (web scrollIntoView inline:'center'); the list clamps at its ends. */
@OptIn(ExperimentalFoundationApi::class)
private val CenterScroll = object : BringIntoViewSpec {
    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float =
        offset + size / 2f - containerSize / 2f
}

// ── Left rail ───────────────────────────────────────────────────────────────

private data class RailDest(val screen: Screen, val label: String, val icon: ImageVector)

// Web Nav.jsx order: Search first (top of a TV rail), Home, Browse, My list, Languages.
private val RAIL = listOf(
    RailDest(Screen.Search, "Search", Icons.Filled.Search),
    RailDest(Screen.Home, "Home", Icons.Filled.Home),
    RailDest(Screen.Browse(), "Browse", Icons.Filled.Tune),
    RailDest(Screen.MyList, "My list", Icons.Filled.Bookmark),
    RailDest(Screen.Langs(false), "Languages", Icons.Filled.Translate),
)

private fun RailDest.matches(s: Screen) = when (screen) {
    is Screen.Browse -> s is Screen.Browse
    is Screen.Langs -> s is Screen.Langs
    else -> s == screen
}

/**
 * Left rail (web nav.css, Netflix / Hotstar style). Collapsed: icons on a
 * translucent fade, width reserved so it never covers a poster. With focus it
 * opens to icon + label over a 50% black dim of the page, entering on the
 * current destination. Up/Down stay inside it (no wrap), Left goes nowhere,
 * Right returns to exactly where the viewer was in the page.
 */
@Composable
@OptIn(ExperimentalComposeUiApi::class)
private fun TvRail(nav: Nav, top: Screen, armed: Boolean) {
    var open by remember { mutableStateOf(false) }
    val railTween = tween<Dp>(TvWeb.RAIL_MS, easing = ControlEase)
    val width by animateDpAsState(if (open) RAIL_OPEN_W else RAIL_W, railTween, label = "rail")
    val openness by animateFloatAsState(if (open) 1f else 0f, tween(TvWeb.RAIL_MS, easing = ControlEase), label = "rail-open")
    val current = RAIL.indexOfFirst { it.matches(top) }.coerceAtLeast(0)
    val reqs = remember { List(RAIL.size) { FocusRequester() } }
    var at by remember { mutableIntStateOf(current) }
    val scope = rememberCoroutineScope()
    val last = LocalLastFocus.current
    val entry = LocalRailEntry.current
    SideEffect { entry.value = reqs[current] }
    val focusManager = LocalFocusManager.current
    // Back to the item that had focus before the rail; if it is gone (a new
    // screen), the nearest item to the right.
    fun toContent() {
        last.value?.let { runCatching { it.requestFocus() } }
        scope.launch { withFrameNanos { }; if (open) focusManager.moveFocus(FocusDirection.Right) }
    }
    // The page behind dims instead of reflowing (web box-shadow 0 0 0 100vmax black .5).
    if (openness > 0f) Box(Modifier.fillMaxSize().graphicsLayer { alpha = openness }.background(Color.Black.copy(alpha = 0.5f)))
    val closedFade = Brush.horizontalGradient(0f to Tok.bg.copy(alpha = 0.72f), 0.75f to Tok.bg.copy(alpha = 0.38f), 1f to Tok.bg.copy(alpha = 0f))
    val openFade = Brush.horizontalGradient(0f to Tok.bg.copy(alpha = 0.98f), 0.8f to Tok.bg.copy(alpha = 0.94f), 1f to Tok.bg.copy(alpha = 0.85f))
    Box(Modifier.fillMaxHeight().width(width).clipToBounds()) {
        Box(Modifier.fillMaxSize().background(closedFade))
        Box(Modifier.fillMaxSize().graphicsLayer { alpha = openness }.background(openFade))
        Column(
            Modifier.fillMaxSize()
                .onFocusChanged { open = it.hasFocus }
                .focusProperties { enter = { reqs[current] } }
                .focusGroup()
                .onPreviewKeyEvent { e ->
                    if (e.type != KeyEventType.KeyDown) false
                    else when (e.key) {
                        Key.DirectionRight -> { toContent(); true }
                        Key.DirectionLeft -> true
                        Key.DirectionUp, Key.DirectionDown -> {
                            val next = railStep(at, if (e.key == Key.DirectionUp) -1 else 1, RAIL.size)
                            if (next != at) runCatching { reqs[next].requestFocus() }
                            true
                        }
                        else -> false
                    }
                }
                .padding(start = TvWeb.SAFE_X.px, end = 4f.px),
            verticalArrangement = Arrangement.spacedBy(TvWeb.RAIL_ITEM_GAP.px, Alignment.CenterVertically),
        ) {
            RAIL.forEachIndexed { i, d ->
                RailButton(d, selected = i == current, openness = openness, open = open,
                    // Never a default focus target: focusable once the page has held
                    // focus (see TvApp), and while the rail already holds it, so a
                    // tab switch does not tear focus out from under the viewer.
                    modifier = Modifier.focusProperties { canFocus = armed || open }
                        .focusRequester(reqs[i]).onFocusChanged { if (it.isFocused) at = i }) {
                    if (i != current) nav.tab(d.screen)
                    // Hand focus to the new screen once it has composed, unless
                    // the screen already took it (Home restores, Search focuses its field).
                    scope.launch {
                        withFrameNanos { }; withFrameNanos { }
                        if (open) { last.value = null; toContent() }
                    }
                }
            }
        }
    }
}

@Composable
private fun RailButton(d: RailDest, selected: Boolean, openness: Float, open: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val src = remember { MutableInteractionSource() }
    Surface(
        onClick = onClick,
        modifier = modifier.fillMaxWidth().height(TvWeb.RAIL_ICON.px),
        shape = ClickableSurfaceDefaults.shape(Tok.pill),
        // Rail items never scale (web .app-nav-item:focus transform:none).
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1f),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = Color.Transparent,
            // Current destination is white; the others muted, a step brighter while open.
            contentColor = if (selected) Color.White else if (open) Tok.textSecondary else Tok.textMuted,
            focusedContainerColor = Focus.fill,
            focusedContentColor = Focus.ink,
        ),
        glow = ClickableSurfaceDefaults.glow(focusedGlow = controlGlow),
        interactionSource = src,
    ) {
        Row(Modifier.fillMaxSize().padding(horizontal = TvWeb.RAIL_ITEM_PAD.px), verticalAlignment = Alignment.CenterVertically) {
            Icon(d.icon, contentDescription = d.label, tint = LocalContentColor.current, modifier = Modifier.size(TvWeb.RAIL_GLYPH.px))
            // Label fades in as the rail opens (web .app-nav-label opacity).
            Text(d.label, fontSize = TvWeb.RAIL_LABEL.pxSp, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium, maxLines = 1, softWrap = false,
                modifier = Modifier.padding(start = TvWeb.RAIL_LABEL_GAP.px).graphicsLayer { alpha = openness })
        }
    }
}

/** The content item that last had focus, so Right from the rail returns to it. */
private val LocalLastFocus = staticCompositionLocalOf { mutableStateOf<FocusRequester?>(null) }

/** The rail's current destination, so Left from a control with nothing beside it opens the rail. */
private val LocalRailEntry = staticCompositionLocalOf { mutableStateOf<FocusRequester?>(null) }

/** Marks a focusable as a place the rail can hand focus back to. */
@Composable
private fun Modifier.returnTarget(): Modifier {
    val me = remember { FocusRequester() }
    val last = LocalLastFocus.current
    return this.focusRequester(me).onFocusChanged { if (it.isFocused) last.value = me }
}
