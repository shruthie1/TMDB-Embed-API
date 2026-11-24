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
    /** TMDB original_title when the API sends it; Castle tries it after `title`. */
    val originalTitle: String? = null,
    val tagline: String? = null,
    val seasons: Int? = null,
    val seasonList: List<SeasonInfo> = emptyList(),
    /** Cast with photos, in billing order (web CastRow). */
    val credits: List<Credit> = emptyList(),
    val director: List<String> = emptyList(),
    val writers: List<String> = emptyList(),
    val country: List<String> = emptyList(),
    /** For providers keyed by imdb (vaplayer resolves on the device). */
    val imdbId: String? = null,
    /** TMDB title logo path (server pickLogo: original language, en, none); null shows the text title. */
    val logo: String? = null,
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

/**
 * One measured audio track/rendition (utils/streamSchema.js audio[]). Every field
 * is optional so cached JSON with only `language` still parses.
 */
@Serializable
data class RawAudio(
    val language: String? = null,
    val languageCode: String? = null,
    val name: String? = null,
    val uri: String? = null,
    val channels: Double? = null,
    val codec: String? = null,
    @kotlinx.serialization.SerialName("default") val isDefault: Boolean = false,
)

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
    /** null: legacy/unknown metadata; []: provider explicitly found no renditions. */
    val audio: List<RawAudio>? = null,
    val providerGroup: String? = null,
    val serverLabel: String? = null,
    val audioTagsOnly: Boolean = false,
    /** Availability labels from a catalog, never proof of selectable audio. */
    val catalogLanguages: List<String> = emptyList(),
    val netmirrorCatalog: String? = null,
    /**
     * Upstream url and its request headers, sent when the server's provider
     * config (lib/routing/providerRoutes.js) says a client may skip the VM
     * proxy. `url` stays proxied for older builds. Header values are read as
     * JSON elements so one odd value can never fail the whole parse.
     */
    val directUrl: String? = null,
    val directHeaders: Map<String, kotlinx.serialization.json.JsonElement> = emptyMap(),
    val route: RawRoute? = null,
)

/** Per-client route for one row: "direct" or "proxy". */
@Serializable
data class RawRoute(val web: String? = null, val apk: String? = null)

@Serializable
data class StreamsResponse(
    val success: Boolean = false,
    val count: Int = 0,
    val partial: Boolean = false,
    val providerTimings: Map<String, Long?> = emptyMap(), // a provider that timed out reports null
    val streams: List<RawStream> = emptyList(),
    /** Providers that threw (strings today; any shape is kept so a change never breaks the parse). */
    val providerErrors: List<kotlinx.serialization.json.JsonElement> = emptyList(),
    /** Provider-specific responses may include usable rows plus an incomplete/error reason. */
    val providerError: String? = null,
) {
    /**
     * A9: the VM sent only the ready rows (`partial`, PRIMARY_PROVIDERS) or a
     * provider threw. Ask once more with ?full=1, as web/lib/backend.js does.
     */
    val wantsFull: Boolean get() = partial || providerErrors.isNotEmpty() || !providerError.isNullOrEmpty()
}
