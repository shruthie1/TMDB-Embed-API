package com.chitram.app.ui.tv

/**
 * Web TV layout values, resolved and converted for the APK TV path.
 *
 * Source: web/app/{tokens,globals,nav,cards,tv-compact}.css under
 * html[data-tv="true"]. clamp() and vw/vh values are resolved at the
 * 1920x1080 CSS px page the web comments measure against ("values in comments
 * are at 1920 wide"). An Android TV 1080p screen is 960x540 dp, so
 * 1 web CSS px = [CSS_PX_DP] dp. Change that one factor to re-base every size.
 */
internal object TvWeb {
    const val CSS_PX_DP = 0.5f

    // nav.css: left rail.
    /** --tv-safe-x clamp(8px,.8vw,16px) = 15.36px. */
    const val SAFE_X = 15.36f
    /** --rail-icon clamp(52px,3vw,60px) = 57.6px: item height and collapsed item width. */
    const val RAIL_ICON = 57.6f
    /** --rail-w = safe-x + rail-icon + --space-1 (4px) = 76.96px. */
    const val RAIL_W = SAFE_X + RAIL_ICON + 4f
    /** --rail-open-w = rail-w + clamp(150px,11vw,210px) = 76.96 + 210 = 286.96px. */
    const val RAIL_OPEN_W = RAIL_W + 210f
    /** .app-nav-item svg 28px; padding (rail-icon - 28) / 2 = 14.8px. */
    const val RAIL_GLYPH = 28f
    const val RAIL_ITEM_PAD = (RAIL_ICON - RAIL_GLYPH) / 2f
    /** .app-nav-item gap --space-5 = 20px; label clamp(18px,1.15vw,22px) = 22px; items gap --space-1 = 4px. */
    const val RAIL_LABEL_GAP = 20f
    const val RAIL_LABEL = 22f
    const val RAIL_ITEM_GAP = 4f
    /** --tv-gap clamp(16px,1.6vw,32px) = 30.72px: rail-to-content gap and page side margin. */
    const val GUTTER = 30.72f

    // tv-compact.css + cards.css: cards and rows.
    /** --tv-card-w clamp(150px,11.4vw,230px) = 218.88px; .poster aspect-ratio 2/3. */
    const val CARD_W = 218.88f
    const val POSTER_H = CARD_W * 1.5f
    /** .rail gap / .grid-titles gap: --gap = --space-4 = 16px. */
    const val CARD_GAP = 16f
    /** .card-title 23px / line-height 1.25, margin-top --space-2-5 10px; .card-meta 19px, margin-top 2px. */
    const val CARD_TITLE = 23f
    const val CARD_TITLE_TOP = 10f
    const val CARD_META = 19f
    /** .prog height 2px (TV .rule 3px), margin-top --space-2 8px. */
    const val CARD_PROG = 3f
    const val CARD_PROG_TOP = 8f
    /** .card-rank clamp(34px,9vw,54px) = 54px, left --space-1-5 6px, bottom 2px. */
    const val CARD_RANK = 54f
    /** --radius-md 10px. */
    const val RADIUS = 10f
    /** .row-label 30px weight 500, margin-bottom --space-4 16px; .row-sec margin-bottom --space-7 28px. */
    const val ROW_LABEL = 30f
    const val ROW_LABEL_BOTTOM = 16f
    const val ROW_GAP = 28f
    /** --rail-focus-pad --space-6 24px: room above/below a row for the lift; .rail padding-inline --space-4 16px. */
    const val FOCUS_PAD = 24f
    /** .see-all 20px, min-height 56px, padding-inline --space-3 12px. */
    const val SEE_ALL = 20f

    // Focus (tokens.css TV, cards.css card lift, globals.css .focusable).
    /** --focus-ring 3px white, --focus-offset 3px. */
    const val RING = 3f
    const val RING_OFFSET = 3f
    /** --focus-glow 0 12px 32px black .55 (elevation ~ the 12px drop). */
    const val GLOW = 12f
    /** --lift-shadow 0 18px 36px -10px black .75. */
    const val LIFT_SHADOW = 18f
    /** cards.css: --lift-scale 1.07 on TV, --lift-ms 200ms, --lift-ease cubic-bezier(.2,.8,.2,1). */
    const val CARD_SCALE = 1.07f
    const val CARD_MS = 200
    /** globals.css [data-tv] .focusable:focus scale(1.09); .focusable transition --duration-base 180ms --ease-out cubic-bezier(.16,1,.3,1); translateY(-2px). */
    const val CONTROL_SCALE = 1.09f
    const val CONTROL_MS = 180
    const val CONTROL_RISE = 2f
    /** nav.css rail open/close: width --duration-base 180ms --ease-out. */
    const val RAIL_MS = 180

    // Controls (tv-compact.css).
    /** .btn min-height 64px, font 24px, padding-inline --space-7 28px; .actions gap --space-4 16px. */
    const val BTN_H = 64f
    const val BTN_FONT = 24f
    const val BTN_PAD_X = 28f
    const val ACTION_GAP = 16f
    /** .chip min-height 56px, 21px, padding 10px 18px. */
    const val CHIP_H = 56f
    const val CHIP_FONT = 21f
    /** .brand 36px. */
    const val BRAND = 36f

    // Home hero (tokens.css TV --hero-height 70vh; globals.css .home-hero-in).
    /** 70vh of 1080 = 756px. */
    const val HERO_H = 756f
    /** .home-hero-in padding --space-14 56px top, --space-8 32px bottom; max-width 620px. */
    const val HERO_PAD_TOP = 56f
    const val HERO_PAD_BOTTOM = 32f
    const val HERO_MAX_W = 620f
    /** .home-hero-title clamp(44px,3.6vw,68px) = 68px; meta 20px; overview 22px / 1.45, 2 lines. */
    const val HERO_TITLE = 68f
    const val HERO_META = 20f
    const val HERO_OVERVIEW = 22f
    /** .actions margin-top --space-6 24px: gap between the hero copy and its buttons. */
    const val HERO_ACTIONS_TOP = 24f
    /** .home-hero margin-bottom --space-9 36px. */
    const val HERO_BOTTOM = 36f
    /** Hero.jsx ROTATE_MS; six titles. */
    const val HERO_ROTATE_MS = 8000L
    const val HERO_COUNT = 6

    // Detail page (nav.css, globals.css .hero / .hero-inner, tv-compact.css).
    /** .detail padding-top --space-4 + 3vh = 16 + 32.4 = 48.4px. */
    const val DETAIL_TOP = 48.4f
    /** .detail-back 21px, min 56px. */
    const val BACK_FONT = 21f
    /** .hero-inner padding --space-11 44px top, --space-7 28px bottom; poster 168px 2/3; gap 30px. */
    const val DETAIL_PAD_TOP = 44f
    const val DETAIL_PAD_BOTTOM = 28f
    const val DETAIL_POSTER_W = 168f
    const val DETAIL_POSTER_GAP = 30f
    /** --hero-title-size clamp(36px,3vw,52px) = 52px; .tagline 14.5px; .detail-overview 24px / 1.5, 3 lines; meta 20px. */
    const val DETAIL_TITLE = 52f
    const val TAGLINE = 14.5f
    const val DETAIL_OVERVIEW = 24f
    const val DETAIL_META = 20f
    /** .ep-still 220px 16/9; .ep-body b 24px; .ep-meta 19px. */
    const val EP_W = 220f
    const val EP_TITLE = 24f
    const val EP_META = 19f
    /** .person 104px; b 19px; span 17px. */
    const val PERSON = 104f
    const val PERSON_NAME = 19f
    const val PERSON_ROLE = 17f
    /** .facts margin-top --space-10 40px, padding-top --space-6 24px, gap 22px 32px; .fact .k 10.5px; .v 14px. */
    const val FACT_K = 10.5f
    const val FACT_V = 14f

    // Browse / search / list pages.
    /** .page-title 44px; .search-input clamp(22px,1.5vw,30px) = 28.8px; .result-count 20px; .empty 22px. */
    const val PAGE_TITLE = 44f
    const val SEARCH_INPUT = 28.8f
    const val SUMMARY = 20f
}

/**
 * Web dpad.js cardBelow(): in the next row, the card with the most horizontal
 * overlap with the focused one wins, then the nearest centre. Returns null when
 * the row has no candidate on screen.
 */
internal fun <K> pickBelow(fromLeft: Float, fromRight: Float, candidates: List<Pair<K, Pair<Float, Float>>>): K? {
    val cx = (fromLeft + fromRight) / 2f
    var best: K? = null
    var bestOverlap = -1f
    var bestDx = Float.MAX_VALUE
    for ((k, span) in candidates) {
        val (l, r) = span
        val overlap = maxOf(0f, minOf(fromRight, r) - maxOf(fromLeft, l))
        val dx = kotlin.math.abs((l + r) / 2f - cx)
        if (overlap > bestOverlap || (overlap == bestOverlap && dx < bestDx)) {
            best = k; bestOverlap = overlap; bestDx = dx
        }
    }
    return best
}

/**
 * The next row to move to from slot [from] in direction [dir] (+1 down, -1 up),
 * skipping rows with nothing focusable (still loading). null at the top or
 * bottom of the page: web dpad.js never sends a vertical move from the page
 * into the side rail, so the caller consumes the key and focus stays put.
 */
internal fun nextSlot(from: Int, dir: Int, focusable: List<Boolean>): Int? {
    var j = from + dir
    while (j in focusable.indices) {
        if (focusable[j]) return j
        j += dir
    }
    return null
}

/** Web rail: Up/Down stay inside it with no wrap; Left from the rail goes nowhere. */
internal fun railStep(at: Int, dir: Int, size: Int): Int = (at + dir).coerceIn(0, size - 1)
