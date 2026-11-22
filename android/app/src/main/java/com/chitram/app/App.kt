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
import com.chitram.app.resolve.StreamCache
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
    /** HLS playlist bodies kept in memory with the kept rows (PlaylistCache). */
    val playlists = com.chitram.app.resolve.PlaylistCache()
    /** "Refresh sources": one per title per 30 s, shared by the details page and the player. */
    lateinit var refresh: com.chitram.app.resolve.SourceRefresh
    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    val codecs = MediaCodecSupport()
    var isTv = false
        private set

    override fun onCreate() {
        super.onCreate()
        instance = this
        val kv = PrefsKeyValue(this)
        // Resolved rows (VM and on-device) kept 30 min, so a reopen or a second Play fetches nothing.
        // Gap X10: in their own prefs file. At the 50-title cap the blob is large, and
        // every put rewrites its whole file: the shared `chitram` file stays small.
        val streamCache = StreamCache(PrefsKeyValue(this, StreamCache.PREFS_FILE))
        // The copy builds up to 1.2.49 kept in the shared file.
        kv.put(StreamCache.KV_KEY, null)
        val cm = runCatching { getSystemService(android.net.ConnectivityManager::class.java) }.getOrNull()
        api = Api(Api.buildClient(), httpCache = Api.httpCache(cacheDir), vm = com.chitram.app.data.VmHealth(kv), streamCache = streamCache)
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
            cache = streamCache,
            playlists = playlists,
            warmPlaylists = { row, preferred -> warmPlaylists(row, preferred) },
            offline = { com.chitram.app.player.NetState.offline(cm) },
            metered = { com.chitram.app.player.NetState.metered(cm) },
        )
        refresh = com.chitram.app.resolve.SourceRefresh(onDevice, vm = { t, i, s, e -> api.streams(t, i, s, e, refresh = true) }, vmUp = { api.vmUp })
        appScope.launch { resolveConfig.get() }
    }

    /** Gap 3.7: Android asks for memory back (Fire TV Stick, 1 GB): the kept playlists go (PlaylistCache.trim). */
    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        val n = playlists.trim(level)
        if (n > 0) android.util.Log.i("Chitram", "[playlist] trim level=$level: $n kept playlist(s) dropped")
    }

    /** Prewarm's top row: its master and first playlists into memory, no segments. Never a VM url. */
    private suspend fun warmPlaylists(row: com.chitram.app.data.Source, preferred: String) {
        val host = com.chitram.app.player.DirectRoute.host(row.url)
        if (host == com.chitram.app.player.DirectRoute.host(com.chitram.app.data.Api.VM) || row.progressive) return
        val t0 = System.currentTimeMillis()
        val done = kotlinx.coroutines.withContext(Dispatchers.IO) {
            com.chitram.app.resolve.PlaylistInterceptor.warm(api.client, playlists, row.url, row.headers, row.segmentToken,
                com.chitram.app.player.PlayerVm.isoFor(preferred).toList())
        }
        if (done) android.util.Log.i("Chitram", "[playlist] warmed ${row.provider} $host master in ${System.currentTimeMillis() - t0}ms")
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
