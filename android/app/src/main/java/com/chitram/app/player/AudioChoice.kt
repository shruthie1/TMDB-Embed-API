package com.chitram.app.player

import com.chitram.app.data.Source

object AudioChoice {
    fun source(key: String, sources: List<Source>): Pair<Source, String?>? {
        if (!key.startsWith("src:")) return null
        val rest = key.removePrefix("src:")
        val source = sources.sortedByDescending { it.id.length }.firstOrNull { rest == it.id || rest.startsWith("${it.id}:") } ?: return null
        val language = rest.removePrefix(source.id).removePrefix(":").takeIf { it.isNotBlank() }
        val offered = if (source.selectableAudio) source.audioLanguages ?: source.languages else source.languages.take(1)
        val canonical = com.chitram.app.data.Ranking.languageLabel(language)
        if (language != null && (canonical == null || offered.none { com.chitram.app.data.Ranking.languageLabel(it)?.equals(canonical, true) == true })) return null
        return source to canonical
    }
}
