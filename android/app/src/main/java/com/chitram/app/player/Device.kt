package com.chitram.app.player

import android.app.UiModeManager
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.media.MediaCodecList
import com.chitram.app.data.CodecSupport

object Device {
    fun isTv(context: Context): Boolean {
        val ui = context.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager
        if (ui?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION) return true
        val pm = context.packageManager
        return pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK) ||
            pm.hasSystemFeature("amazon.hardware.fire_tv")
    }
}

/**
 * Hardware/software decoder check through MediaCodecList, mirroring
 * web/lib/player/codecSupport.js: AVC (or unknown) is assumed playable, other
 * families are probed. The Fire TV 4K decodes HEVC, so mapple's HEVC rows are
 * kept and only ranked last where no decoder exists.
 */
class MediaCodecSupport : CodecSupport {
    private val mimes: Set<String> by lazy {
        runCatching {
            MediaCodecList(MediaCodecList.ALL_CODECS).codecInfos
                .filter { !it.isEncoder }
                .flatMap { it.supportedTypes.map(String::lowercase) }
                .toSet()
        }.getOrDefault(emptySet())
    }

    override fun supports(videoCodec: String?, codecString: String?): Boolean? {
        val family = familyOf(videoCodec, codecString) ?: return null
        if (family == "avc") return true
        val mime = MIME[family] ?: return null
        if (mimes.isEmpty()) return null
        return mime in mimes
    }

    companion object {
        private val MIME = mapOf(
            "hevc" to "video/hevc",
            "av1" to "video/av01",
            "vp9" to "video/x-vnd.on2.vp9",
        )

        /** Family from the backend's videoCodec, else from an RFC 6381 CODECS string. */
        fun familyOf(videoCodec: String?, codecString: String?): String? {
            val v = videoCodec?.lowercase()
            if (!v.isNullOrEmpty()) return v
            val entry = codecString?.split(',')?.map { it.trim().lowercase() }
                ?.firstOrNull { Regex("^(hvc1|hev1|avc1|avc3|av01|vp09)").containsMatchIn(it) } ?: return null
            return when {
                entry.startsWith("hvc1") || entry.startsWith("hev1") -> "hevc"
                entry.startsWith("av01") -> "av1"
                entry.startsWith("vp09") -> "vp9"
                else -> "avc"
            }
        }
    }
}
