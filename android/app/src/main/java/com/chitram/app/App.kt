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
import com.chitram.app.resolve.HostBook
import com.chitram.app.resolve.MappleResolver
import com.chitram.app.resolve.OnDeviceResolver
import com.chitram.app.resolve.ResolveConfigStore
import com.chitram.app.resolve.VaplayerResolver
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** One small object graph for the whole app. No DI framework: it is lite. */
class App : Application(), ImageLoaderFactory {
    lateinit var api: Api
    lateinit var prefs: LanguagePrefs
    lateinit var progress: ProgressStore
    lateinit var myList: MyListStore
    lateinit var lastProvider: LastProviderStore
    lateinit var recent: RecentSearchStore
    lateinit var playerPrefs: PlayerPrefs
    lateinit var resolveConfig: ResolveConfigStore
    lateinit var onDevice: OnDeviceResolver
    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    val codecs = MediaCodecSupport()
    var isTv = false
        private set

    override fun onCreate() {
        super.onCreate()
        instance = this
        val kv = PrefsKeyValue(this)
        api = Api(Api.buildClient(), httpCache = Api.httpCache(cacheDir), vm = com.chitram.app.data.VmHealth(kv))
        prefs = LanguagePrefs(kv)
        progress = ProgressStore(kv)
        myList = MyListStore(kv)
        lastProvider = LastProviderStore(kv)
        recent = RecentSearchStore(kv)
        playerPrefs = PlayerPrefs(kv)
        isTv = Device.isTv(this)
        // mapple and vaplayer resolve from this device; their hosts, paths and
        // fronts can be overridden by the backend (fetched now, cached with a TTL).
        // VM merged view first; the static web copy when the VM fails or is paused.
        resolveConfig = ResolveConfigStore(
            api.client, Api.BASE + ResolveConfigStore.PATH, kv,
            remoteUrl = Api.BASE + ResolveConfigStore.REMOTE_PATH, vmUp = { api.vmUp },
        )
        val hosts = HostBook(kv)
        onDevice = OnDeviceResolver(
            api, resolveConfig,
            MappleResolver(api.client, hosts, kv),
            VaplayerResolver(api.client, hosts) { runCatching { assets.open("va.wasm").use { it.readBytes() } }.getOrNull() },
            castle = com.chitram.app.resolve.CastleResolver(api.client, hosts = hosts, config = { resolveConfig.current().castletv }),
            multimovies = com.chitram.app.resolve.MultiMoviesResolver(api.client, hosts = hosts, config = { resolveConfig.current().multimovies }),
            netmirror = com.chitram.app.resolve.NetmirrorResolver(api.client, otp = { kv.get("netmirror.otp") ?: "111111" }, kv = kv),
        )
        appScope.launch { resolveConfig.get() }
    }

    /**
     * Coil shares the API's OkHttp pool (no HTTP cache; Coil has its own).
     * TMDB images are immutable per URL, so cache headers are ignored and the
     * disk cache keeps them across launches. Small memory cache for the 1 GB stick.
     */
    override fun newImageLoader(): ImageLoader = ImageLoader.Builder(this)
        .okHttpClient { api.client }
        .memoryCache { MemoryCache.Builder(this).maxSizePercent(if (isTv) 0.15 else 0.2).build() }
        .diskCache { DiskCache.Builder().directory(cacheDir.resolve("img")).maxSizeBytes(if (isTv) 128L * 1024 * 1024 else 256L * 1024 * 1024).build() }
        .crossfade(false)
        .respectCacheHeaders(false)
        .build()

    companion object {
        lateinit var instance: App
            private set
    }
}
