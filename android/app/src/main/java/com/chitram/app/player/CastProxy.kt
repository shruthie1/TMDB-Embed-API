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
        val client = StreamInterceptor.client(base, s.headers, s.segmentToken)
            .let { c -> if (TsAudioSwap.wanted(s)) c.newBuilder().addInterceptor(TsAudioSwap(preferredAudio)).build() else c }
        val app = ctx.applicationContext
        lateinit var p: LanProxy
        p = LanProxy(client, addr, onIdle = { if (proxy === p) stop(app) })
        proxy = p
        try {
            ContextCompat.startForegroundService(app, Intent(app, CastProxyService::class.java))
        } catch (e: Exception) {
            android.util.Log.w("Chitram", "[lanproxy] no foreground service: ${e.javaClass.simpleName}")
        }
        android.util.Log.i("Chitram", "[lanproxy] casting ${s.provider} via ${addr.hostAddress}:${p.port}")
        return p.urlFor(s.url, playlist = !s.progressive)
    }

    val running: Boolean get() = proxy?.closed == false

    @Synchronized
    fun stop(ctx: Context) {
        val p = proxy ?: return
        proxy = null
        p.close()
        val app = ctx.applicationContext
        try { app.stopService(Intent(app, CastProxyService::class.java)) } catch (_: Exception) {}
    }
}

/** Keeps the LAN proxy alive while WVC is in front, with a Stop action. */
class CastProxyService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            CastProxy.stop(this)
            stopSelf()
            return START_NOT_STICKY
        }
        val type = if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0
        ServiceCompat.startForeground(this, ID, notification(), type)
        if (!CastProxy.running) stopSelf()
        return START_NOT_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
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
