package com.chitram.app.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
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
    val accent = Color(0xFF22D3EE) // --color-accent: progress, active tab, focus
    val accentFrom = Color(0xFF7C5CFF)
    val danger = Color(0xFFE08B84)
    val radiusMd = RoundedCornerShape(10.dp)
    val radiusLg = RoundedCornerShape(16.dp)
    val pill = RoundedCornerShape(999.dp)
    val scrimBottom = Brush.verticalGradient(listOf(Color.Transparent, bg.copy(alpha = 0.7f), bg))
    val scrimTop = Brush.verticalGradient(listOf(bg.copy(alpha = 0.85f), Color.Transparent))
    val scrimLeft = Brush.horizontalGradient(listOf(bg, bg.copy(alpha = 0.75f), Color.Transparent))
}

/** Image with a solid placeholder; no crossfade (cheap on the Fire TV). */
@Composable
fun Art(path: String?, size: String, modifier: Modifier = Modifier, contentDescription: String? = null, alignment: androidx.compose.ui.Alignment = androidx.compose.ui.Alignment.Center) {
    val url = Api.image(path, size)
    Box(modifier.background(Tok.surfaceSolid)) {
        if (url != null) {
            AsyncImage(
                model = ImageRequest.Builder(LocalContext.current).data(url).build(),
                contentDescription = contentDescription,
                contentScale = ContentScale.Crop,
                alignment = alignment,
                modifier = Modifier.fillMaxSize(),
            )
        }
    }
}

sealed interface Screen {
    data object Home : Screen
    data object Search : Screen
    data object MyList : Screen
    data class Langs(val firstRun: Boolean) : Screen
    data class Detail(val type: String, val id: Long) : Screen
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
