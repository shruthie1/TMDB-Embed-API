package com.chitram.app.player

import com.chitram.app.data.Source

object AudioChoice {
    fun knownLanguage(value: String?): Boolean = !value.isNullOrBlank() && !Regex("^(?:track|audio|default|unknown|und|original)(?:\\s*[-#]?\\s*\\d+)?$", RegexOption.IGNORE_CASE).matches(value.trim())
    fun languages(source: Source): List<String> {
        val offered = if (source.selectableAudio) source.audioLanguages ?: source.languages else (source.audioLanguages?.takeIf { it.isNotEmpty() } ?: source.languages).take(1)
        return offered.mapNotNull(com.chitram.app.data.Ranking::languageLabel).filter(::knownLanguage).distinctBy { it.lowercase() }
    }
    fun index(sources: List<Source>): Map<String, List<Source>> = buildMap {
        for (source in sources) for (language in languages(source)) {
            val rows = get(language).orEmpty()
            if (rows.none { it.id == source.id }) put(language, rows + source)
        }
    }
    fun candidates(sources: List<Source>, language: String, tried: Set<String> = emptySet()): List<Source> =
        index(sources).entries.firstOrNull { it.key.equals(com.chitram.app.data.Ranking.languageLabel(language), true) }?.value.orEmpty()
            .filter { !it.unsupported && it.id !in tried }

    fun source(key: String, sources: List<Source>): Pair<Source, String?>? {
        if (!key.startsWith("src:")) return null
        val rest = key.removePrefix("src:")
        val source = sources.sortedByDescending { it.id.length }.firstOrNull { rest == it.id || rest.startsWith("${it.id}:") } ?: return null
        val language = rest.removePrefix(source.id).removePrefix(":").takeIf { it.isNotBlank() }
        val offered = languages(source)
        val canonical = com.chitram.app.data.Ranking.languageLabel(language)
        if (language != null && (canonical == null || offered.none { com.chitram.app.data.Ranking.languageLabel(it)?.equals(canonical, true) == true })) return null
        return source to canonical
    }
}
