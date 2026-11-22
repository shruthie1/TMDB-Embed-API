package com.chitram.app.player

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.chitram.app.data.Source
import com.chitram.app.resolve.StreamInterceptor
import com.chitram.app.resolve.TsAudioSwap
import okhttp3.OkHttpClient

/**
 * C5 lifecycle: one [LanProxy] per process, for the row being cast.
 *
 * Starts when a cast of an on-device row begins. Stops on: the notification's
 * Stop, a new cast (replaced), playback resuming on the phone, 15 minutes with
 * no TV request (the TV stopped), or the task being swiped away. It does NOT stop
 * when the app goes to the background: WVC takes the foreground the moment the
 * cast starts, and the TV keeps fetching from the phone after that. The
 * foreground service keeps the process from being frozen meanwhile.
 */
object CastProxy {
    @Volatile private var proxy: LanProxy? = null

    /** The phone's LAN URL for this row's stream, or null (no Wi-Fi address: cast directly). */
    @Synchronized
    fun start(ctx: Context, s: Source, base: OkHttpClient, preferredAudio: String): String? {
        stop(ctx)
        val addr = LanProxy.lanAddress() ?: run {
            android.util.Log.w("Chitram", "[lanproxy] no Wi-Fi address, casting ${s.provider} directly")
            return null
        }
        val client = StreamInterceptor.forRow(base, s)
            .let { c -> if (TsAudioSwap.wanted(s)) c.newBuilder().addInterceptor(TsAudioSwap(preferredAudio)).build() else c }
        val app = ctx.applicationContext
        lateinit var p: LanProxy
        p = LanProxy(client, addr, onIdle = { if (proxy === p) stop(app) })
        proxy = p
        startService(app)
        android.util.Log.i("Chitram", "[lanproxy] casting ${s.provider} via ${addr.hostAddress}:${p.port}")
        p.topUpstream = s.url
        return p.urlFor(s.url, playlist = !s.progressive)
    }

    /**
     * P23: a MultiMovies DASH row when the VM is down. Fetches the signed MPD
     * (and each video rep's ~3 KB init, for the full hvcC CODECS), then serves
     * the HLS master and media playlists over the LAN. Segment lines stay
     * signed sacdn URLs: no video passes the phone. Returns the master URL, or
     * null (no Wi-Fi address, MPD unreadable). Blocking: call off the main thread.
     */
    @Synchronized
    fun startDash(ctx: Context, s: Source, base: OkHttpClient): String? {
        stop(ctx)
        val signed = DashCast.parse(s.url) ?: return null
        val addr = LanProxy.lanAddress() ?: run {
            android.util.Log.w("Chitram", "[lanproxy] no Wi-Fi address, cannot cast ${s.provider} DASH")
            return null
        }
        val client = StreamInterceptor.forRow(base, s)
        val text = client.newCall(okhttp3.Request.Builder().url(s.url).build()).execute().use { r ->
            if (!r.isSuccessful) { android.util.Log.w("Chitram", "[lanproxy] dash mpd HTTP ${r.code}"); return null }
            r.body?.string().orEmpty()
        }
        val parsed = try { MpdHls.parseMpd(text) } catch (e: IllegalArgumentException) {
            android.util.Log.w("Chitram", "[lanproxy] dash mpd unusable: ${e.message}"); return null
        }
        // Full CODECS from each video rep's init (bare "hev1" fails isTypeSupported in browsers). Any miss: no CODECS at all.
        val codecs = parsed.reps.filter { it.kind == "video" }.map { r ->
            r.id to r.init?.let { init ->
                try {
                    client.newCall(okhttp3.Request.Builder().url("${signed.folder}$init?${signed.query}").build()).execute().use { res ->
                        if (res.isSuccessful) res.body?.bytes()?.let(MpdHls::codecFromInit) else null
                    }
                } catch (_: Exception) { null }
            }
        }.let { pairs -> if (pairs.all { it.second != null }) pairs.associate { it.first to it.second!! } else emptyMap() }
        val lang = MpdHls.languageOf(DashCast.rowLanguage(s))
        val app = ctx.applicationContext
        lateinit var p: LanProxy
        var pages: (String) -> MpdHls.Page? = { null }
        p = LanProxy(client, addr, onIdle = { if (proxy === p) stop(app) }, pages = { pages(it) })
        pages = DashCast.pages(parsed, signed, codecs, lang) { p.pageUrl(it) }
        proxy = p
        startService(app)
        android.util.Log.i("Chitram", "[lanproxy] casting ${s.provider} DASH as HLS via ${addr.hostAddress}:${p.port}" +
            " video=${parsed.reps.count { it.kind == "video" }} lang=${lang?.code ?: "mpd"} codecs=${codecs.values.firstOrNull() ?: "none"}")
        return p.pageUrl("master.m3u8")
    }

    /** What the receiver fetched from the running proxy (cast watch), or null. */
    val seen: CastWatch.Seen? get() = proxy?.takeIf { !it.closed }?.seen

    val running: Boolean get() = proxy?.closed == false

    /** P23: a cast watch is running (VM route): keep the process up meanwhile. */
    @Volatile var watching: Boolean = false
        private set

    /** Called when the Stop action ends the cast: cancels the watch too. */
    @Volatile var onStopped: (() -> Unit)? = null

    fun beginWatch(ctx: Context) {
        watching = true
        startService(ctx.applicationContext)
    }

    fun endWatch(ctx: Context) {
        watching = false
        if (!running) try { ctx.applicationContext.stopService(Intent(ctx.applicationContext, CastProxyService::class.java)) } catch (_: Exception) {}
    }

    private fun startService(app: Context) {
        try {
            ContextCompat.startForegroundService(app, Intent(app, CastProxyService::class.java))
        } catch (e: Exception) {
            android.util.Log.w("Chitram", "[lanproxy] no foreground service: ${e.javaClass.simpleName}")
        }
    }

    @Synchronized
    fun stop(ctx: Context) {
        val p = proxy ?: return
        proxy = null
        p.close()
        val app = ctx.applicationContext
        if (!watching) try { app.stopService(Intent(app, CastProxyService::class.java)) } catch (_: Exception) {}
    }
}

/** Keeps the LAN proxy alive while WVC is in front, with a Stop action. */
class CastProxyService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            CastProxy.onStopped?.invoke()
            CastProxy.endWatch(this)
            CastProxy.stop(this)
            stopSelf()
            return START_NOT_STICKY
        }
        val type = if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0
        ServiceCompat.startForeground(this, ID, notification(), type)
        if (!CastProxy.running && !CastProxy.watching) stopSelf()
        return START_NOT_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        CastProxy.onStopped?.invoke()
        CastProxy.endWatch(this)
        CastProxy.stop(this)
        stopSelf()
    }

    private fun notification(): Notification {
        if (Build.VERSION.SDK_INT >= 26) {
            getSystemService(NotificationManager::class.java)?.createNotificationChannel(
                NotificationChannel(CHANNEL, "Casting to TV", NotificationManager.IMPORTANCE_LOW))
        }
        val stop = PendingIntent.getService(this, 0, Intent(this, CastProxyService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle("Casting to TV")
            .setContentText("Chitram is sending the film to your TV")
            .setOngoing(true)
            .addAction(0, "Stop", stop)
            .build()
    }

    companion object {
        private const val ID = 4125
        private const val CHANNEL = "cast"
        const val ACTION_STOP = "com.chitram.app.CAST_STOP"
    }
}
