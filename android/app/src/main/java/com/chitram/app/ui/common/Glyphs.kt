package com.chitram.app.ui.common

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.BasicText
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The player's icon set, ported path for path from web/components/Icon.jsx:
 * one 24 grid, 1.5 strokes with round caps, filled only for play and next.
 * Vectors, not a font, so no glyph can fall back to a missing-glyph box.
 */
object Glyphs {
    val play = solid("M6 4v16l14-8z")
    val pause = line("M8 5v14M16 5v14")
    val close = line("M6 6l12 12M18 6L6 18")
    val back = line("M15 5l-7 7 7 7")
    val next = solid("M5 4v16l10-8zM17 4h2v16h-2z")
    val server = line("M4 5h16v5H4zM4 14h16v5H4zM8 7.5h.01M8 16.5h.01")
    val audio = line("M12 4v16M8 8v8M16 8v8M4 11v2M20 11v2")
    val quality = line("M5 19v-5M12 19V9M19 19V5")
    val subtitles = line(rect(3f, 6f, 18f, 12f, 1.5f) + "M7 14h4M14 14h3")
    val fitContain = line(rect(3f, 8f, 18f, 8f, 1f) + "M3 8h18M3 16h18")
    val fitCover = line(rect(3f, 6f, 18f, 12f, 1f) + "M7 3v18M17 3v18")
    val cast = line("M3 7V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6M3 11a9 9 0 0 1 9 9M3 15a5 5 0 0 1 5 5M3 19.5h.01")
    val fitFill = line(rect(3f, 6f, 18f, 12f, 1f) + "M3 12h18M6 9l-3 3 3 3M18 9l3 3-3 3")
    val seekBack = line("M3.6 10.5A9 9 0 1 1 3 15M3 5.5V11h5.5")
    val seekFwd = line("M20.4 10.5A9 9 0 1 0 21 15M21 5.5V11h-5.5")
    val check = line("M4 12.5 9.5 18 20 6.5")
    val restart = line("M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4")

    private fun rect(x: Float, y: Float, w: Float, h: Float, r: Float) =
        "M${x + r} ${y}H${x + w - r}A$r $r 0 0 1 ${x + w} ${y + r}V${y + h - r}A$r $r 0 0 1 ${x + w - r} ${y + h}" +
            "H${x + r}A$r $r 0 0 1 $x ${y + h - r}V${y + r}A$r $r 0 0 1 ${x + r} ${y}Z"

    private fun build(d: String, filled: Boolean) = ImageVector.Builder(
        defaultWidth = 24.dp, defaultHeight = 24.dp,
        viewportWidth = 24f, viewportHeight = 24f,
    ).addPath(
        pathData = addPathNodes(d),
        fill = if (filled) SolidColor(Color.White) else null,
        stroke = if (filled) null else SolidColor(Color.White),
        strokeLineWidth = 1.5f,
        strokeLineCap = StrokeCap.Round,
        strokeLineJoin = StrokeJoin.Round,
    ).build()

    private fun line(d: String) = build(d, false)
    private fun solid(d: String) = build(d, true)
}

/**
 * One glyph at `size`, tinted. `numeral` puts the web's bold "10" inside the
 * seek arcs (Icon.jsx draws it as SVG text at y 17.6, font 9 of 24).
 */
@Composable
fun Glyph(icon: ImageVector, contentDescription: String?, tint: Color, size: Dp, numeral: String? = null) {
    Box(Modifier.size(size), contentAlignment = Alignment.Center) {
        Icon(icon, contentDescription, tint = tint, modifier = Modifier.size(size))
        if (numeral != null) {
            val fs = with(LocalDensity.current) { (size * (8f / 24f)).toSp() }
            BasicText(
                numeral,
                style = TextStyle(color = tint, fontSize = fs, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center, lineHeight = fs),
                modifier = Modifier.offset(x = size * (0.3f / 24f), y = size * (2.2f / 24f)),
            )
        }
    }
}
