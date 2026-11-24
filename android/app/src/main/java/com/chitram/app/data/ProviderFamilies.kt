package com.chitram.app.data

/** UI grouping never changes the provider identity used for routes, headers or playback reports. */
object ProviderFamilies {
    private val mm=mapOf("multimovies" to "VidBolt", "vidrift" to "Vidrift", "insertunit" to "Insertunit", "vidout" to "VIDOUT", "gdmirror" to "GD mirror", "cineverse" to "Cineverse", "nexus" to "Nexus")
    fun group(source: Source): String = source.providerGroup ?: if(source.provider.lowercase() in mm) "MultiMovies" else source.provider
    fun label(source: Source): String? = source.serverLabel ?: mm[source.provider.lowercase()]
}
