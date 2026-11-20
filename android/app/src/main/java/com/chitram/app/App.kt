package com.chitram.app

import android.app.Application
import coil.ImageLoader
import coil.ImageLoaderFactory
import coil.disk.DiskCache
import coil.memory.MemoryCache
import com.chitram.app.data.Api
import com.chitram.app.data.LanguagePrefs
import com.chitram.app.data.LastProviderStore
import com.chitram.app.data.MyListStore
import com.chitram.app.data.PlayerPrefs
import com.chitram.app.data.PrefsKeyValue
import com.chitram.app.data.ProgressStore
import com.chitram.app.data.RecentSearchStore
import com.chitram.app.player.Device
import com.chitram.app.player.MediaCodecSupport

/** One small object graph for the whole app. No DI framework: it is lite. */
class App : Application(), ImageLoaderFactory {
    lateinit var api: Api
    lateinit var prefs: LanguagePrefs
    lateinit var progress: ProgressStore
    lateinit var myList: MyListStore
    lateinit var lastProvider: LastProviderStore
    lateinit var recent: RecentSearchStore
    lateinit var playerPrefs: PlayerPrefs
    val codecs = MediaCodecSupport()
    var isTv = false
        private set

    override fun onCreate() {
        super.onCreate()
        instance = this
        val kv = PrefsKeyValue(this)
        api = Api(Api.buildClient(cacheDir))
        prefs = LanguagePrefs(kv)
        progress = ProgressStore(kv)
        myList = MyListStore(kv)
        lastProvider = LastProviderStore(kv)
        recent = RecentSearchStore(kv)
        playerPrefs = PlayerPrefs(kv)
        isTv = Device.isTv(this)
    }

    /** Coil shares the API's OkHttp pool; small memory cache for the 1 GB stick. */
    override fun newImageLoader(): ImageLoader = ImageLoader.Builder(this)
        .okHttpClient { api.client.newBuilder().cache(null).build() }
        .memoryCache { MemoryCache.Builder(this).maxSizePercent(if (isTv) 0.15 else 0.2).build() }
        .diskCache { DiskCache.Builder().directory(cacheDir.resolve("img")).maxSizeBytes(80L * 1024 * 1024).build() }
        .crossfade(false)
        .respectCacheHeaders(false)
        .build()

    companion object {
        lateinit var instance: App
            private set
    }
}
