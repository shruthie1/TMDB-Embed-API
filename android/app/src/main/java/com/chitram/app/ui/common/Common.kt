package com.chitram.app.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import coil.request.ImageRequest
import com.chitram.app.data.Api
import com.chitram.app.player.PlayRequest

/** Dark tokens from web/app/tokens.css. */
object Tok {
    val bg = Color(0xFF06070C)
    val surface = Color(0xFF141623)
    val surfaceSolid = Color(0xFF11131E)
    val fill1 = Color(0x0FFFFFFF)
    val fill2 = Color(0x1AFFFFFF)
    val fill3 = Color(0x2EFFFFFF)
    val border = Color(0x1FFFFFFF)
    val text = Color(0xFFEEF0FA)
    val textSecondary = Color(0xFFC9CCDB)
    val textMuted = Color(0xFF9497AA)
    val textDim = Color(0xFF6B6E80)
    val accent = Color(0xFF22D3EE) // --color-accent: progress, active tab (not focus)
    val accentFrom = Color(0xFF7C5CFF)
    val danger = Color(0xFFE08B84)
    val radiusMd = RoundedCornerShape(10.dp)
    val radiusLg = RoundedCornerShape(16.dp)
    val pill = RoundedCornerShape(999.dp)
    val scrimBottom = Brush.verticalGradient(listOf(Color.Transparent, bg.copy(alpha = 0.7f), bg))
    val scrimTop = Brush.verticalGradient(listOf(bg.copy(alpha = 0.85f), Color.Transparent))
    val scrimLeft = Brush.horizontalGradient(listOf(bg, bg.copy(alpha = 0.75f), Color.Transparent))
}

/**
 * One focus language for every D-pad / keyboard target (web tokens.css
 * --focus-ring and globals.css "TV focus"):
 * - Pictures (posters, stills, cast photos): a 3dp white frame, a soft dark
 *   drop shadow and a small lift.
 * - Controls (buttons, chips, nav, menu rows, player buttons): invert to a
 *   white fill with dark ink and the same shadow. Only focus is white: a
 *   primary control is a brighter grey until focused, so two controls never
 *   look focused at once.
 * No accent colour and no glow colour: focus is white, calm and readable from
 * the couch.
 */
object Focus {
    val ring = Color.White
    val fill = Color.White
    val ink = Tok.bg
    val ringWidth = 3.dp
    /** Web --focus-glow on TV: 0 12px 32px black at .55. */
    val shadow = Color.Black.copy(alpha = 0.55f)
    val shadowElevation = 14.dp
    /** Web --focus-scale: every focusable lifts by the same 4%; list rows do not scale. */
    const val pictureScale = 1.04f
    const val controlScale = 1.04f
    /** The player's play disc when not focused: brighter than the other icons, never white. */
    val primaryFill = Color.White.copy(alpha = 0.3f)
    /**
     * A primary button (Play, Resume, Done, Try again), as web .btn.primary:
     * white fill and dark ink at rest; focus adds the 3dp white ring, 3dp out.
     */
    val primaryButton = Color.White
    val ringOffset = 3.dp
    /** Selected but not focused (filter chip, season, rail item): quiet. */
    val selectedFill = Color.White.copy(alpha = 0.18f)
}

/**
 * The control half of the focus style for plain Compose controls (player
 * buttons, menu rows, pills). The caller paints Focus.fill / Focus.ink; this
 * adds the shared shadow and, unless `lift` is off for list rows, the scale.
 * TV-material surfaces take the same Focus values through their own params.
 */
fun Modifier.controlFocus(focused: Boolean, shape: Shape, lift: Boolean = true, ring: Boolean = false): Modifier =
    if (!focused) this
    else this.graphicsLayer { if (lift) { scaleX = Focus.controlScale; scaleY = Focus.controlScale } }
        .shadow(Focus.shadowElevation, shape, clip = false, ambientColor = Focus.shadow, spotColor = Focus.shadow)
        .then(if (ring) Modifier.border(Focus.ringWidth, Focus.ring, shape).padding(Focus.ringOffset + Focus.ringWidth) else Modifier)

/** Warm Coil's memory and disk caches for these (path, TMDB size) pairs. */
fun prefetchArt(ctx: android.content.Context, vararg art: Pair<String?, String>) {
    val loader = coil.Coil.imageLoader(ctx)
    for ((path, size) in art) Api.image(path, size)?.let { loader.enqueue(ImageRequest.Builder(ctx).data(it).screenBound(ctx, size).build()) }
}

/**
 * `original` (the Fire TV hero, 3640x2048) decodes down to the screen, never
 * full size: 3640x2048 ARGB is ~30 MB, the screen (1920x1080) ~8 MB. INEXACT
 * lets Coil sample by a power of two first, then scale to fit.
 */
private fun ImageRequest.Builder.screenBound(ctx: android.content.Context, size: String): ImageRequest.Builder {
    val dm = ctx.resources.displayMetrics
    val (w, h) = Api.decodeBound(size, dm.widthPixels, dm.heightPixels) ?: return this
    return size(w, h).precision(coil.size.Precision.INEXACT).scale(coil.size.Scale.FILL)
}

/**
 * Image with a solid placeholder; no crossfade (cheap on the Fire TV).
 * `fallback`: a second path tried if the first fails to load, so a dead
 * source shows the other poster rather than an empty box.
 */
@Composable
fun Art(path: String?, size: String, modifier: Modifier = Modifier, contentDescription: String? = null, alignment: androidx.compose.ui.Alignment = androidx.compose.ui.Alignment.Center, fallback: String? = null) {
    var failed by androidx.compose.runtime.remember(path) { androidx.compose.runtime.mutableStateOf(false) }
    val url = Api.image(if (failed && fallback != null) fallback else path, size)
    Box(modifier.background(Tok.surfaceSolid)) {
        if (url != null) {
            AsyncImage(
                model = ImageRequest.Builder(LocalContext.current).data(url).screenBound(LocalContext.current, size).build(),
                contentDescription = contentDescription,
                contentScale = ContentScale.Crop,
                alignment = alignment,
                modifier = Modifier.fillMaxSize(),
                onError = { if (fallback != null && !failed) failed = true },
            )
        }
    }
}

/**
 * Hero title: the TMDB logo when there is one, else [text]. The text shows
 * until the logo has decoded, and again if it fails, so the hero is never
 * blank. The logo keeps its aspect inside [maxW] x [maxH], anchored bottom-left
 * where the text starts.
 */
@Composable
fun HeroTitle(logo: String?, title: String, maxW: androidx.compose.ui.unit.Dp, maxH: androidx.compose.ui.unit.Dp, text: @Composable () -> Unit) {
    val url = Api.image(logo, Api.LOGO)
    var shown by androidx.compose.runtime.remember(url) { androidx.compose.runtime.mutableStateOf(false) }
    var failed by androidx.compose.runtime.remember(url) { androidx.compose.runtime.mutableStateOf(false) }
    if (url == null || failed) { text(); return }
    Box {
        if (!shown) text()
        AsyncImage(
            // A w500 png is small: decode it whole, independent of the box size.
            model = ImageRequest.Builder(LocalContext.current).data(url).size(coil.size.Size.ORIGINAL).build(),
            contentDescription = title,
            contentScale = ContentScale.Fit,
            alignment = androidx.compose.ui.Alignment.BottomStart,
            modifier = Modifier.sizeIn(maxWidth = maxW, maxHeight = maxH).graphicsLayer { alpha = if (shown) 1f else 0f },
            onSuccess = { shown = true },
            onError = { failed = true },
        )
    }
}

/**
 * Logo path for a home-hero title. Row titles carry none, so read the full
 * record: the same /full url the detail screen opens next (OkHttp catalog
 * cache, 1 h). Null while loading, on error, or when the title has no logo.
 */
@Composable
fun rememberHeroLogo(t: com.chitram.app.data.Title): String? =
    androidx.compose.runtime.produceState<String?>(null, t.key) {
        value = runCatching { com.chitram.app.App.instance.api.titleFull(t.mediaType, t.tmdbId).logo }.getOrNull()
    }.value

sealed interface Screen {
    data object Home : Screen
    data object Search : Screen
    data object MyList : Screen
    data object Langs : Screen
    /**
     * `poster`: the TMDB path the opener already shows, reused so the header is a cache hit.
     * `title`/`backdrop`: the tapped card's, shown at once while the title loads.
     */
    data class Detail(val type: String, val id: Long, val poster: String? = null, val title: String? = null, val backdrop: String? = null) : Screen
    data class Person(val id: Long, val name: String = "") : Screen
    /** Browse with filters; `initial` comes from a row's "See all". */
    data class Browse(val initial: com.chitram.app.data.BrowseFilters = com.chitram.app.data.BrowseFilters()) : Screen
    data class Player(val req: PlayRequest) : Screen
}

/** A plain back stack. No navigation library: fewer classes, smaller APK. */
class Nav(start: Screen) {
    val stack = mutableStateListOf(start)
    val top: Screen get() = stack.last()
    fun push(s: Screen) { stack.add(s) }
    fun replaceAll(s: Screen) { stack.clear(); stack.add(s) }
    fun tab(s: Screen) { stack.clear(); stack.add(Screen.Home); if (s != Screen.Home) stack.add(s) }
    fun pop(): Boolean = if (stack.size > 1) { stack.removeAt(stack.lastIndex); true } else false
}

fun fmtTime(ms: Long): String {
    val s = (ms / 1000).coerceAtLeast(0)
    val h = s / 3600; val m = (s % 3600) / 60; val sec = s % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%d:%02d".format(m, sec)
}

fun runtimeText(min: Int?): String? = when {
    min == null || min <= 0 -> null
    min >= 60 -> "${min / 60}h ${min % 60}m"
    else -> "${min}m"
}

/** Language name for a code, e.g. "te" -> "Telugu", "en" -> "English". */
fun langName(code: String?): String? = when {
    code.isNullOrEmpty() -> null
    else -> com.chitram.app.data.LanguagePrefs.LANGS.firstOrNull { it.code == code }?.label
        ?: java.util.Locale(code).getDisplayLanguage(java.util.Locale.ENGLISH).ifEmpty { code }
}

fun metaLine(year: Int?, rating: Double?, extra: String? = null): String =
    listOfNotNull(year?.toString(), rating?.takeIf { it > 0 }?.let { "★ %.1f".format(it) }, extra).joinToString("  ·  ")

/**
 * TV: focus this requester once its node is attached, and keep asking until
 * focus has landed. A requester on a lazy item is not attached until a later
 * frame (requestFocus() throws until then), and a single try lost the race to
 * whatever took focus first (Fire TV: the rail's Search item, 1.2.18).
 * [landed] says whether the target holds focus; without it, the first request
 * that does not throw counts. Tries for up to [frames] frames.
 */
suspend fun androidx.compose.ui.focus.FocusRequester.focusWhenAttached(frames: Int = 30, landed: (() -> Boolean)? = null): Boolean {
    repeat(frames) {
        androidx.compose.runtime.withFrameNanos { }
        if (landed?.invoke() == true) return true
        val asked = runCatching { requestFocus() }.isSuccess
        if (asked && landed == null) return true
    }
    androidx.compose.runtime.withFrameNanos { }
    return landed?.invoke() == true
}

/**
 * Clock for a "Refresh sources" control: ticks every 500 ms while it is
 * refreshing, cooling down or showing a result line (live countdown, auto-hide),
 * then stops.
 */
@Composable
fun rememberRefreshTick(m: com.chitram.app.player.RefreshModel): Long {
    var now by androidx.compose.runtime.remember { androidx.compose.runtime.mutableLongStateOf(System.currentTimeMillis()) }
    androidx.compose.runtime.LaunchedEffect(m) {
        while (true) {
            now = System.currentTimeMillis()
            if (!(m.running || m.readyAt > now || m.noteUntil > now)) break
            kotlinx.coroutines.delay(500)
        }
    }
    return now
}

/** The "Refresh sources" button glyph: a small spinner while it runs, the refresh icon otherwise. */
@Composable
fun RefreshGlyph(running: Boolean, tint: Color, size: androidx.compose.ui.unit.Dp, modifier: Modifier = Modifier) {
    if (running) androidx.compose.material3.CircularProgressIndicator(color = tint, strokeWidth = 2.dp, modifier = modifier.size(size))
    else androidx.compose.material3.Icon(androidx.compose.material.icons.Icons.Filled.Refresh, contentDescription = null, tint = tint, modifier = modifier.size(size))
}
