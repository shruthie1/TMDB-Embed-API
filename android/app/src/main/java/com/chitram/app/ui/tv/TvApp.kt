package com.chitram.app.ui.tv

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.gestures.BringIntoViewSpec
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.runtime.CompositionLocalProvider
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.material.icons.filled.Home
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Brush
import androidx.tv.material3.Glow
import androidx.tv.material3.LocalContentColor
import com.chitram.app.ui.common.Focus
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.itemsIndexed as gridItemsIndexed
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.runtime.withFrameNanos
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.focus.focusRestorer
import kotlinx.coroutines.launch
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.foundation.border
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridScope
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Replay
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Translate
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.Icon
import androidx.compose.ui.graphics.vector.ImageVector
import com.chitram.app.data.BrowseFilters
import com.chitram.app.data.BrowseOptions
import com.chitram.app.data.Credit
import com.chitram.app.ui.common.BrowseVm
import com.chitram.app.ui.common.PersonVm
import com.chitram.app.ui.common.langName
import com.chitram.app.ui.common.runtimeText
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.tv.material3.Border
import androidx.tv.material3.Button
import androidx.tv.material3.ButtonDefaults
import androidx.tv.material3.Card
import androidx.tv.material3.CardDefaults
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import androidx.tv.material3.darkColorScheme
import com.chitram.app.App
import com.chitram.app.data.LanguagePrefs
import com.chitram.app.data.Progress
import com.chitram.app.data.Title
import com.chitram.app.ui.common.Art
import com.chitram.app.ui.common.DetailVm
import com.chitram.app.ui.common.HomeVm
import com.chitram.app.ui.common.Nav
import com.chitram.app.ui.common.PlayerScreen
import com.chitram.app.ui.common.Row as HomeRow
import com.chitram.app.ui.common.Screen
import com.chitram.app.ui.common.SearchFocus
import com.chitram.app.ui.common.SearchVm
import com.chitram.app.ui.common.Tok
import com.chitram.app.ui.common.metaLine
import kotlinx.coroutines.delay

// Focus: see Focus in Common.kt. Pictures get a white frame, shadow and lift.
private val focusBorder = Border(BorderStroke(Focus.ringWidth, Focus.ring), shape = Tok.radiusMd)
private val focusGlow = Glow(elevationColor = Focus.shadow, elevation = Focus.shadowElevation)
private const val FOCUS_SCALE = Focus.pictureScale
private val POSTER_W = 124.dp
private val POSTER_H = 186.dp
/** Collapsed side rail; its width is reserved so it never covers a poster. */
private val RAIL_W = 84.dp
private val RAIL_OPEN_W = 248.dp
/** Left gutter of a screen that sits next to the rail. */
private val RAIL_GUTTER = 28.dp

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
            val rail = s == Screen.Home || s == Screen.Search || s == Screen.MyList || s is Screen.Browse || (s is Screen.Langs && !s.firstRun)
            CompositionLocalProvider(LocalLastFocus provides remember { mutableStateOf<FocusRequester?>(null) }) {
            Box(Modifier.fillMaxSize().padding(start = if (rail) RAIL_W else 0.dp)) {
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
            if (rail) TvRail(nav, s)
            }
        }
    }
}

@Composable
@OptIn(ExperimentalFoundationApi::class)
private fun TvHome(nav: Nav, restore: androidx.compose.runtime.MutableState<String?>, listState: androidx.compose.foundation.lazy.LazyListState) {
    val vm: HomeVm = viewModel()
    LaunchedEffect(Unit) { vm.load() }
    // Focused card as (row kind, title key).
    var focused by remember { mutableStateOf<Pair<String, String>?>(null) }
    var hero by remember { mutableStateOf<Pair<String, String>?>(null) }
    // Swap the hero only once focus rests, so fast scrolling does not load backdrops.
    LaunchedEffect(focused) { delay(300); focused?.let { hero = it } }
    // Looked up in the current rows, so a Continue card picks up its overview
    // when it arrives after focus.
    val shown = hero?.let { (kind, key) -> vm.rows.firstOrNull { it.kind == kind }?.titles?.firstOrNull { it.key == key } } ?: vm.hero
    val heroIsContinue = hero?.first == "continue" && shown != vm.hero
    // First visit: start focus on the first card of the first loaded row.
    LaunchedEffect(vm.rows) {
        if (restore.value == null) vm.rows.firstOrNull { !it.loading && it.titles.isNotEmpty() }?.let { r ->
            restore.value = "${r.kind}|${r.titles.first().key}"
        }
    }

    Box(Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxWidth().height(300.dp)) {
            Art(shown?.backdrop, "w1280", Modifier.align(Alignment.TopEnd).fillMaxWidth(0.68f).fillMaxHeight())
            Box(Modifier.fillMaxSize().background(Tok.scrimLeft))
            Box(Modifier.fillMaxSize().background(Tok.scrimBottom))
        }
        // D-pad Up/Down moves exactly one row: scroll the target row to the top,
        // then hand focus to the card it last had. Default 2D focus search
        // skipped a half-visible row.
        val visible = vm.rows.filter { it.shown }
        val rowFocus = remember { HashMap<String, FocusRequester>() }
        val scope = rememberCoroutineScope()
        fun moveRow(j: Int): Boolean {
            if (j < 0 || j >= visible.size) return false
            val target = visible[j]
            if (target.loading) return true
            scope.launch {
                listState.scrollToItem(if (j == 0) 0 else j + 1)
                runCatching { rowFocus[target.kind]?.requestFocus() }
            }
            return true
        }
        // One LazyColumn for header and rows, so D-pad Up/Down always walks
        // row by row (a fixed header above a list let Up jump to the nav chips).
        // Vertical moves scroll explicitly (moveRow), so the column itself
        // scrolls only as far as needed: the TV default pivot pushed the title
        // and hero off the top when the first card took focus. Rows keep the
        // default horizontal behaviour.
        val rowScroll = LocalBringIntoViewSpec.current
        CompositionLocalProvider(LocalBringIntoViewSpec provides MinimalScroll) {
        LazyColumn(state = listState, contentPadding = PaddingValues(bottom = 48.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            item(key = "header") {
                // Only the app name at the top. It is not sticky: it scrolls
                // away with the rows. Navigation lives in the side rail.
                Column {
                    Text("Chitram", style = TextStyle(color = Tok.text, fontSize = 26.sp, fontWeight = FontWeight.Bold), modifier = Modifier.padding(start = RAIL_GUTTER, top = 18.dp))
                    Column(Modifier.padding(start = RAIL_GUTTER, top = 14.dp, end = 48.dp).fillMaxWidth(0.55f).height(168.dp)) {
                        shown?.let { t ->
                            Text(t.title, style = TextStyle(color = Tok.text, fontSize = 36.sp, fontWeight = FontWeight.Bold), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(metaLine(t.year, t.rating, langName(t.originalLang)), style = TextStyle(color = Tok.textSecondary, fontSize = 18.sp), modifier = Modifier.padding(vertical = 6.dp))
                            Text(t.overview.orEmpty(), style = TextStyle(color = Tok.textMuted, fontSize = 17.sp, lineHeight = 23.sp), maxLines = if (heroIsContinue) 2 else 3, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
            itemsIndexed(visible, key = { _, r -> r.kind }) { i, row ->
                val fr = rowFocus.getOrPut(row.kind) { FocusRequester() }
                CompositionLocalProvider(LocalBringIntoViewSpec provides rowScroll) {
                    TvRow(row, nav, restore, fr, onFocus = { focused = row.kind to it.key }, onMove = { d -> moveRow(i + d) }, onRetry = { vm.retry(row.kind) })
                }
            }
        }
        }
    }
}

@Composable
@OptIn(ExperimentalComposeUiApi::class)
private fun TvRow(
    row: HomeRow, nav: Nav, restore: androidx.compose.runtime.MutableState<String?>, rowFocus: FocusRequester,
    onFocus: (Title) -> Unit, onMove: (Int) -> Boolean, onRetry: () -> Unit,
) {
    Column {
        Text(row.label, style = TextStyle(color = Tok.text, fontSize = 24.sp, fontWeight = FontWeight.SemiBold), modifier = Modifier.padding(start = RAIL_GUTTER, bottom = 6.dp))
        val wide = row.kind == "continue"
        LazyRow(
            modifier = Modifier
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
            // Room above and below for the focus lift and shadow.
            contentPadding = PaddingValues(start = RAIL_GUTTER, end = 48.dp, top = 12.dp, bottom = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            if (row.error) {
                item { TvChip("Couldn't load this section · Retry", onClick = onRetry) }
            } else if (row.loading) {
                items(6) { Box(Modifier.size(if (wide) 240.dp else POSTER_W, if (wide) 135.dp else POSTER_H).background(Tok.surfaceSolid, Tok.radiusMd)) }
            } else {
                items(row.titles, key = { it.key }) { t ->
                    val rk = "${row.kind}|${t.key}"
                    val fr = remember { FocusRequester() }
                    if (restore.value == rk) LaunchedEffect(rk) { runCatching { fr.requestFocus() } }
                    val open = {
                        restore.value = rk
                        nav.push(Screen.Detail(t.mediaType, t.tmdbId))
                    }
                    val mod = Modifier.focusRequester(fr).onFocusChanged { if (it.isFocused) onFocus(t) }
                    if (wide) WideCard(t, row.progress[t.key], mod, open)
                    else PosterCard(t, mod, rank = if (row.ranked) row.titles.indexOf(t) + 1 else null, onClick = open)
                }
                // "See all" as the last card, like the web rows' link.
                val all = row.seeAll
                if (all != null || row.kind == "list") item(key = "see-all") {
                    val fr = remember { FocusRequester() }
                    if (restore.value == "${row.kind}|see-all") LaunchedEffect(Unit) { runCatching { fr.requestFocus() } }
                    SeeAllCard(Modifier.focusRequester(fr)) {
                        restore.value = "${row.kind}|see-all"
                        nav.push(if (all != null) Screen.Browse(all) else Screen.MyList)
                    }
                }
            }
        }
    }
}

@Composable
fun PosterCard(t: Title, modifier: Modifier = Modifier, rank: Int? = null, showType: Boolean = false, onClick: () -> Unit) {
    Card(
        onClick = onClick,
        modifier = modifier.returnTarget().size(POSTER_W, POSTER_H),
        shape = CardDefaults.shape(Tok.radiusMd),
        scale = CardDefaults.scale(focusedScale = FOCUS_SCALE),
        border = CardDefaults.border(focusedBorder = focusBorder),
        glow = CardDefaults.glow(focusedGlow = focusGlow),
        colors = CardDefaults.colors(containerColor = Tok.surfaceSolid),
    ) {
        Box(Modifier.fillMaxSize()) {
            Art(t.poster, "w342", Modifier.fillMaxSize(), t.title)
            if (t.poster == null) Text(t.title, color = Tok.textSecondary, fontSize = 13.sp, modifier = Modifier.padding(8.dp))
            if (showType && t.mediaType == "tv") Text("Series", color = Tok.text, fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.align(Alignment.TopStart).padding(6.dp).background(Tok.bg.copy(alpha = 0.75f), Tok.radiusMd).padding(horizontal = 6.dp, vertical = 1.dp))
            if (rank != null) Text("$rank", style = TextStyle(color = Color.White, fontSize = 44.sp, fontWeight = FontWeight.Black),
                modifier = Modifier.align(Alignment.BottomStart).padding(start = 8.dp))
        }
    }
}

@Composable
private fun SeeAllCard(modifier: Modifier = Modifier, onClick: () -> Unit) {
    Card(
        onClick = onClick,
        modifier = modifier.returnTarget().size(POSTER_W, POSTER_H),
        shape = CardDefaults.shape(Tok.radiusMd),
        scale = CardDefaults.scale(focusedScale = FOCUS_SCALE),
        border = CardDefaults.border(focusedBorder = focusBorder),
        glow = CardDefaults.glow(focusedGlow = focusGlow),
        colors = CardDefaults.colors(containerColor = Tok.fill1, contentColor = Tok.text, focusedContainerColor = Focus.fill, focusedContentColor = Focus.ink),
    ) {
        Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(Icons.Filled.ChevronRight, null, tint = LocalContentColor.current, modifier = Modifier.size(32.dp))
            Text("See all", fontSize = 17.sp, fontWeight = FontWeight.Medium)
        }
    }
}

@Composable
private fun WideCard(t: Title, p: Progress?, modifier: Modifier, onClick: () -> Unit) {
    Column(modifier.returnTarget().width(240.dp)) {
        Card(
            onClick = onClick,
            modifier = Modifier.size(240.dp, 135.dp),
            shape = CardDefaults.shape(Tok.radiusMd),
            scale = CardDefaults.scale(focusedScale = FOCUS_SCALE),
            border = CardDefaults.border(focusedBorder = focusBorder),
        glow = CardDefaults.glow(focusedGlow = focusGlow),
            colors = CardDefaults.colors(containerColor = Tok.surfaceSolid),
        ) {
            Box(Modifier.fillMaxSize()) {
                Art(t.backdrop ?: t.poster, "w300", Modifier.fillMaxSize(), t.title)
                if (p != null) Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(4.dp).background(Tok.fill3)) {
                    Box(Modifier.fillMaxHeight().fillMaxWidth(p.pct).background(Tok.accent))
                }
            }
        }
        val sub = if (p != null && p.mediaType == "tv") "${t.title} · S${p.season} E${p.episode}" else t.title
        Text(sub, color = Tok.textSecondary, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp))
    }
}

@Composable
private fun TvChip(text: String, selected: Boolean = false, modifier: Modifier = Modifier, icon: ImageVector? = null, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        modifier = modifier.returnTarget(),
        shape = ClickableSurfaceDefaults.shape(Tok.pill),
        // Focus inverts to white with dark ink; selected stays quiet so the
        // two never look alike.
        scale = ClickableSurfaceDefaults.scale(focusedScale = Focus.controlScale),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = if (selected) Focus.selectedFill else Tok.fill2,
            contentColor = Tok.text,
            focusedContainerColor = Focus.fill,
            focusedContentColor = Focus.ink,
        ),
        border = ClickableSurfaceDefaults.border(
            border = if (selected) Border(BorderStroke(1.5.dp, Color.White.copy(alpha = 0.55f)), shape = Tok.pill) else Border.None,
            focusedBorder = Border.None,
        ),
        glow = ClickableSurfaceDefaults.glow(focusedGlow = focusGlow),
    ) {
        Row(Modifier.padding(horizontal = 20.dp, vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
            if (icon != null) Icon(icon, null, Modifier.padding(end = 8.dp).size(20.dp), tint = LocalContentColor.current)
            Text(text, fontSize = 18.sp, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium)
        }
    }
}

@Composable
private fun TvButton(text: String, primary: Boolean, modifier: Modifier = Modifier, icon: ImageVector? = null, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        modifier = modifier.returnTarget(),
        // Focus: white fill, dark ink, lift and shadow. Only focus is white.
        scale = ButtonDefaults.scale(focusedScale = Focus.controlScale),
        colors = ButtonDefaults.colors(
            containerColor = if (primary) Focus.primaryButton else Tok.fill2,
            contentColor = if (primary) Focus.ink else Tok.text,
            focusedContainerColor = Focus.fill,
            focusedContentColor = Focus.ink,
        ),
        // Web .btn.primary:focus keeps its white fill and adds the ring, 3dp out.
        border = if (primary) ButtonDefaults.border(focusedBorder = Border(BorderStroke(Focus.ringWidth, Focus.ring), inset = Focus.ringOffset, shape = Tok.pill)) else ButtonDefaults.border(),
        glow = ButtonDefaults.glow(focusedGlow = focusGlow),
    ) {
        if (icon != null) Icon(icon, null, Modifier.padding(end = 8.dp).size(22.dp), tint = LocalContentColor.current)
        Text(text, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
@OptIn(ExperimentalFoundationApi::class)
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
            Text(vm.error ?: "Loading", color = Tok.textMuted, modifier = Modifier.padding(48.dp))
            return@Box
        }
        val detailList = rememberLazyListState()
        val scope = rememberCoroutineScope()
        // Focus Play, then pin the list to the top: focusing scrolls Play into
        // view and would otherwise clip the title.
        LaunchedEffect(t.tmdbId) { runCatching { playFocus.requestFocus() }; detailList.scrollToItem(0) }
        // Compose's TV default pivots the focused item to 30% of the height,
        // which pushed the title off the top. Scroll only as far as needed and
        // return to the very top when Play takes focus.
        CompositionLocalProvider(LocalBringIntoViewSpec provides MinimalScroll) {
            LazyColumn(state = detailList, contentPadding = PaddingValues(top = 40.dp, bottom = 48.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                item(key = "head") {
                    Column(Modifier.padding(start = 48.dp).fillMaxWidth(0.55f)) {
                        Text(t.title, style = TextStyle(color = Tok.text, fontSize = 34.sp, fontWeight = FontWeight.Bold), maxLines = 2)
                        t.tagline?.takeIf { it.isNotBlank() }?.let { Text(it, color = Tok.textMuted, fontSize = 18.sp, modifier = Modifier.padding(top = 4.dp)) }
                        val extra = listOfNotNull(
                            runtimeText(t.runtimeMin),
                            t.seasons?.takeIf { t.mediaType == "tv" && it > 0 }?.let { "$it season${if (it == 1) "" else "s"}" },
                            langName(t.originalLang),
                        ).joinToString("  ·  ")
                        Text(metaLine(t.year, t.rating, extra.ifEmpty { null }), color = Tok.textSecondary, fontSize = 18.sp, modifier = Modifier.padding(vertical = 8.dp))
                        if (t.genres.isNotEmpty()) Text(t.genres.joinToString(" · "), color = Tok.textMuted, fontSize = 16.sp)
                        Text(t.overview.orEmpty(), color = Tok.textSecondary, fontSize = 18.sp, lineHeight = 25.sp, maxLines = 4, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 12.dp))
                    }
                }
                item(key = "actions") {
                    Row(Modifier.padding(start = 48.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
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
                        Column {
                            TvSection("Episodes")
                            val seasons = t.seasonList.filter { it.number > 0 }
                            if (seasons.size > 1) LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(horizontal = 48.dp)) {
                                items(seasons, key = { it.number }) { s ->
                                    TvChip(s.name.ifEmpty { "Season ${s.number}" }, selected = s.number == vm.season) { vm.selectSeason(s.number) }
                                }
                            }
                        }
                    }
                    item(key = "episodes") {
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(16.dp), contentPadding = PaddingValues(horizontal = 48.dp, vertical = 6.dp)) {
                            if (vm.episodesLoading) items(5) { Box(Modifier.size(240.dp, 135.dp).background(Tok.surfaceSolid, Tok.radiusMd)) }
                            else items(vm.episodes, key = { "${it.season}-${it.episode}" }) { ep ->
                                val p = vm.episodeProgress(ep)
                                val r = vm.resume
                                val isNext = r != null && r.season == ep.season && r.episode == ep.episode
                                Column(Modifier.width(240.dp)) {
                                    Card(
                                        onClick = { vm.playRequest(ep)?.let { nav.push(Screen.Player(it)) } },
                                        modifier = Modifier.size(240.dp, 135.dp),
                                        shape = CardDefaults.shape(Tok.radiusMd),
                                        scale = CardDefaults.scale(focusedScale = FOCUS_SCALE),
                                        border = CardDefaults.border(focusedBorder = focusBorder),
        glow = CardDefaults.glow(focusedGlow = focusGlow),
                                        colors = CardDefaults.colors(containerColor = Tok.surfaceSolid),
                                    ) {
                                        Box(Modifier.fillMaxSize()) {
                                            Art(ep.still, "w300", Modifier.fillMaxSize())
                                            Text("E${ep.episode}", color = Tok.text, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                                                modifier = Modifier.padding(6.dp).background(Tok.bg.copy(alpha = 0.7f), Tok.radiusMd).padding(horizontal = 6.dp, vertical = 1.dp))
                                            if (p != null) Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(4.dp).background(Tok.fill3)) {
                                                Box(Modifier.fillMaxHeight().fillMaxWidth(if (p.finished) 1f else p.pct).background(Tok.accent))
                                            }
                                        }
                                    }
                                    Text(ep.title.ifEmpty { "Episode ${ep.episode}" }, color = Tok.text, fontSize = 17.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp))
                                    val meta = listOfNotNull(if (isNext) "Next up" else null, ep.runtimeMin?.let { "$it min" }, if (p?.finished == true) "Watched" else null).joinToString(" · ")
                                    if (meta.isNotEmpty()) Text(meta, color = if (isNext) Tok.accent else Tok.textMuted, fontSize = 15.sp)
                                    ep.overview?.let { Text(it, color = Tok.textMuted, fontSize = 14.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp)) }
                                }
                            }
                        }
                    }
                }
                if (t.credits.isNotEmpty()) item(key = "cast") {
                    Column {
                        TvSection("Cast")
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(18.dp), contentPadding = PaddingValues(horizontal = 48.dp, vertical = 6.dp)) {
                            items(t.credits, key = { it.id }) { c -> TvCastCard(c) { nav.push(Screen.Person(c.id, c.name)) } }
                        }
                    }
                }
                val sim = vm.similar
                if (sim == null || sim.isNotEmpty()) item(key = "similar") {
                    Column {
                        TvSection("More like this")
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(16.dp), contentPadding = PaddingValues(horizontal = 48.dp, vertical = 6.dp)) {
                            if (sim == null) items(6) { Box(Modifier.size(POSTER_W, POSTER_H).background(Tok.surfaceSolid, Tok.radiusMd)) }
                            else items(sim, key = { it.key }) { s -> PosterCard(s) { nav.push(Screen.Detail(s.mediaType, s.tmdbId)) } }
                        }
                    }
                }
                item(key = "facts") {
                    val facts = listOf("Director" to t.director, "Writers" to t.writers, "Country" to t.country).filter { it.second.isNotEmpty() }
                    if (facts.isNotEmpty()) Row(Modifier.padding(horizontal = 48.dp), horizontalArrangement = Arrangement.spacedBy(40.dp)) {
                        facts.forEach { (k, v) ->
                            Column { Text(k, color = Tok.textMuted, fontSize = 15.sp); Text(v.joinToString(", "), color = Tok.textSecondary, fontSize = 17.sp) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun TvSection(label: String) {
    Text(label, style = TextStyle(color = Tok.text, fontSize = 22.sp, fontWeight = FontWeight.SemiBold), modifier = Modifier.padding(start = 48.dp, bottom = 10.dp))
}

@Composable
private fun TvCastCard(c: Credit, onClick: () -> Unit) {
    Column(Modifier.width(124.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Surface(
            onClick = onClick,
            modifier = Modifier.size(96.dp),
            shape = ClickableSurfaceDefaults.shape(CircleShape),
            scale = ClickableSurfaceDefaults.scale(focusedScale = FOCUS_SCALE),
            border = ClickableSurfaceDefaults.border(focusedBorder = Border(BorderStroke(Focus.ringWidth, Focus.ring), shape = CircleShape)),
            glow = ClickableSurfaceDefaults.glow(focusedGlow = focusGlow),
            colors = ClickableSurfaceDefaults.colors(containerColor = Tok.surfaceSolid, focusedContainerColor = Tok.surfaceSolid),
        ) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                if (c.profile != null) Art(c.profile, "w185", Modifier.fillMaxSize().clip(CircleShape), c.name)
                else Text(c.name.take(1), color = Tok.textSecondary, fontSize = 30.sp)
            }
        }
        Text(c.name, color = Tok.text, fontSize = 16.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp))
        c.character?.let { Text(it, color = Tok.textMuted, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
    }
}

private fun LazyGridScope.full(key: String, content: @Composable () -> Unit) =
    item(key = key, span = { GridItemSpan(maxLineSpan) }) { content() }

@Composable
private fun TvPerson(nav: Nav, id: Long, name: String) {
    val vm: PersonVm = viewModel(key = "person-$id")
    LaunchedEffect(id) { vm.load(id) }
    val d = vm.data
    val first = remember { FocusRequester() }
    LaunchedEffect(d) { if (d?.titles?.isNotEmpty() == true) { withFrameNanos { }; runCatching { first.requestFocus() } } }
    LazyVerticalGrid(
        GridCells.Adaptive(POSTER_W), Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 48.dp, end = 48.dp, top = 32.dp, bottom = 32.dp),
        horizontalArrangement = Arrangement.spacedBy(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        full("head") {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 12.dp)) {
                val p = d?.person
                Box(Modifier.size(110.dp).clip(CircleShape).background(Tok.surfaceSolid), contentAlignment = Alignment.Center) {
                    if (p?.profile != null) Art(p.profile, "w185", Modifier.fillMaxSize(), p.name)
                    else Text((p?.name ?: name).take(1), color = Tok.textSecondary, fontSize = 36.sp)
                }
                Column(Modifier.padding(start = 24.dp)) {
                    Text(p?.name ?: name, style = TextStyle(color = Tok.text, fontSize = 30.sp, fontWeight = FontWeight.Bold))
                    p?.knownFor?.let { Text(it, color = Tok.textMuted, fontSize = 18.sp) }
                    when {
                        d == null -> Text("Loading", color = Tok.textMuted)
                        d.person == null -> Text("That profile is not in the catalog.", color = Tok.textMuted)
                        d.titles.isEmpty() -> Text("No titles to show.", color = Tok.textMuted)
                        else -> Text("Known for", color = Tok.textSecondary, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 12.dp))
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
        GridCells.Adaptive(POSTER_W), Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = RAIL_GUTTER, end = 48.dp, top = 28.dp, bottom = 32.dp),
        horizontalArrangement = Arrangement.spacedBy(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        full("head") {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Browse", style = TextStyle(color = Tok.text, fontSize = 32.sp, fontWeight = FontWeight.Bold), modifier = Modifier.padding(end = 20.dp))
                    Text(listOfNotNull(vm.total?.let { "%,d titles".format(it) }).joinToString(), color = Tok.textMuted, fontSize = 17.sp)
                }
                TvFilterRow("Type", listOf("movie" to "Movies", "tv" to "Series"), { it == f.type }) { vm.set(f.copy(type = it)) }
                TvFilterRow("Language", LanguagePrefs.LANGS.map { it.code to it.label }, { it in f.langs }) { c -> vm.set(f.copy(langs = if (c in f.langs) f.langs - c else f.langs + c)) }
                TvFilterRow("Genre", BrowseOptions.GENRES.map { it.id to it.name }, { it in f.genres }) { g -> vm.set(f.copy(genres = if (g in f.genres) f.genres - g else f.genres + g)) }
                TvFilterRow("Decade", BrowseOptions.DECADES.map { it.id to it.name }, { it == f.decade }) { d -> vm.set(f.copy(decade = if (f.decade == d) null else d)) }
                TvFilterRow("Rating", BrowseOptions.RATINGS.map { it to "★ $it+" }, { it == f.minRating }) { r -> vm.set(f.copy(minRating = if (f.minRating == r) null else r)) }
                TvFilterRow("Sort", BrowseOptions.SORTS.map { it.id to it.name }, { it == f.sort }) { vm.set(f.copy(sort = it)) }
                vm.error?.let { Text(it, color = Tok.danger) }
                if (!vm.loading && vm.titles.isEmpty() && vm.total != null) Text("No titles match those filters. Try removing a filter.", color = Tok.textMuted)
            }
        }
        gridItemsIndexed(vm.titles, key = { _, t -> t.key }) { i, t ->
            // Nearing the end loads the next page.
            if (i >= vm.titles.size - 6) LaunchedEffect(vm.titles.size) { vm.loadMore() }
            PosterCard(t, showType = true) { nav.push(Screen.Detail(t.mediaType, t.tmdbId)) }
        }
        if (vm.loading) items(if (vm.titles.isEmpty()) 12 else 6, key = { "sk$it" }) { Box(Modifier.size(POSTER_W, POSTER_H).background(Tok.surfaceSolid, Tok.radiusMd)) }
    }
}

@Composable
private fun <T> TvFilterRow(label: String, opts: List<Pair<T, String>>, on: (T) -> Boolean, pick: (T) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = Tok.textMuted, fontSize = 17.sp, modifier = Modifier.width(110.dp))
        LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(vertical = 6.dp, horizontal = 4.dp)) {
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
    LaunchedEffect(Unit) { runCatching { field.requestFocus() } }
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
    Column(Modifier.fillMaxSize().padding(start = RAIL_GUTTER, end = 48.dp, top = 32.dp)) {
        var fieldFocused by remember { mutableStateOf(false) }
        BasicTextField(
            value = vm.query,
            onValueChange = { vm.onQuery(it); toResults = false },
            singleLine = true,
            textStyle = TextStyle(color = Tok.text, fontSize = 22.sp),
            cursorBrush = SolidColor(Color.White),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            // The IME action closes the keyboard and moves to the first result.
            // While the keyboard is open it keeps D-pad Down for itself.
            keyboardActions = KeyboardActions(onSearch = { goToResults() }, onDone = { goToResults() }, onGo = { goToResults() }),
            modifier = Modifier
                .fillMaxWidth(0.6f)
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
                Box(
                    Modifier.background(Tok.surfaceSolid, Tok.pill)
                        .border(Focus.ringWidth, if (fieldFocused) Focus.ring else Tok.border, Tok.pill)
                        .padding(horizontal = 20.dp, vertical = 12.dp),
                ) {
                    if (vm.query.isEmpty()) Text("Search movies and shows", color = Tok.textDim, fontSize = 22.sp)
                    inner()
                }
            },
        )
        Spacer(Modifier.height(20.dp))
        when {
            vm.error != null -> Text(vm.error!!, color = Tok.danger)
            vm.loading && vm.results.isEmpty() -> Text("Searching", color = Tok.textMuted)
            vm.query.length >= 2 && vm.results.isEmpty() && !vm.loading -> Text("No results for \"${vm.query}\"", color = Tok.textMuted)
            vm.results.isNotEmpty() -> Text("${vm.results.size} results for “${vm.resultsFor}”", color = Tok.textMuted, fontSize = 17.sp)
            vm.query.isBlank() -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (vm.recent.isNotEmpty()) {
                    Text("Recent", color = Tok.textSecondary, fontSize = 19.sp, fontWeight = FontWeight.SemiBold)
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(6.dp)) {
                        items(vm.recent, key = { it }) { q -> TvChip(q, icon = Icons.Filled.Search) { vm.onQuery(q); vm.submit(); toResults = true } }
                        item(key = "clear") { TvChip("Clear") { vm.clearRecent() } }
                    }
                }
                Text("Browse instead", color = Tok.textSecondary, fontSize = 19.sp, fontWeight = FontWeight.SemiBold)
                LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(6.dp)) {
                    items(TV_SUGGEST, key = { it.first }) { (label, f) -> TvChip(label) { nav.push(Screen.Browse(f)) } }
                }
            }
        }
        LazyVerticalGrid(GridCells.Adaptive(POSTER_W), state = grid, horizontalArrangement = Arrangement.spacedBy(14.dp), verticalArrangement = Arrangement.spacedBy(18.dp), contentPadding = PaddingValues(vertical = 12.dp, horizontal = 6.dp)) {
            gridItemsIndexed(vm.results, key = { _, t -> t.key }) { i, t ->
                PosterCard(t, if (i == 0) Modifier.focusRequester(firstCard) else Modifier, showType = true) { vm.remember(); nav.push(Screen.Detail(t.mediaType, t.tmdbId)) }
            }
        }
    }
}

@Composable
private fun TvGrid(nav: Nav, title: String, titles: List<Title>, empty: String) {
    Column(Modifier.fillMaxSize().padding(start = RAIL_GUTTER, end = 48.dp, top = 32.dp)) {
        Text(title, style = TextStyle(color = Tok.text, fontSize = 32.sp, fontWeight = FontWeight.Bold), modifier = Modifier.padding(bottom = 20.dp))
        if (titles.isEmpty()) Text(empty, color = Tok.textMuted)
        LazyVerticalGrid(GridCells.Adaptive(POSTER_W), horizontalArrangement = Arrangement.spacedBy(14.dp), verticalArrangement = Arrangement.spacedBy(18.dp), contentPadding = PaddingValues(vertical = 12.dp, horizontal = 6.dp)) {
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
    LaunchedEffect(Unit) { runCatching { first.requestFocus() } }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(Modifier.background(Tok.surface, Tok.radiusLg).padding(40.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("Your languages", style = TextStyle(color = Tok.text, fontSize = 30.sp, fontWeight = FontWeight.Bold))
            Text("Pick the languages you watch.", color = Tok.textMuted, modifier = Modifier.padding(top = 6.dp, bottom = 24.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                LanguagePrefs.LANGS.forEachIndexed { i, l ->
                    val on = l.code in chosen
                    TvChip(if (on) "✓ ${l.label}" else l.label, selected = on, modifier = if (i == 0) Modifier.focusRequester(first) else Modifier) {
                        if (on) chosen.remove(l.code) else chosen.add(l.code)
                    }
                }
            }
            Spacer(Modifier.height(28.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                TvButton(if (chosen.isEmpty()) "Done" else "Done (${chosen.size})", primary = true) {
                    prefs.save(chosen.toList()); onDone()
                }
                if (firstRun) TvButton("Skip", primary = false) { prefs.save(emptyList()); onDone() }
            }
        }
    }
}

/** Scroll only as far as needed to show the focused item (the phone default). */
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

private data class RailDest(val screen: Screen, val label: String, val icon: ImageVector)

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
 * Left side rail (Netflix / Hotstar style). Collapsed it shows icons only and
 * its width is reserved, so it never covers a poster. When it takes D-pad
 * focus it opens to icon + label over a scrim and enters on the current
 * destination. Right, or picking a destination, hands focus back to content.
 */
@Composable
@OptIn(ExperimentalComposeUiApi::class)
private fun TvRail(nav: Nav, top: Screen) {
    var open by remember { mutableStateOf(false) }
    val width by animateDpAsState(if (open) RAIL_OPEN_W else RAIL_W, label = "rail")
    val current = RAIL.indexOfFirst { it.matches(top) }.coerceAtLeast(0)
    val reqs = remember { List(RAIL.size) { FocusRequester() } }
    val scope = rememberCoroutineScope()
    val last = LocalLastFocus.current
    val focusManager = LocalFocusManager.current
    // Back to the item that had focus before the rail; if it is gone (a new
    // screen), the nearest item to the right.
    fun toContent() {
        last.value?.let { runCatching { it.requestFocus() } }
        scope.launch { withFrameNanos { }; if (open) focusManager.moveFocus(FocusDirection.Right) }
    }
    if (open) Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(0f to Tok.bg.copy(alpha = 0.9f), 0.45f to Tok.bg.copy(alpha = 0.55f), 1f to Color.Transparent)))
    Column(
        Modifier.fillMaxHeight().width(width)
            .background(if (open) Brush.horizontalGradient(listOf(Tok.surfaceSolid, Tok.bg)) else Brush.horizontalGradient(listOf(Tok.bg, Tok.bg)))
            .onFocusChanged { open = it.hasFocus }
            .focusProperties { enter = { reqs[current] } }
            .focusGroup()
            .onPreviewKeyEvent { e ->
                if (e.type == KeyEventType.KeyDown && e.key == Key.DirectionRight) { toContent(); true } else false
            }
            .padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterVertically),
    ) {
        RAIL.forEachIndexed { i, d ->
            RailButton(d, selected = i == current, open = open, modifier = Modifier.focusRequester(reqs[i])) {
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

@Composable
private fun RailButton(d: RailDest, selected: Boolean, open: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val src = remember { MutableInteractionSource() }
    val focused by src.collectIsFocusedAsState()
    Surface(
        onClick = onClick,
        modifier = modifier.fillMaxWidth().height(54.dp),
        shape = ClickableSurfaceDefaults.shape(Tok.radiusMd),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1f),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = Color.Transparent,
            contentColor = if (selected) Color.White else Tok.textMuted,
            focusedContainerColor = Focus.fill,
            focusedContentColor = Focus.ink,
        ),
        glow = ClickableSurfaceDefaults.glow(focusedGlow = focusGlow),
        interactionSource = src,
    ) {
        Box(Modifier.fillMaxSize()) {
            // Current destination: a short white bar and white text, like the
            // web's active tab. White is the only focus and selection colour.
            if (selected && !focused) Box(Modifier.align(Alignment.CenterStart).width(3.dp).height(22.dp).background(Color.White, Tok.pill))
            Row(Modifier.fillMaxSize().padding(start = 15.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(d.icon, contentDescription = d.label, tint = LocalContentColor.current, modifier = Modifier.size(26.dp))
                if (open) Text(d.label, fontSize = 20.sp, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium, maxLines = 1, modifier = Modifier.padding(start = 18.dp))
            }
        }
    }
}

/** The content item that last had focus, so Right from the rail returns to it. */
private val LocalLastFocus = staticCompositionLocalOf { mutableStateOf<FocusRequester?>(null) }

/** Marks a focusable as a place the rail can hand focus back to. */
@Composable
private fun Modifier.returnTarget(): Modifier {
    val me = remember { FocusRequester() }
    val last = LocalLastFocus.current
    return this.focusRequester(me).onFocusChanged { if (it.isFocused) last.value = me }
}
