@file:OptIn(UnstableApi::class)

package com.chitram.app.player

import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.upstream.BandwidthMeter
import com.chitram.app.resolve.StartCap

/**
 * The player's bandwidth meter with the start cap (StartCap): while [capped]
 * (a play() before its first frame) the adaptive selection sees at most
 * StartCap.START_BPS, so the first segments come from a lower rendition. After
 * the first frame it sees the measured estimate and climbs on its own, with no
 * track reselection (a reselection would drop the buffered segment).
 */
class StartCapMeter(private val inner: BandwidthMeter) : BandwidthMeter by inner {
    @Volatile var capped = false

    override fun getBitrateEstimate(): Long = StartCap.estimate(inner.bitrateEstimate, capped)
    override fun getTimeToFirstByteEstimateUs(): Long = inner.timeToFirstByteEstimateUs
}
