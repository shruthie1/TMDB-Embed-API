package com.chitram.app.ui.common

/**
 * Detail page shape by window size (owner 2026-11-24). Phone landscape showed the
 * backdrop as a 43% strip and pushed Play below the screen edge.
 *
 * WIDE (landscape phone, tablet, TV): the backdrop fills the whole first screen
 * behind a left and bottom scrim; poster, title, meta and the action row sit
 * bottom-left, all above the fold.
 * TALL (portrait phone): 16:9 backdrop on top, poster overlap, Play below.
 */
object DetailLayout {
    enum class Mode { TALL, WIDE }

    fun mode(widthDp: Float, heightDp: Float): Mode = if (widthDp > heightDp) Mode.WIDE else Mode.TALL

    /** Portrait backdrop block: 16:9 of the width plus 40 dp for the poster overlap. */
    fun tallArtHeight(widthDp: Float): Float = widthDp * 9f / 16f + 40f

    /** Wide hero height: the visible screen, less a bottom system bar when there is one. */
    fun wideHeroHeight(screenHeightDp: Float, bottomBarDp: Float): Float = (screenHeightDp - bottomBarDp).coerceAtLeast(MIN_WIDE_HERO)

    /**
     * Height the wide hero content needs from the top of the screen: status bar,
     * Back pill, then the poster (2:3) or the text column, whichever is taller,
     * and the bottom margin. Tests use it to prove Play is above the fold.
     */
    fun wideContentHeight(statusDp: Float): Float =
        statusDp + BACK_BLOCK + maxOf(WIDE_POSTER_W * 1.5f, WIDE_TEXT_COLUMN) + WIDE_BOTTOM

    const val MIN_WIDE_HERO = 280f
    const val WIDE_POSTER_W = 96f
    /** Back pill (36) and its 8 dp top margin, plus 8 dp air. */
    const val BACK_BLOCK = 52f
    /** Logo/title 56, tagline 22, meta 28, action row 12 + 44. */
    const val WIDE_TEXT_COLUMN = 162f
    const val WIDE_BOTTOM = 16f
}

/**
 * Play/Resume holds focus on the details page from the first frame (owner
 * 2026-11-24: "focus on play and resume buttons on loading"). TV composed Play
 * only after the title landed, so the skeleton held no focus and the root
 * fallback put it on Back. Play is now composed in every state, as the same
 * node, so loading -> loaded and Play -> Resume keep focus.
 */
object DetailFocus {
    enum class Press { PLAY, QUEUE, RETRY }

    /** What OK on the Play slot does: play, wait for the title, or retry a failed load. */
    fun press(loaded: Boolean, failed: Boolean): Press = when {
        loaded -> Press.PLAY
        failed -> Press.RETRY
        else -> Press.QUEUE
    }

    fun label(loaded: Boolean, failed: Boolean, playLabel: String): String =
        if (!loaded && failed) "Try again" else playLabel

    /** Ask for focus when the title lands only if Play never had it (a viewer on Back stays). */
    fun focusOnLoad(playFocusedBefore: Int): Boolean = playFocusedBefore == 0
}
