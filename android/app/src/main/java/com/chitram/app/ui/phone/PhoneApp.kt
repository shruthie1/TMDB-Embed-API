package com.chitram.app.ui.phone

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
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
import com.chitram.app.ui.common.SearchVm
import com.chitram.app.ui.common.Tok
import com.chitram.app.ui.common.metaLine

@Composable
fun PhoneApp(nav: Nav) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Tok.accent, onPrimary = Tok.bg, background = Tok.bg, onBackground = Tok.text,
            surface = Tok.bg, onSurface = Tok.text, surfaceVariant = Tok.surface, onSurfaceVariant = Tok.textMuted,
            secondaryContainer = Tok.fill2, onSecondaryContainer = Tok.text, outline = Tok.border,
        ),
    ) {
        BackHandler(enabled = nav.stack.size > 1) { nav.pop() }
        val top = nav.top
        if (top is Screen.Player) {
            PlayerScreen(top.req, isTv = false, onBack = { nav.pop() })
            return@MaterialTheme
        }
        val homeList = rememberLazyListState()
        val showBar = top == Screen.Home || top == Screen.Search || top == Screen.MyList
        Scaffold(
            containerColor = Tok.bg,
            bottomBar = {
                if (showBar) NavigationBar(containerColor = Tok.bg.copy(alpha = 0.96f), tonalElevation = 0.dp) {
                    listOf(Triple(Screen.Home, "Home", Icons.Filled.Home), Triple(Screen.Search, "Search", Icons.Filled.Search), Triple(Screen.MyList, "My list", Icons.Filled.List))
                        .forEach { (s, label, icon) ->
                            NavigationBarItem(
                                selected = top == s, onClick = { nav.tab(s) },
                                icon = { Icon(icon, contentDescription = label) }, label = { Text(label) },
                                colors = NavigationBarItemDefaults.colors(selectedIconColor = Tok.bg, indicatorColor = Tok.accent, unselectedIconColor = Tok.textMuted, unselectedTextColor = Tok.textMuted, selectedTextColor = Tok.text),
                            )
                        }
                }
            },
        ) { pad ->
            Box(Modifier.fillMaxSize().padding(pad).background(Tok.bg)) {
                when (top) {
                    Screen.Home -> PhoneHome(nav, homeList)
                    Screen.Search -> PhoneSearch(nav)
                    Screen.MyList -> PhoneGrid(nav, "My list", App.instance.myList.all(), "Titles you add show up here.")
                    is Screen.Langs -> PhoneLangs(top.firstRun) { if (top.firstRun) nav.replaceAll(Screen.Home) else nav.pop() }
                    is Screen.Detail -> PhoneDetail(nav, top.type, top.id)
                    is Screen.Player -> Unit
                }
            }
        }
    }
}

@Composable
private fun PhoneHome(nav: Nav, listState: androidx.compose.foundation.lazy.LazyListState) {
    val vm: HomeVm = viewModel()
    LaunchedEffect(Unit) { vm.load() }
    LazyColumn(state = listState, contentPadding = PaddingValues(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        item(key = "hero") {
            val h = vm.hero
            Box(Modifier.fillMaxWidth().aspectRatio(4f / 5f)) {
                Art(h?.poster, "w780", Modifier.fillMaxSize())
                Box(Modifier.fillMaxSize().background(Tok.scrimBottom))
                Box(Modifier.fillMaxWidth().height(140.dp).background(Tok.scrimTop))
                Row(Modifier.statusBarsPadding().padding(16.dp).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("Chitram", fontSize = 22.sp, fontWeight = FontWeight.Bold, color = Tok.text, modifier = Modifier.weight(1f))
                    TextButton(onClick = { nav.push(Screen.Langs(false)) }) { Text("Languages", color = Tok.textSecondary) }
                }
                if (h != null) Column(Modifier.align(Alignment.BottomStart).padding(20.dp)) {
                    Text(h.title, fontSize = 28.sp, fontWeight = FontWeight.Bold, color = Tok.text, maxLines = 2)
                    Text(metaLine(h.year, h.rating, h.originalLang?.let { LanguagePrefs.label(it) }), color = Tok.textSecondary, fontSize = 13.sp, modifier = Modifier.padding(vertical = 6.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Button(onClick = { nav.push(Screen.Detail(h.mediaType, h.tmdbId)) }, colors = ButtonDefaults.buttonColors(containerColor = Color.White, contentColor = Tok.bg)) { Text("▶  Play", fontWeight = FontWeight.SemiBold) }
                    }
                }
            }
        }
        vm.error?.let { e -> item(key = "err") { Text(e, color = Tok.danger, modifier = Modifier.padding(horizontal = 16.dp)) } }
        items(vm.rows.filter { it.loading || it.titles.isNotEmpty() }, key = { it.kind }) { row -> PhoneRow(row, nav) }
    }
}

@Composable
private fun PhoneRow(row: HomeRow, nav: Nav) {
    Column {
        Text(row.label, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = Tok.text, modifier = Modifier.padding(start = 16.dp, bottom = 8.dp))
        val wide = row.kind == "continue"
        LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (row.loading) items(5) { Box(Modifier.size(if (wide) 200.dp else 110.dp, if (wide) 112.dp else 165.dp).background(Tok.surfaceSolid, Tok.radiusMd)) }
            else items(row.titles, key = { it.key }) { t ->
                if (wide) WideTile(t, row.progress[t.key]) { nav.push(Screen.Detail(t.mediaType, t.tmdbId)) }
                else PosterTile(t, Modifier.width(110.dp)) { nav.push(Screen.Detail(t.mediaType, t.tmdbId)) }
            }
        }
    }
}

@Composable
private fun PosterTile(t: Title, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Box(modifier.aspectRatio(2f / 3f).clip(Tok.radiusMd).clickable(onClick = onClick)) {
        Art(t.poster, "w342", Modifier.fillMaxSize(), t.title)
        if (t.poster == null) Text(t.title, color = Tok.textSecondary, fontSize = 12.sp, modifier = Modifier.padding(6.dp))
    }
}

@Composable
private fun WideTile(t: Title, p: Progress?, onClick: () -> Unit) {
    Column(Modifier.width(200.dp).clickable(onClick = onClick)) {
        Box(Modifier.size(200.dp, 112.dp).clip(Tok.radiusMd)) {
            Art(t.backdrop ?: t.poster, "w300", Modifier.fillMaxSize(), t.title)
            if (p != null) Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(3.dp).background(Tok.fill3)) {
                Box(Modifier.fillMaxHeight().fillMaxWidth(p.pct).background(Tok.accent))
            }
        }
        val sub = if (p != null && p.mediaType == "tv") "${t.title} · S${p.season} E${p.episode}" else t.title
        Text(sub, color = Tok.textSecondary, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
    }
}

@Composable
private fun PhoneDetail(nav: Nav, type: String, id: Long) {
    val vm: DetailVm = viewModel(key = "detail-$type-$id")
    LaunchedEffect(type, id) { vm.load(type, id) }
    val t = vm.full
    if (t == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text(vm.error ?: "Loading", color = Tok.textMuted) }
        return
    }
    LazyColumn(contentPadding = PaddingValues(bottom = 32.dp)) {
        item(key = "art") {
            Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f)) {
                Art(t.backdrop, "w780", Modifier.fillMaxSize())
                Box(Modifier.fillMaxSize().background(Tok.scrimBottom))
                TextButton(onClick = { nav.pop() }, modifier = Modifier.statusBarsPadding().padding(8.dp)) { Text("‹ Back", color = Tok.text) }
            }
        }
        item(key = "head") {
            Column(Modifier.padding(horizontal = 16.dp)) {
                Text(t.title, fontSize = 26.sp, fontWeight = FontWeight.Bold, color = Tok.text)
                val extra = listOfNotNull(t.runtimeMin?.let { "${it / 60}h ${it % 60}m" }, t.originalLang?.let { LanguagePrefs.label(it) }).joinToString("  ·  ")
                Text(metaLine(t.year, t.rating, extra.ifEmpty { null }), color = Tok.textSecondary, fontSize = 13.sp, modifier = Modifier.padding(vertical = 6.dp))
                val r = vm.resume
                val label = when {
                    r == null -> "Play"
                    t.mediaType == "tv" && r.positionMs > 0 -> "Resume S${r.season} E${r.episode}"
                    t.mediaType == "tv" -> "Play S${r.season} E${r.episode}"
                    else -> "Resume"
                }
                Button(
                    onClick = { vm.playRequest()?.let { nav.push(Screen.Player(it)) } },
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Color.White, contentColor = Tok.bg),
                ) { Text("▶  $label", fontWeight = FontWeight.SemiBold) }
                OutlinedButton(onClick = { vm.toggleList() }, modifier = Modifier.fillMaxWidth()) {
                    Text(if (vm.inList) "✓ In my list" else "+ My list", color = Tok.text)
                }
                Text(t.overview.orEmpty(), color = Tok.textSecondary, fontSize = 14.sp, modifier = Modifier.padding(top = 12.dp))
                if (t.cast.isNotEmpty()) Text("Cast: " + t.cast.take(6).joinToString(", "), color = Tok.textMuted, fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp))
            }
        }
        if (t.mediaType == "tv" && t.seasonList.isNotEmpty()) {
            item(key = "seasons") {
                LazyRow(contentPadding = PaddingValues(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(t.seasonList.filter { it.number > 0 }, key = { it.number }) { s ->
                        FilterChip(
                            selected = s.number == vm.season, onClick = { vm.selectSeason(s.number) },
                            label = { Text(s.name.ifEmpty { "Season ${s.number}" }) },
                            colors = FilterChipDefaults.filterChipColors(selectedContainerColor = Color.White, selectedLabelColor = Tok.bg, labelColor = Tok.text),
                        )
                    }
                }
            }
            if (vm.episodesLoading) item(key = "eploading") { Text("Loading episodes", color = Tok.textMuted, modifier = Modifier.padding(16.dp)) }
            else items(vm.episodes, key = { "ep-${it.season}-${it.episode}" }) { ep ->
                val p = vm.episodeProgress(ep)
                Row(
                    Modifier.fillMaxWidth().clickable { vm.playRequest(ep)?.let { nav.push(Screen.Player(it)) } }.padding(horizontal = 16.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.size(128.dp, 72.dp).clip(Tok.radiusMd)) {
                        Art(ep.still, "w300", Modifier.fillMaxSize())
                        if (p != null) Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(3.dp).background(Tok.fill3)) {
                            Box(Modifier.fillMaxHeight().fillMaxWidth(if (p.finished) 1f else p.pct).background(Tok.accent))
                        }
                    }
                    Column(Modifier.padding(start = 12.dp).weight(1f)) {
                        Text("${ep.episode}. ${ep.title}", color = Tok.text, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(listOfNotNull(ep.runtimeMin?.let { "${it}m" }, ep.airDate).joinToString(" · "), color = Tok.textMuted, fontSize = 12.sp)
                    }
                }
            }
        }
    }
}

@Composable
private fun PhoneSearch(nav: Nav) {
    val vm: SearchVm = viewModel()
    val kb = LocalSoftwareKeyboardController.current
    Column(Modifier.fillMaxSize().statusBarsPadding().padding(horizontal = 16.dp)) {
        OutlinedTextField(
            value = vm.query, onValueChange = vm::onQuery, singleLine = true,
            placeholder = { Text("Search movies and shows") },
            shape = RoundedCornerShape(999.dp),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { kb?.hide() }),
            colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Tok.accent, unfocusedBorderColor = Tok.border, focusedContainerColor = Tok.surfaceSolid, unfocusedContainerColor = Tok.surfaceSolid),
            modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp),
        )
        when {
            vm.error != null -> Text(vm.error!!, color = Tok.danger)
            vm.loading && vm.results.isEmpty() -> Text("Searching", color = Tok.textMuted)
            vm.query.length >= 2 && vm.results.isEmpty() && !vm.loading -> Text("No results for \"${vm.query}\"", color = Tok.textMuted)
        }
        LazyVerticalGrid(GridCells.Adaptive(104.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(vertical = 8.dp)) {
            items(vm.results, key = { it.key }) { t -> PosterTile(t) { nav.push(Screen.Detail(t.mediaType, t.tmdbId)) } }
        }
    }
}

@Composable
private fun PhoneGrid(nav: Nav, title: String, titles: List<Title>, empty: String) {
    Column(Modifier.fillMaxSize().statusBarsPadding().padding(horizontal = 16.dp)) {
        Text(title, fontSize = 24.sp, fontWeight = FontWeight.Bold, color = Tok.text, modifier = Modifier.padding(vertical = 16.dp))
        if (titles.isEmpty()) Text(empty, color = Tok.textMuted)
        LazyVerticalGrid(GridCells.Adaptive(104.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(titles, key = { it.key }) { t -> PosterTile(t) { nav.push(Screen.Detail(t.mediaType, t.tmdbId)) } }
        }
    }
}

@Composable
private fun PhoneLangs(firstRun: Boolean, onDone: () -> Unit) {
    val prefs = App.instance.prefs
    val chosen = remember { mutableStateListOf<String>().apply { if (!firstRun) addAll(prefs.langs()) } }
    Column(Modifier.fillMaxSize().statusBarsPadding().padding(24.dp), verticalArrangement = Arrangement.Center) {
        Text("Your languages", fontSize = 26.sp, fontWeight = FontWeight.Bold, color = Tok.text)
        Text("Pick the languages you watch.", color = Tok.textMuted, modifier = Modifier.padding(top = 6.dp, bottom = 20.dp))
        LanguagePrefs.LANGS.forEach { l ->
            val on = l.code in chosen
            FilterChip(
                selected = on, onClick = { if (on) chosen.remove(l.code) else chosen.add(l.code) },
                label = { Text(l.label, fontSize = 16.sp) },
                colors = FilterChipDefaults.filterChipColors(selectedContainerColor = Color.White, selectedLabelColor = Tok.bg, labelColor = Tok.text),
                modifier = Modifier.padding(vertical = 2.dp),
            )
        }
        Spacer(Modifier.height(24.dp))
        Button(onClick = { prefs.save(chosen.toList()); onDone() }, modifier = Modifier.fillMaxWidth(), colors = ButtonDefaults.buttonColors(containerColor = Color.White, contentColor = Tok.bg)) {
            Text(if (chosen.isEmpty()) "Done" else "Done (${chosen.size})", fontWeight = FontWeight.SemiBold)
        }
        if (firstRun) TextButton(onClick = { prefs.save(emptyList()); onDone() }, modifier = Modifier.fillMaxWidth()) { Text("Skip", color = Tok.textSecondary) }
    }
}
