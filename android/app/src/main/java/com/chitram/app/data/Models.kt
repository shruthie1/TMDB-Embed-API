package com.chitram.app.data

import kotlinx.serialization.Serializable

/** A card in a row or search result. Shape of /api/rows/:kind and /api/search. */
@Serializable
data class Title(
    val tmdbId: Long,
    val mediaType: String = "movie",
    val title: String = "",
    val poster: String? = null,
    val backdrop: String? = null,
    val year: Int? = null,
    val rating: Double? = null,
    val originalLang: String? = null,
    val overview: String? = null,
) {
    val key: String get() = "$mediaType:$tmdbId"
}

@Serializable
data class RowResponse(val kind: String = "", val titles: List<Title> = emptyList())

@Serializable
data class SearchResponse(val q: String = "", val titles: List<Title> = emptyList())

@Serializable
data class SeasonInfo(val number: Int, val name: String = "", val episodes: Int = 0)

/** /api/title/:type/:id/full */
@Serializable
data class TitleFull(
    val tmdbId: Long,
    val mediaType: String = "movie",
    val title: String = "",
    val overview: String? = null,
    val poster: String? = null,
    val backdrop: String? = null,
    val year: Int? = null,
    val rating: Double? = null,
    val genres: List<String> = emptyList(),
    val cast: List<String> = emptyList(),
    val runtimeMin: Int? = null,
    val originalLang: String? = null,
    val tagline: String? = null,
    val seasons: Int? = null,
    val seasonList: List<SeasonInfo> = emptyList(),
    /** Cast with photos, in billing order (web CastRow). */
    val credits: List<Credit> = emptyList(),
    val director: List<String> = emptyList(),
    val writers: List<String> = emptyList(),
    val country: List<String> = emptyList(),
) {
    fun asTitle() = Title(tmdbId, mediaType, title, poster, backdrop, year, rating, originalLang, overview)
}

/** One cast member in /api/title/:type/:id/full `credits`. */
@Serializable
data class Credit(val id: Long, val name: String = "", val character: String? = null, val profile: String? = null)

/** /api/person/:id */
@Serializable
data class Person(val id: Long, val name: String = "", val profile: String? = null, val knownFor: String? = null, val bio: String? = null)

@Serializable
data class PersonResponse(val person: Person? = null, val titles: List<Title> = emptyList())

/** /api/discover (Browse). */
@Serializable
data class DiscoverResponse(val page: Int = 1, val totalPages: Int = 1, val totalResults: Int = 0, val titles: List<Title> = emptyList())

@Serializable
data class Episode(
    val episode: Int,
    val season: Int,
    val title: String = "",
    val overview: String? = null,
    val still: String? = null,
    val runtimeMin: Int? = null,
    val airDate: String? = null,
    val rating: Double? = null,
)

@Serializable
data class SeasonResponse(val season: Int = 0, val episodes: List<Episode> = emptyList())

@Serializable
data class Level(val height: Int = 0, val quality: String? = null, val bandwidth: Long = 0, val codecs: String? = null)

@Serializable
data class SubtitleRef(val url: String = "", val lang: String? = null, val id: String? = null)

/** One stream in /api/streams. Canonical shape from utils/streamSchema.js. */
@Serializable
data class RawStream(
    val url: String? = null,
    val provider: String? = null,
    val name: String? = null,
    val title: String? = null,
    val quality: String? = null,
    val levels: List<Level> = emptyList(),
    val languages: List<String> = emptyList(),
    val subtitles: List<SubtitleRef> = emptyList(),
    val container: String? = null,
    val selectableAudio: Boolean = false,
    val hybrid: Boolean = false,
    val codecs: String? = null,
    val videoCodec: String? = null,
)

@Serializable
data class StreamsResponse(
    val success: Boolean = false,
    val count: Int = 0,
    val partial: Boolean = false,
    val providerTimings: Map<String, Long?> = emptyMap(), // a provider that timed out reports null
    val streams: List<RawStream> = emptyList(),
)
