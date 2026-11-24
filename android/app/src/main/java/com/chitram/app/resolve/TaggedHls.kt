package com.chitram.app.resolve

/**
 * One row from a master whose ONLY language source is its own
 * #EXT-X-MEDIA:TYPE=AUDIO LANGUAGE tags (server twin lib/media/taggedHlsRow.js).
 * Used by Insertunit and VIDOUT (MultiMovies servers, 2026-11-24).
 *
 * - Audio: the first variant's group only. Insertunit repeats every rendition
 *   in a failover group, which would double the Audio menu.
 * - An untagged rendition stays unknown: its NAME is not kept, so no label is
 *   read back from it (AudioTrack.label falls back to the name).
 * - DEFAULT stays as the master says. The player picks the viewer's language
 *   (setPreferredAudioLanguages), not the DEFAULT=YES Russian track.
 */
object TaggedHls {
    fun row(text: String, url: String, provider: String, label: String, headers: Map<String, String>): Resolved? {
        val m = Hls.parse(text, url)
        if (m.levels.isEmpty()) return null
        val lines = text.lines().map { it.trim() }
        val group = lines.filter { it.startsWith("#EXT-X-STREAM-INF:") }.map(Hls::attrs)
            .sortedWith(compareByDescending<Map<String, String>> { it["RESOLUTION"]?.substringAfter('x')?.toIntOrNull() ?: 0 }
                .thenByDescending { it["BANDWIDTH"]?.toLongOrNull() ?: 0 }).firstOrNull()?.get("AUDIO")
        val audio = lines.filter { it.startsWith("#EXT-X-MEDIA:") }.map { Hls.attrs(it) }
            .filter { it["TYPE"] == "AUDIO" && (group == null || it["GROUP-ID"] == null || it["GROUP-ID"] == group) }
            .map { a ->
                val lang = a["LANGUAGE"]?.trim()?.takeIf { it.isNotEmpty() }
                AudioTrack(lang, a["NAME"], a["DEFAULT"] == "YES", tagged = true)
            }
        return Resolved(
            provider = provider,
            label = label,
            url = url,
            headers = headers,
            audioTagsOnly = true,
            segmentToken = null,
            audio = audio,
            levels = m.levels,
            codecs = m.codecs,
            key = "$provider-" + MultiMoviesResolver.masterKey(url),
        )
    }

    /** `[name] ok <id> in <ms>ms rows=1 langs=[..]` detail line. */
    fun langsOf(r: Resolved): String = Hls.languages(r.audio).joinToString(",")
}
