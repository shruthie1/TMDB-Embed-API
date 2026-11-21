package com.chitram.app.ui.phone

import android.content.res.Configuration
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsTopHeight
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsBottomHeight
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridScope
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.BookmarkBorder
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Replay
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.Translate
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.BiasAlignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.chitram.app.App
import com.chitram.app.ui.common.prefetchArt
import com.chitram.app.data.BrowseFilters
import com.chitram.app.data.BrowseOptions
import com.chitram.app.data.Credit
import com.chitram.app.data.Episode
import com.chitram.app.data.LanguagePrefs
import com.chitram.app.data.Progress
import com.chitram.app.data.Title
import com.chitram.app.ui.common.Art
import com.chitram.app.ui.common.BrowseVm
import com.chitram.app.ui.common.DetailVm
import com.chitram.app.ui.common.HomeVm
import com.chitram.app.ui.common.Nav
import com.chitram.app.ui.common.PersonVm
import com.chitram.app.ui.common.PlayerScreen
import com.chitram.app.ui.common.Row as HomeRow
import com.chitram.app.ui.common.Screen
import com.chitram.app.ui.common.SearchVm
import com.chitram.app.ui.common.Tok
import com.chitram.app.ui.common.Focus
import com.chitram.app.ui.common.langName
import com.chitram.app.ui.common.runtimeText
import kotlinx.coroutines.delay

private val GUTTER = 16.dp
private val CARD_W = 112.dp

@Composable
fun PhoneApp(nav: Nav) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Color.White, onPrimary = Tok.bg, background = Tok.bg, onBackground = Tok.text,
            surface = Tok.bg, onSurface = Tok.text, surfaceVariant = Tok.surface, onSurfaceVariant = Tok.textMuted,
            secondaryContainer = Tok.fill2, onSecondaryContainer = Tok.text, outline = Tok.border,
            surfaceContainerLow = Tok.surfaceSolid, surfaceContainer = Tok.surfaceSolid,
        ),
    ) {
        BackHandler(enabled = nav.stack.size > 1) { nav.pop() }
        val top = nav.top
        if (top is Screen.Player) {
            PlayerScreen(top.req, isTv = false, onBack = { nav.pop() })
            return@MaterialTheme
        }
        val homeList = rememberLazyListState()
        val showBar = top == Screen.Home || top == Screen.Search || top == Screen.MyList || top is Screen.Browse || (top is Screen.Langs && !top.firstRun)
        // Edge to edge: each screen owns its top inset (the backdrop runs under
        // the status bar). Scaffold adds none, so nothing is padded twice.
        Scaffold(
            containerColor = Tok.bg,
            contentWindowInsets = WindowInsets(0),
            bottomBar = {
                if (showBar) NavigationBar(containerColor = Tok.bg.copy(alpha = 0.97f), tonalElevation = 0.dp) {
                    listOf(
                        Tab(Screen.Home, "Home", Icons.Filled.Home, Icons.Outlined.Home),
                        Tab(Screen.Search, "Search", Icons.Filled.Search, Icons.Outlined.Search),
                        Tab(Screen.Browse(), "Browse", Icons.Filled.Tune, Icons.Filled.Tune),
                        Tab(Screen.MyList, "My list", Icons.Filled.Bookmark, Icons.Filled.BookmarkBorder),
                        Tab(Screen.Langs(false), "Languages", Icons.Filled.Translate, Icons.Filled.Translate),
                    ).forEach { tab ->
                        val on = when (tab.screen) {
                            is Screen.Browse -> top is Screen.Browse
                            is Screen.Langs -> top is Screen.Langs
                            else -> top == tab.screen
                        }
                        NavigationBarItem(
                            selected = on, onClick = { if (!on) nav.tab(tab.screen) },
                            icon = { Icon(if (on) tab.on else tab.off, contentDescription = tab.label) }, label = { Text(tab.label, fontSize = 11.sp, lineHeight = 13.sp, maxLines = 1, softWrap = false) },
                            // Web .tab.on: white icon and label, no coloured pill. White is
                            // the one selection colour, as on chips and TV focus.
                            colors = NavigationBarItemDefaults.colors(selectedIconColor = Color.White, indicatorColor = Color.Transparent, unselectedIconColor = Tok.textMuted, unselectedTextColor = Tok.textMuted, selectedTextColor = Color.White),
                        )
                    }
                }
            },
        ) { pad ->
            Box(Modifier.fillMaxSize().padding(bottom = pad.calculateBottomPadding()).background(Tok.bg)) {
                when (top) {
                    Screen.Home -> PhoneHome(nav, homeList)
                    Screen.Search -> PhoneSearch(nav)
                    Screen.MyList -> PhoneMyList(nav)
                    is Screen.Browse -> PhoneBrowse(nav, top.initial)
                    is Screen.Langs -> PhoneLangs(top.firstRun) { if (top.firstRun) nav.replaceAll(Screen.Home) else nav.pop() }
                    is Screen.Detail -> PhoneDetail(nav, top.type, top.id, top.poster)
                    is Screen.Person -> PhonePerson(nav, top.id, top.name)
                    is Screen.Player -> Unit
                }
            }
        }
    }
}

private data class Tab(val screen: Screen, val label: String, val on: ImageVector, val off: ImageVector)

private fun Nav.open(t: Title) {
    // The detail header shows the poster (w342) and backdrop (w780) only after
    // the title API answers, which takes seconds. Fetch both now, at the same
    // URLs, so they are cache hits by then. A title opened from the hero has
    // only its backdrop cached, which is why the small poster used to lag.
    prefetchArt(App.instance, t.poster to "w342", t.backdrop to "w780")
    push(Screen.Detail(t.mediaType, t.tmdbId, t.poster))
}

// ---- Home -------------------------------------------------------------------

@Composable
private fun PhoneHome(nav: Nav, listState: LazyListState) {
    val vm: HomeVm = viewModel()
    LaunchedEffect(Unit) { vm.load() }
    val shown = vm.rows.filter { it.shown }
    Box(Modifier.fillMaxSize()) {
        LazyColumn(state = listState, contentPadding = PaddingValues(bottom = 48.dp), verticalArrangement = Arrangement.spacedBy(22.dp)) {
            item(key = "hero") { Box { HeroCarousel(vm.heroTitles, nav); HomeHeader(nav) } }
            items(shown, key = { it.kind }) { row -> PhoneRow(row, nav, onRetry = { vm.retry(row.kind) }) }
        }
        // Once the hero scrolls away, a solid strip keeps the status bar readable.
        val scrolled by remember { derivedStateOf { listState.firstVisibleItemIndex > 0 || listState.firstVisibleItemScrollOffset > 300 } }
        if (scrolled) Spacer(Modifier.fillMaxWidth().background(Tok.bg).windowInsetsTopHeight(WindowInsets.statusBars))
    }
}

/** Only the app name, over the hero, below the status bar. It scrolls away with the hero; Languages is a bottom tab. */
@Composable
private fun HomeHeader(nav: Nav) {
    Row(
        Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Tok.bg.copy(alpha = 0.75f), Color.Transparent)))
            .statusBarsPadding().padding(start = GUTTER, end = 4.dp, top = 4.dp, bottom = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Chitram", fontSize = 22.sp, fontWeight = FontWeight.Bold, color = Tok.text, modifier = Modifier.weight(1f).padding(vertical = 12.dp))
    }
}

/** Web Hero: up to 6 titles, swipe, auto-advance every 8 s, dots. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun HeroCarousel(titles: List<Title>?, nav: Nav) {
    val mod = Modifier.fillMaxWidth().aspectRatio(0.8f)
    if (titles == null) {
        Box(mod.background(Tok.surfaceSolid))
        return
    }
    if (titles.isEmpty()) { Spacer(Modifier.statusBarsPadding().height(56.dp)); return }
    val pager = rememberPagerState { titles.size }
    LaunchedEffect(pager.currentPage, pager.isScrollInProgress, titles.size) {
        if (titles.size < 2 || pager.isScrollInProgress) return@LaunchedEffect
        delay(8000)
        pager.animateScrollToPage((pager.currentPage + 1) % titles.size)
    }
    val myList = App.instance.myList
    Box(mod) {
        HorizontalPager(pager, Modifier.fillMaxSize(), key = { titles[it].key }) { i ->
            val t = titles[i]
            Box(Modifier.fillMaxSize().clickable { nav.open(t) }) {
                Art(t.backdrop, "w780", Modifier.fillMaxSize(), alignment = BiasAlignment(0f, -0.6f))
                Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.35f to Color.Transparent, 0.75f to Tok.bg.copy(alpha = 0.75f), 1f to Tok.bg)))
                Column(Modifier.align(Alignment.BottomStart).padding(start = GUTTER, end = GUTTER, bottom = 34.dp)) {
                    Text(t.title, fontSize = 30.sp, lineHeight = 34.sp, fontWeight = FontWeight.Bold, color = Tok.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    MetaRow(t.year, null, t.rating, t.originalLang, Modifier.padding(top = 8.dp))
                    t.overview?.let { Text(it, color = Tok.textSecondary, fontSize = 14.sp, lineHeight = 20.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp)) }
                    Row(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Button(onClick = { nav.open(t) }, modifier = Modifier.weight(1f), colors = ButtonDefaults.buttonColors(containerColor = Color.White, contentColor = Tok.bg)) {
                            Icon(Icons.Filled.PlayArrow, null, Modifier.size(20.dp)); Spacer(Modifier.width(6.dp)); Text("Watch now", fontWeight = FontWeight.SemiBold)
                        }
                        var saved by remember(t.key) { mutableStateOf(myList.contains(t)) }
                        OutlinedButton(onClick = { saved = myList.toggle(t) }, border = androidx.compose.foundation.BorderStroke(1.dp, Tok.border)) {
                            Icon(if (saved) Icons.Filled.Check else Icons.Filled.Add, null, Modifier.size(18.dp), tint = Tok.text)
                            Spacer(Modifier.width(6.dp)); Text("My List", color = Tok.text)
                        }
                    }
                }
            }
        }
        if (titles.size > 1) Row(Modifier.align(Alignment.BottomStart).padding(start = GUTTER, bottom = 14.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            repeat(titles.size) { k ->
                Box(Modifier.height(4.dp).width(if (k == pager.currentPage) 22.dp else 10.dp).background(if (k == pager.currentPage) Tok.text else Tok.fill3, Tok.pill))
            }
        }
    }
}

@Composable
private fun MetaRow(year: Int?, runtimeMin: Int?, rating: Double?, lang: String?, modifier: Modifier = Modifier) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        year?.let { Text("$it", color = Tok.textSecondary, fontSize = 13.sp) }
        runtimeText(runtimeMin)?.let { Text(it, color = Tok.textSecondary, fontSize = 13.sp) }
        rating?.takeIf { it > 0 }?.let {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.Star, null, Modifier.size(14.dp), tint = Color(0xFFF5C518))
                Text(" %.1f".format(it), color = Tok.textSecondary, fontSize = 13.sp)
            }
        }
        langName(lang)?.let { Badge(it) }
    }
}

@Composable
private fun Badge(text: String) {
    Text(text, color = Tok.text, fontSize = 11.sp, fontWeight = FontWeight.Medium,
        modifier = Modifier.border(1.dp, Tok.fill3, RoundedCornerShape(6.dp)).padding(horizontal = 6.dp, vertical = 1.dp))
}

@Composable
private fun RowHeader(label: String, onSeeAll: (() -> Unit)? = null, action: String = "See all") {
    Row(Modifier.fillMaxWidth().padding(start = GUTTER, end = 4.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = Tok.text, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (onSeeAll != null) TextButton(onClick = onSeeAll, contentPadding = PaddingValues(horizontal = 12.dp)) {
            Text(action, color = Tok.textMuted, fontSize = 13.sp)
            Icon(Icons.Filled.ChevronRight, null, Modifier.size(16.dp), tint = Tok.textMuted)
        }
    }
}

@Composable
private fun PhoneRow(row: HomeRow, nav: Nav, onRetry: () -> Unit) {
    Column {
        val seeAll: (() -> Unit)? = when {
            row.kind == "list" -> ({ nav.tab(Screen.MyList) })
            row.seeAll != null && !row.loading && !row.error -> ({ nav.push(Screen.Browse(row.seeAll)) })
            else -> null
        }
        RowHeader(row.label, seeAll)
        if (row.error) {
            Row(Modifier.padding(horizontal = GUTTER), verticalAlignment = Alignment.CenterVertically) {
                Text("Couldn't load this section.", color = Tok.textMuted, fontSize = 14.sp)
                TextButton(onClick = onRetry) { Text("Retry", color = Color.White) }
            }
            return@Column
        }
        LazyRow(contentPadding = PaddingValues(horizontal = GUTTER), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (row.loading) items(6) { CardSkeleton(CARD_W) }
            else itemsIndexed(row.titles, key = { _, t -> t.key }) { i, t ->
                PosterCard(t, Modifier.width(CARD_W), progress = row.progress[t.key], rank = if (row.ranked) i + 1 else null) { nav.open(t) }
            }
        }
    }
}

@Composable
private fun CardSkeleton(width: Dp) {
    Column(Modifier.width(width)) {
        Box(Modifier.fillMaxWidth().aspectRatio(2f / 3f).background(Tok.surfaceSolid, Tok.radiusMd))
        Box(Modifier.padding(top = 8.dp).fillMaxWidth(0.8f).height(10.dp).background(Tok.fill1, Tok.pill))
        Box(Modifier.padding(top = 6.dp).fillMaxWidth(0.4f).height(8.dp).background(Tok.fill1, Tok.pill))
    }
}

/**
 * Web Card: poster, title, a meta line (year, or S/E for Continue watching),
 * progress bar, Top 10 rank, and a Series tag in mixed grids.
 */
@Composable
private fun PosterCard(t: Title, modifier: Modifier = Modifier, progress: Progress? = null, rank: Int? = null, showType: Boolean = false, onClick: () -> Unit) {
    Column(modifier.clickable(onClick = onClick)) {
        Box(Modifier.fillMaxWidth().aspectRatio(2f / 3f).clip(Tok.radiusMd)) {
            Art(t.poster, "w342", Modifier.fillMaxSize(), t.title)
            if (t.poster == null) Text(t.title, color = Tok.textSecondary, fontSize = 12.sp, modifier = Modifier.padding(8.dp))
            if (showType && t.mediaType == "tv") Text("Series", color = Tok.text, fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.align(Alignment.TopStart).padding(6.dp).background(Tok.bg.copy(alpha = 0.75f), RoundedCornerShape(4.dp)).padding(horizontal = 5.dp, vertical = 1.dp))
            if (rank != null) Text("$rank", color = Color.White, fontSize = 40.sp, fontWeight = FontWeight.Black, lineHeight = 40.sp,
                modifier = Modifier.align(Alignment.BottomStart).padding(start = 6.dp, bottom = 2.dp))
            if (progress != null) Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(3.dp).background(Tok.fill3)) {
                Box(Modifier.fillMaxHeight().fillMaxWidth(progress.pct).background(Tok.accent))
            }
        }
        Text(t.title, color = Tok.text, fontSize = 12.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
        val meta = if (progress != null && progress.mediaType == "tv") "S${progress.season} E${progress.episode}" + (progress.epTitle?.let { " · $it" } ?: "")
            else t.year?.toString() ?: ""
        Text(meta, color = Tok.textMuted, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

// ---- Detail -----------------------------------------------------------------

@Composable
private fun BackButton(onClick: () -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier.clip(Tok.pill).background(Tok.bg.copy(alpha = 0.55f)).clickable(onClick = onClick).padding(start = 10.dp, end = 14.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = Tok.text, modifier = Modifier.size(20.dp))
        Text("Back", color = Tok.text, fontSize = 14.sp, modifier = Modifier.padding(start = 6.dp))
    }
}

@Composable
private fun PhoneDetail(nav: Nav, type: String, id: Long, rowPoster: String? = null) {
    val vm: DetailVm = viewModel(key = "detail-$type-$id")
    LaunchedEffect(type, id) { vm.load(type, id) }
    var toast by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(toast) { if (toast != null) { delay(2200); toast = null } }
    val t = vm.full
    // Detail -> Detail (a related card) stays in the same composable slot; key the
    // list state to the title so the new title opens at the top.
    val detailList = key(type, id) { rememberLazyListState() }
    val pastArt by remember(detailList) { derivedStateOf { detailList.firstVisibleItemIndex > 0 || detailList.firstVisibleItemScrollOffset > 420 } }
    Box(Modifier.fillMaxSize()) {
        if (t == null) {
            Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                if (vm.error == null) CircularProgressIndicator(color = Tok.accent, strokeWidth = 3.dp)
                else {
                    Text(vm.error!!, color = Tok.textMuted)
                    TextButton(onClick = { vm.retry() }) { Text("Try again", color = Color.White) }
                }
            }
        } else LazyColumn(state = detailList, contentPadding = PaddingValues(bottom = 48.dp)) {
            item(key = "art") {
                // Backdrop runs under the status bar; poster and title sit on its fade.
                BoxWithConstraints(Modifier.fillMaxWidth()) {
                    // Landscape: a 16:9 backdrop of the full width is taller than the screen,
                    // so cap it to 45% of screen height; title and Play then show without scrolling.
                    val cfg = LocalConfiguration.current
                    val wideArtH = maxWidth * 9f / 16f + 40.dp
                    val artH = if (cfg.orientation == Configuration.ORIENTATION_LANDSCAPE) wideArtH.coerceAtMost(cfg.screenHeightDp.dp * 0.45f) else wideArtH
                    // The art starts below the status bar, so faces at the top of the
                    // backdrop are not hidden under the clock or the Back button.
                    val topInset = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
                    // The art sits 15% of its height lower (owner, 2026-11-20, same as
                    // the web detail hero). The strip above is the page colour; a top
                    // fade runs from it through 70% to clear 30% down the art, so the
                    // edge never shows. The block height is unchanged.
                    val drop = artH * 0.15f
                    Box(Modifier.fillMaxWidth().height(topInset + artH + 96.dp)) {
                        Art(t.backdrop, "w780", Modifier.padding(top = topInset + drop).fillMaxWidth().height(artH), alignment = BiasAlignment(0f, -0.85f))
                        Box(Modifier.padding(top = topInset + drop).fillMaxWidth().height(artH).background(Brush.verticalGradient(0f to Tok.bg, 0.06f to Tok.bg.copy(alpha = 0.7f), 0.3f to Color.Transparent, 0.7f to Tok.bg.copy(alpha = 0.6f), 1f to Tok.bg)))
                        Row(Modifier.align(Alignment.BottomStart).padding(horizontal = GUTTER), verticalAlignment = Alignment.Bottom) {
                            Box(Modifier.width(104.dp).aspectRatio(2f / 3f).clip(Tok.radiusMd).border(1.dp, Tok.border, Tok.radiusMd)) {
                                // The title API sends the metahub small poster here; it is a cache
                                // miss at open time (measured 0.6-0.8 s). The row's TMDB w342 path
                                // is already in Coil's cache, so it shows at once; metahub is the
                                // fallback, and the only source when the opener had no poster.
                                Art(rowPoster ?: t.poster, "w342", Modifier.fillMaxSize(), fallback = t.poster.takeIf { rowPoster != null })
                            }
                            Column(Modifier.padding(start = 14.dp).weight(1f)) {
                                Text(t.title, fontSize = 24.sp, lineHeight = 28.sp, fontWeight = FontWeight.Bold, color = Tok.text, maxLines = 3, overflow = TextOverflow.Ellipsis)
                                t.tagline?.takeIf { it.isNotBlank() }?.let { Text(it, color = Tok.textMuted, fontSize = 13.sp, maxLines = 2, modifier = Modifier.padding(top = 4.dp)) }
                            }
                        }
                    }
                }
            }
            item(key = "head") {
                Column(Modifier.padding(horizontal = GUTTER)) {
                    MetaRow(t.year, t.runtimeMin, t.rating, t.originalLang, Modifier.padding(top = 14.dp))
                    if (t.mediaType == "tv" && (t.seasons ?: 0) > 0) Text("${t.seasons} season${if (t.seasons == 1) "" else "s"}", color = Tok.textMuted, fontSize = 13.sp, modifier = Modifier.padding(top = 6.dp))
                    Button(
                        onClick = { vm.playRequest()?.let { nav.push(Screen.Player(it)) } },
                        modifier = Modifier.fillMaxWidth().padding(top = 16.dp).height(48.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = Color.White, contentColor = Tok.bg),
                    ) { Icon(Icons.Filled.PlayArrow, null); Spacer(Modifier.width(6.dp)); Text(vm.playLabel(), fontWeight = FontWeight.SemiBold, fontSize = 16.sp) }
                    Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (vm.canStartOver) OutlinedButton(onClick = { vm.playRequest(fromStart = true)?.let { nav.push(Screen.Player(it)) } }, modifier = Modifier.weight(1f), border = androidx.compose.foundation.BorderStroke(1.dp, Tok.border)) {
                            Icon(Icons.Filled.Replay, null, Modifier.size(18.dp), tint = Tok.text); Spacer(Modifier.width(6.dp)); Text("Start over", color = Tok.text)
                        }
                        OutlinedButton(onClick = { toast = if (vm.toggleList()) "Added to My List" else "Removed from My List" }, modifier = Modifier.weight(1f), border = androidx.compose.foundation.BorderStroke(1.dp, Tok.border)) {
                            Icon(if (vm.inList) Icons.Filled.Check else Icons.Filled.Add, null, Modifier.size(18.dp), tint = Tok.text); Spacer(Modifier.width(6.dp))
                            Text(if (vm.inList) "In My List" else "My List", color = Tok.text)
                        }
                    }
                    t.overview?.takeIf { it.isNotBlank() }?.let { ov ->
                        var open by rememberSaveable { mutableStateOf(false) }
                        Text(ov, color = Tok.textSecondary, fontSize = 14.sp, lineHeight = 21.sp, maxLines = if (open) Int.MAX_VALUE else 4, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 16.dp))
                        if (ov.length > 180) Text(if (open) "Show less" else "Read more", color = Tok.text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.clickable { open = !open }.padding(vertical = 6.dp))
                    }
                }
            }
            if (t.mediaType == "tv") {
                item(key = "eps-head") {
                    Column(Modifier.padding(top = 22.dp)) {
                        RowHeader("Episodes")
                        val seasons = t.seasonList.filter { it.number > 0 }
                        if (seasons.size > 1) LazyRow(contentPadding = PaddingValues(horizontal = GUTTER), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            items(seasons, key = { it.number }) { s ->
                                FilterChip(
                                    selected = s.number == vm.season, onClick = { vm.selectSeason(s.number) },
                                    label = { Text(s.name.ifEmpty { "Season ${s.number}" }) },
                                    colors = FilterChipDefaults.filterChipColors(selectedContainerColor = Color.White, selectedLabelColor = Tok.bg, labelColor = Tok.text, containerColor = Tok.fill1),
                                )
                            }
                        }
                    }
                }
                if (vm.episodesLoading) items(3, key = { "eps-sk-$it" }) {
                    Row(Modifier.padding(horizontal = GUTTER, vertical = 8.dp)) {
                        Box(Modifier.size(132.dp, 74.dp).background(Tok.surfaceSolid, Tok.radiusMd))
                        Column(Modifier.padding(start = 12.dp)) {
                            Box(Modifier.width(140.dp).height(12.dp).background(Tok.fill1, Tok.pill))
                            Box(Modifier.padding(top = 8.dp).width(80.dp).height(10.dp).background(Tok.fill1, Tok.pill))
                        }
                    }
                } else items(vm.episodes, key = { "ep-${it.season}-${it.episode}" }) { ep ->
                    val r = vm.resume
                    EpisodeItem(ep, vm.episodeProgress(ep), isNext = r != null && r.season == ep.season && r.episode == ep.episode) {
                        vm.playRequest(ep)?.let { nav.push(Screen.Player(it)) }
                    }
                }
            }
            if (t.credits.isNotEmpty()) item(key = "cast") {
                Column(Modifier.padding(top = 24.dp)) {
                    RowHeader("Cast")
                    LazyRow(contentPadding = PaddingValues(horizontal = GUTTER), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        items(t.credits, key = { it.id }) { p -> CastCard(p) { nav.push(Screen.Person(p.id, p.name)) } }
                    }
                }
            }
            val sim = vm.similar
            if (sim == null || sim.isNotEmpty()) item(key = "similar") {
                Column(Modifier.padding(top = 24.dp)) {
                    RowHeader("More like this")
                    LazyRow(contentPadding = PaddingValues(horizontal = GUTTER), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        if (sim == null) items(6) { CardSkeleton(CARD_W) }
                        else items(sim, key = { it.key }) { s -> PosterCard(s, Modifier.width(CARD_W)) { nav.open(s) } }
                    }
                }
            }
            item(key = "facts") {
                // Two facts per row, label over value; a long value wraps inside its cell.
                val facts = listOf(
                    "Genres" to t.genres.joinToString(" · "),
                    "Director" to t.director.joinToString(", "),
                    "Writers" to t.writers.joinToString(", "),
                    "Country" to t.country.joinToString(", "),
                ).filter { it.second.isNotBlank() }
                Column(Modifier.padding(start = GUTTER, end = GUTTER, top = 24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    facts.chunked(2).forEach { pair ->
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                            pair.forEach { (k, v) -> Box(Modifier.weight(1f)) { Fact(k, v) } }
                            if (pair.size == 1) Spacer(Modifier.weight(1f))
                        }
                    }
                }
            }
            item(key = "navpad") { Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars)) }
        }
        // Solid bar once the backdrop scrolls away, so text never runs under Back or the clock.
        if (pastArt && t != null) Row(
            Modifier.fillMaxWidth().background(Tok.bg).statusBarsPadding().height(56.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Spacer(Modifier.width(112.dp))
            Text(t.title, color = Tok.text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(end = GUTTER))
        }
        BackButton({ nav.pop() }, Modifier.statusBarsPadding().padding(start = 12.dp, top = 8.dp))
        toast?.let {
            Text(it, color = Tok.bg, fontSize = 14.sp, fontWeight = FontWeight.Medium,
                modifier = Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 24.dp).background(Color.White, Tok.pill).padding(horizontal = 18.dp, vertical = 10.dp))
        }
    }
}

@Composable
private fun Fact(k: String, v: String) {
    if (v.isBlank()) return
    Column {
        Text(k, color = Tok.textMuted, fontSize = 12.sp)
        Text(v, color = Tok.textSecondary, fontSize = 14.sp, lineHeight = 20.sp)
    }
}

@Composable
private fun EpisodeItem(ep: Episode, p: Progress?, isNext: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).background(if (isNext) Tok.fill1 else Color.Transparent).padding(horizontal = GUTTER, vertical = 10.dp),
    ) {
        Box(Modifier.size(132.dp, 74.dp).clip(Tok.radiusMd)) {
            Art(ep.still, "w300", Modifier.fillMaxSize())
            if (ep.still == null) Icon(Icons.Filled.PlayArrow, null, Modifier.align(Alignment.Center), tint = Tok.textMuted)
            Text("E${ep.episode}", color = Tok.text, fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.align(Alignment.TopStart).padding(5.dp).background(Tok.bg.copy(alpha = 0.7f), RoundedCornerShape(4.dp)).padding(horizontal = 5.dp, vertical = 1.dp))
            if (p != null && p.pct > 0.02f) Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(3.dp).background(Tok.fill3)) {
                Box(Modifier.fillMaxHeight().fillMaxWidth(if (p.finished) 1f else p.pct).background(Tok.accent))
            }
        }
        Column(Modifier.padding(start = 12.dp).weight(1f)) {
            Text(ep.title.ifEmpty { "Episode ${ep.episode}" }, color = Tok.text, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            val left = p?.takeIf { !it.finished }?.let { (it.durationMs - it.positionMs) / 60_000 }?.takeIf { it > 0 }
            val meta = listOfNotNull(
                if (isNext) "Next up" else null,
                ep.runtimeMin?.let { "$it min" },
                if (p?.finished == true) "Watched" else null,
                left?.let { "${runtimeText(it.toInt())} left" },
                ep.airDate?.take(4)?.takeIf { p == null },
            ).joinToString(" · ")
            if (meta.isNotEmpty()) Text(meta, color = if (isNext) Tok.accent else Tok.textMuted, fontSize = 12.sp, modifier = Modifier.padding(top = 2.dp))
            ep.overview?.takeIf { it.isNotBlank() }?.let { Text(it, color = Tok.textMuted, fontSize = 12.sp, lineHeight = 16.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp)) }
        }
    }
}

@Composable
private fun CastCard(p: Credit, onClick: () -> Unit) {
    Column(Modifier.width(80.dp).clickable(onClick = onClick), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(74.dp).clip(CircleShape).background(Tok.surfaceSolid), contentAlignment = Alignment.Center) {
            if (p.profile != null) Art(p.profile, "w185", Modifier.fillMaxSize(), p.name)
            else Text(p.name.take(1), color = Tok.textSecondary, fontSize = 24.sp, fontWeight = FontWeight.SemiBold)
        }
        Text(p.name, color = Tok.text, fontSize = 12.sp, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis, lineHeight = 15.sp,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center, modifier = Modifier.padding(top = 6.dp))
        p.character?.takeIf { it.isNotBlank() }?.let {
            Text(it, color = Tok.textMuted, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        }
    }
}

// ---- Grids: Person, Browse, Search, My list ---------------------------------

private fun LazyGridScope.full(key: String, content: @Composable () -> Unit) =
    item(key = key, span = { GridItemSpan(maxLineSpan) }) { content() }

@Composable
private fun TitleGrid(header: LazyGridScope.() -> Unit, titles: List<Title>, nav: Nav, onOpen: (Title) -> Unit = { nav.open(it) }, footer: LazyGridScope.() -> Unit = {}) {
    LazyVerticalGrid(
        GridCells.Adaptive(104.dp), Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = GUTTER, end = GUTTER, bottom = 24.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        header()
        items(titles, key = { it.key }) { t -> PosterCard(t, showType = true) { onOpen(t) } }
        footer()
    }
}

@Composable
private fun PageTitle(text: String, trailing: @Composable () -> Unit = {}) {
    Row(Modifier.fillMaxWidth().statusBarsPadding().padding(top = 12.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, fontSize = 26.sp, fontWeight = FontWeight.Bold, color = Tok.text, modifier = Modifier.weight(1f))
        trailing()
    }
}

@Composable
private fun EmptyState(title: String, hint: String, action: String? = null, onAction: () -> Unit = {}) {
    Column(Modifier.fillMaxWidth().padding(vertical = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(title, color = Tok.text, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
        Text(hint, color = Tok.textMuted, fontSize = 14.sp, textAlign = androidx.compose.ui.text.style.TextAlign.Center, modifier = Modifier.padding(top = 6.dp))
        if (action != null) OutlinedButton(onClick = onAction, modifier = Modifier.padding(top = 16.dp), border = androidx.compose.foundation.BorderStroke(1.dp, Tok.border)) { Text(action, color = Tok.text) }
    }
}

@Composable
private fun PhonePerson(nav: Nav, id: Long, name: String) {
    val vm: PersonVm = viewModel(key = "person-$id")
    LaunchedEffect(id) { vm.load(id) }
    val d = vm.data
    Box(Modifier.fillMaxSize()) {
        TitleGrid(header = {
            full("head") {
                Column(Modifier.statusBarsPadding().padding(top = 56.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        val p = d?.person
                        Box(Modifier.size(96.dp).clip(CircleShape).background(Tok.surfaceSolid), contentAlignment = Alignment.Center) {
                            if (p?.profile != null) Art(p.profile, "w185", Modifier.fillMaxSize(), p.name)
                            else Text((p?.name ?: name).take(1), color = Tok.textSecondary, fontSize = 32.sp)
                        }
                        Column(Modifier.padding(start = 16.dp)) {
                            Text(p?.name ?: name, fontSize = 24.sp, fontWeight = FontWeight.Bold, color = Tok.text)
                            p?.knownFor?.let { Text(it, color = Tok.textMuted, fontSize = 14.sp, modifier = Modifier.padding(top = 4.dp)) }
                        }
                    }
                    when {
                        d == null -> Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = Tok.accent, strokeWidth = 3.dp) }
                        d.person == null -> EmptyState("Person not found", "That profile is not in the catalog.")
                        d.titles.isEmpty() -> EmptyState("No titles to show", "Nothing in the catalog lists this person in a leading role.")
                        else -> Text("Known for", fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = Tok.text, modifier = Modifier.padding(top = 20.dp, bottom = 4.dp))
                    }
                }
            }
        }, titles = d?.titles.orEmpty(), nav = nav, footer = { full("navpad") { Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars)) } })
        Box(Modifier.fillMaxWidth().background(Tok.bg).statusBarsPadding().height(56.dp))
        BackButton({ nav.pop() }, Modifier.statusBarsPadding().padding(start = 12.dp, top = 8.dp))
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Chip(text: String, on: Boolean = false, onRemove: (() -> Unit)? = null, onClick: () -> Unit) {
    Row(
        Modifier.clip(Tok.pill).background(if (on) Color.White else Tok.fill1).border(1.dp, if (on) Color.Transparent else Tok.border, Tok.pill)
            .clickable(onClick = onClick).padding(start = 14.dp, end = if (onRemove != null) 6.dp else 14.dp, top = 7.dp, bottom = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, color = if (on) Tok.bg else Tok.text, fontSize = 13.sp, fontWeight = FontWeight.Medium)
        if (onRemove != null) Icon(Icons.Filled.Close, "Remove $text", Modifier.padding(start = 4.dp).size(16.dp).clickable(onClick = onRemove), tint = if (on) Tok.bg else Tok.textMuted)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Chips(content: @Composable () -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { content() }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PhoneBrowse(nav: Nav, initial: BrowseFilters) {
    val vm: BrowseVm = viewModel(key = "browse-$initial")
    LaunchedEffect(initial) { vm.start(initial) }
    var panel by remember { mutableStateOf(false) }
    val f = vm.filters
    TitleGrid(header = {
        full("head") {
            Column {
                PageTitle("Browse") {
                    OutlinedButton(onClick = { panel = true }, border = androidx.compose.foundation.BorderStroke(1.dp, Tok.border)) {
                        Icon(Icons.Filled.Tune, null, Modifier.size(18.dp), tint = Tok.text); Spacer(Modifier.width(6.dp)); Text("Filters", color = Tok.text)
                    }
                }
                Chips {
                    Chip("Movies", on = f.type == "movie") { vm.set(f.copy(type = "movie")) }
                    Chip("Series", on = f.type == "tv") { vm.set(f.copy(type = "tv")) }
                    f.active().forEach { (label, without) -> Chip(label, on = true, onRemove = { vm.set(without) }) { vm.set(without) } }
                }
                Text(
                    listOfNotNull(vm.total?.let { "%,d titles".format(it) }, BrowseOptions.SORTS.firstOrNull { it.id == f.sort }?.name).joinToString(" · "),
                    color = Tok.textMuted, fontSize = 13.sp, modifier = Modifier.padding(top = 10.dp, bottom = 4.dp),
                )
            }
        }
        if (vm.error != null && vm.titles.isEmpty()) full("err") { EmptyState("Couldn't load titles", vm.error!!, "Try again") { vm.retry() } }
        else if (!vm.loading && vm.titles.isEmpty() && vm.total != null) full("empty") {
            EmptyState("No titles match those filters", "Try removing a filter, or widen the decade.", "Clear filters") { vm.set(f.cleared()) }
        }
    }, titles = vm.titles, nav = nav, footer = {
        if (vm.loading && vm.titles.isEmpty()) items(12, key = { "sk$it" }) { CardSkeleton(104.dp) }
        if (vm.titles.isNotEmpty() && (vm.hasMore || vm.loading)) full("more") {
            // Reaching the end loads the next page (web "Load more").
            LaunchedEffect(vm.titles.size) { vm.loadMore() }
            Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = Tok.accent, strokeWidth = 3.dp, modifier = Modifier.size(28.dp)) }
        }
    })
    if (panel) {
        ModalBottomSheet(onDismissRequest = { panel = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Tok.surface) {
            FilterPanel(f, onSet = { vm.set(it) }, total = vm.total, onDone = { panel = false })
        }
    }
}

@Composable
private fun FilterPanel(f: BrowseFilters, onSet: (BrowseFilters) -> Unit, total: Int?, onDone: () -> Unit) {
    Column(Modifier.padding(horizontal = 20.dp).navigationBarsPadding().padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("Filters", fontSize = 20.sp, fontWeight = FontWeight.Bold, color = Tok.text)
        Group("Type") {
            Chip("Movies", f.type == "movie") { onSet(f.copy(type = "movie")) }
            Chip("Series", f.type == "tv") { onSet(f.copy(type = "tv")) }
        }
        Group("Language") {
            LanguagePrefs.LANGS.forEach { l -> val on = l.code in f.langs; Chip(l.label, on) { onSet(f.copy(langs = if (on) f.langs - l.code else f.langs + l.code)) } }
        }
        Group("Genre") {
            BrowseOptions.GENRES.forEach { g -> val on = g.id in f.genres; Chip(g.name, on) { onSet(f.copy(genres = if (on) f.genres - g.id else f.genres + g.id)) } }
        }
        Group("Decade") { BrowseOptions.DECADES.forEach { d -> Chip(d.name, f.decade == d.id) { onSet(f.copy(decade = if (f.decade == d.id) null else d.id)) } } }
        Group("Minimum rating") { BrowseOptions.RATINGS.forEach { r -> Chip("★ $r+", f.minRating == r) { onSet(f.copy(minRating = if (f.minRating == r) null else r)) } } }
        Group("Sort by") { BrowseOptions.SORTS.forEach { s -> Chip(s.name, f.sort == s.id) { onSet(f.copy(sort = s.id)) } } }
        Button(onClick = onDone, modifier = Modifier.fillMaxWidth(), colors = ButtonDefaults.buttonColors(containerColor = Color.White, contentColor = Tok.bg)) {
            Text(total?.let { "Show %,d titles".format(it) } ?: "Done", fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun Group(label: String, content: @Composable () -> Unit) {
    Column {
        Text(label, color = Tok.textMuted, fontSize = 12.sp, fontWeight = FontWeight.Medium, modifier = Modifier.padding(bottom = 8.dp))
        Chips(content)
    }
}

/** Web search page "Browse instead" chips. */
private val SUGGEST = listOf(
    "Telugu" to BrowseFilters(langs = listOf("te")), "Tamil" to BrowseFilters(langs = listOf("ta")),
    "Kannada" to BrowseFilters(langs = listOf("kn")), "Action" to BrowseFilters(genres = listOf(28)),
    "Top rated" to BrowseFilters(sort = "vote_average.desc"),
)

@Composable
private fun PhoneSearch(nav: Nav) {
    val vm: SearchVm = viewModel()
    val kb = LocalSoftwareKeyboardController.current
    val idle = vm.query.trim().isEmpty()
    TitleGrid(header = {
        full("field") {
            OutlinedTextField(
                value = vm.query, onValueChange = vm::onQuery, singleLine = true,
                placeholder = { Text("Search films and series") },
                leadingIcon = { Icon(Icons.Filled.Search, null, tint = Tok.textMuted) },
                trailingIcon = { if (vm.query.isNotEmpty()) IconButton(onClick = { vm.onQuery("") }) { Icon(Icons.Filled.Close, "Clear search", tint = Tok.textMuted) } },
                shape = RoundedCornerShape(999.dp),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { kb?.hide(); vm.submit() }),
                colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Focus.ring, unfocusedBorderColor = Tok.border, focusedContainerColor = Tok.surfaceSolid, unfocusedContainerColor = Tok.surfaceSolid),
                modifier = Modifier.fillMaxWidth().statusBarsPadding().padding(top = 12.dp, bottom = 8.dp),
            )
        }
        when {
            idle -> full("idle") {
                Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                    if (vm.recent.isNotEmpty()) Column {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("Recent", fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = Tok.text, modifier = Modifier.weight(1f))
                            TextButton(onClick = { vm.clearRecent() }) { Text("Clear", color = Tok.textMuted) }
                        }
                        Chips { vm.recent.forEach { q -> Chip(q, onRemove = { vm.forget(q) }) { vm.onQuery(q) } } }
                    }
                    Column {
                        Text("Browse instead", fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = Tok.text, modifier = Modifier.padding(bottom = 10.dp))
                        Chips { SUGGEST.forEach { (label, f) -> Chip(label) { nav.push(Screen.Browse(f)) } } }
                    }
                }
            }
            vm.error != null -> full("err") { Text(vm.error!!, color = Tok.danger) }
            vm.loading && vm.results.isEmpty() -> items(6, key = { "sk$it" }) { CardSkeleton(104.dp) }
            vm.query.trim().length >= 2 && vm.resultsFor == vm.query.trim() && vm.results.isEmpty() -> full("none") {
                EmptyState("Nothing found for “${vm.query.trim()}”", "Check the spelling, or browse by language and genre instead.", "Browse") { nav.tab(Screen.Browse()) }
            }
            vm.results.isNotEmpty() -> full("sum") {
                Text("${vm.results.size} result${if (vm.results.size == 1) "" else "s"} for “${vm.resultsFor}”", color = Tok.textMuted, fontSize = 13.sp, modifier = Modifier.padding(bottom = 4.dp))
            }
        }
    }, titles = if (idle) emptyList() else vm.results, nav = nav, onOpen = { vm.remember(); nav.open(it) })
}

@Composable
private fun PhoneMyList(nav: Nav) {
    val titles = remember { App.instance.myList.all() }
    TitleGrid(header = {
        full("head") { PageTitle("My list") }
        if (titles.isEmpty()) full("empty") {
            EmptyState("Nothing saved yet", "Add a film or series with + My List and it will appear here.", "Browse titles") { nav.tab(Screen.Browse()) }
        }
    }, titles = titles, nav = nav)
}

@Composable
private fun PhoneLangs(firstRun: Boolean, onDone: () -> Unit) {
    val prefs = App.instance.prefs
    // First run opens with Telugu chosen and ready to save: it is the library's
    // standing default, so a first-time viewer lands on it without hunting.
    val chosen = remember { mutableStateListOf<String>().apply { if (firstRun) add("te") else addAll(prefs.langs()) } }
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().padding(24.dp), verticalArrangement = Arrangement.Center) {
        Text("Your languages", fontSize = 26.sp, fontWeight = FontWeight.Bold, color = Tok.text)
        Text("Pick the languages you watch. Rows and search rank these first.", color = Tok.textMuted, modifier = Modifier.padding(top = 6.dp, bottom = 20.dp))
        Chips {
            LanguagePrefs.LANGS.forEach { l ->
                val on = l.code in chosen
                Chip(if (on) "✓ ${l.label}" else l.label, on) { if (on) chosen.remove(l.code) else chosen.add(l.code) }
            }
        }
        Spacer(Modifier.height(28.dp))
        Button(onClick = { prefs.save(chosen.toList()); onDone() }, modifier = Modifier.fillMaxWidth().height(48.dp), colors = ButtonDefaults.buttonColors(containerColor = Color.White, contentColor = Tok.bg)) {
            Text(if (chosen.isEmpty()) "Done" else "Done (${chosen.size})", fontWeight = FontWeight.SemiBold)
        }
        TextButton(onClick = { if (firstRun) prefs.save(emptyList()); onDone() }, modifier = Modifier.fillMaxWidth()) { Text(if (firstRun) "Skip" else "Cancel", color = Tok.textSecondary) }
    }
}
