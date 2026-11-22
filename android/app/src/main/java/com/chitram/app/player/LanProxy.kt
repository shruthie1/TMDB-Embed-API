package com.chitram.app.player

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.InputStream
import java.io.OutputStream
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.security.SecureRandom
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * C5: a tiny HTTP server on the phone's Wi-Fi address that lets the TV cast an
 * on-device row. The TV cannot send Referer, and WVC does not add vaplayer's
 * per-segment ?token=, so the TV fetches from the phone and the phone fetches
 * upstream through [client], which already carries the provider headers, the
 * token (StreamInterceptor) and the Castle audio swap when the row needs it.
 *
 * Every playlist is rewritten so each URI (variants, renditions, segments, keys,
 * init) points back here. Only LAN peers get an answer, only on paths that
 * start with the random [key], and the socket binds to [bind] only (the Wi-Fi
 * address), never to every interface.
 */
class LanProxy(
    private val client: OkHttpClient,
    private val bind: InetAddress,
    private val allow: (InetAddress) -> Boolean = ::isLan,
    private val idleMs: Long = IDLE_MS,
    private val tickMs: Long = 30_000,
    private val onIdle: () -> Unit = {},
    private val pages: ((String) -> MpdHls.Page?)? = null,
    private val self: (InetAddress) -> Boolean = { it == bind },
) : Closeable {
    /** What the receiver fetched (cast watch). Requests from the phone itself ([self]) do not count. */
    @Volatile var seen: CastWatch.Seen = CastWatch.Seen()
        private set
    /** The upstream URL handed to the receiver (its master, or the progressive file). */
    @Volatile var topUpstream: String? = null

    /** The phone URL of a built page (P23 DASH cast: "master.m3u8", "<rep>.m3u8"). */
    fun pageUrl(name: String): String = "http://$host:$port/$key/p/$name"

    private fun note(from: InetAddress, master: Boolean, video: Boolean, ua: String?) {
        if (self(from) || (!master && !video)) return
        val now = System.currentTimeMillis()
        val s = seen
        seen = when {
            master && video -> s.copy(master = now, video = now, receiver = receiverId(ua, from))
            master -> s.copy(master = now, receiver = receiverId(ua, from))
            else -> s.copy(video = now)
        }
    }

    val key: String = ByteArray(12).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
    private val server = ServerSocket(0, 50, bind)
    val port: Int = server.localPort
    private val host = bind.hostAddress.let { if (bind is Inet6Address) "[${it.substringBefore('%')}]" else it }
    private val pool: ExecutorService = Executors.newCachedThreadPool { r -> Thread(r, "lan-proxy").apply { isDaemon = true } }
    @Volatile var closed = false; private set
    @Volatile private var lastHit = System.currentTimeMillis()

    init {
        Thread({ acceptLoop() }, "lan-proxy-accept").apply { isDaemon = true }.start()
        Thread({ idleLoop() }, "lan-proxy-idle").apply { isDaemon = true }.start()
        android.util.Log.i("Chitram", "[lanproxy] listening on $host:$port")
    }

    /** The phone URL for one upstream URL. Playlists end in .m3u8 so receivers pick HLS. */
    fun urlFor(upstream: String, playlist: Boolean): String {
        val last = upstream.toHttpUrlOrNull()?.pathSegments?.lastOrNull().orEmpty()
            .filter { it.isLetterOrDigit() || it in "._-" }.take(60)
        val name = when {
            playlist && !last.endsWith(".m3u8") -> (last.ifEmpty { "index" }) + ".m3u8"
            else -> last.ifEmpty { "x" }
        }
        return "http://$host:$port/$key/${hex(upstream)}/$name"
    }

    /** The upstream URL for a request path, or null when the key or encoding is wrong. */
    fun upstreamFor(path: String): String? {
        val p = path.trimStart('/').split('/')
        if (p.size < 2 || p[0] != key) return null
        return unhex(p[1])
    }

    override fun close() {
        if (closed) return
        closed = true
        try { server.close() } catch (_: Exception) {}
        pool.shutdownNow()
        android.util.Log.i("Chitram", "[lanproxy] stopped $host:$port")
    }

    private fun idleLoop() {
        while (!closed) {
            try { Thread.sleep(tickMs) } catch (_: InterruptedException) { return }
            if (!closed && System.currentTimeMillis() - lastHit > idleMs) {
                android.util.Log.i("Chitram", "[lanproxy] idle ${idleMs / 1000}s, stopping")
                close()
                onIdle()
            }
        }
    }

    private fun acceptLoop() {
        while (!closed) {
            val s = try { server.accept() } catch (_: Exception) { break }
            try { pool.execute { serve(s) } } catch (_: Exception) { s.close() }
        }
    }

    private fun serve(sock: Socket) { sock.use { s -> serveOne(s) } }

    private fun serveOne(s: Socket) {
        try {
            s.soTimeout = 30_000
            val input = BufferedInputStream(s.getInputStream())
            val out = s.getOutputStream()
            val head = readHead(input) ?: return
            val lines = head.split("\r\n")
            val parts = lines[0].split(' ')
            if (parts.size < 2) return
            val method = parts[0].uppercase()
            val reqHeaders = lines.drop(1).mapNotNull { l -> l.indexOf(':').takeIf { it > 0 }?.let { l.substring(0, it).trim().lowercase() to l.substring(it + 1).trim() } }.toMap()
            if (!allow(s.inetAddress)) {
                android.util.Log.w("Chitram", "[lanproxy] refused ${s.inetAddress.hostAddress}")
                return writeStatus(out, 403, "Forbidden")
            }
            lastHit = System.currentTimeMillis()
            if (method == "OPTIONS") return writeHead(out, 204, "No Content", listOf("Content-Length" to "0"))
            if (method != "GET" && method != "HEAD") return writeStatus(out, 405, "Method Not Allowed")
            val path = parts[1].substringBefore('?')
            val seg = path.trimStart('/').split('/')
            if (seg.size == 3 && seg[0] == key && seg[1] == "p") {
                val page = pages?.invoke(seg[2]) ?: return writeStatus(out, 404, "Not Found")
                note(s.inetAddress, page.master, page.video, reqHeaders["user-agent"])
                val bytes = page.text.toByteArray(Charsets.UTF_8)
                writeHead(out, 200, "OK", listOf("Content-Type" to "application/vnd.apple.mpegurl", "Content-Length" to bytes.size.toString(), "Cache-Control" to "no-store"))
                if (method == "GET") out.write(bytes)
                out.flush()
                return
            }
            val upstream = upstreamFor(path) ?: return writeStatus(out, 404, "Not Found")
            val from = s.inetAddress
            val ua = reqHeaders["user-agent"]
            val rb = Request.Builder().url(upstream).header("Accept-Encoding", "identity")
            reqHeaders["range"]?.let { rb.header("Range", it) }
            if (method == "HEAD") rb.head()
            client.newCall(rb.build()).execute().use { res ->
                val playlist = relay(res, method, out)
                if (res.isSuccessful && method == "GET") note(from, master = upstream == topUpstream, video = !playlist, ua = ua)
            }
        } catch (e: Exception) {
            if (!closed) android.util.Log.w("Chitram", "[lanproxy] ${e.javaClass.simpleName}: ${e.message}")
        }
    }

    /** True when it relayed a playlist. */
    private fun relay(res: Response, method: String, out: OutputStream): Boolean {
        val body = res.body
        val type = res.header("Content-Type").orEmpty()
        val isPlaylist = res.isSuccessful && method == "GET" && body != null &&
            (type.contains("mpegurl", true) || res.peekBody(7).string() == "#EXTM3U")
        if (isPlaylist) {
            val text = rewrite(body!!.string(), res.request.url.toString()) { u, pl -> urlFor(u, pl) }
            val bytes = text.toByteArray(Charsets.UTF_8)
            writeHead(out, res.code, res.message, listOf("Content-Type" to "application/vnd.apple.mpegurl", "Content-Length" to bytes.size.toString()))
            out.write(bytes)
            out.flush()
            return true
        }
        val h = ArrayList<Pair<String, String>>()
        for (k in listOf("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges")) res.header(k)?.let { h += k to it }
        writeHead(out, res.code, res.message, h)
        if (method == "GET") body?.byteStream()?.copyTo(out, 64 * 1024)
        out.flush()
        return false
    }

    private fun writeStatus(out: OutputStream, code: Int, msg: String) =
        writeHead(out, code, msg, listOf("Content-Length" to "0"))

    private fun writeHead(out: OutputStream, code: Int, msg: String, headers: List<Pair<String, String>>) {
        val sb = StringBuilder("HTTP/1.1 $code ${msg.ifBlank { "OK" }}\r\n")
        for ((k, v) in headers) sb.append(k).append(": ").append(v).append("\r\n")
        // The WVC receiver on the TV is a web page: it needs CORS for playlists and segments.
        sb.append("Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Range\r\n")
        sb.append("Access-Control-Expose-Headers: Content-Length, Content-Range\r\nConnection: close\r\n\r\n")
        out.write(sb.toString().toByteArray(Charsets.ISO_8859_1))
    }

    private fun readHead(input: InputStream): String? {
        val buf = ByteArrayOutputStream()
        var m = 0
        while (buf.size() < 16 * 1024) {
            val c = input.read()
            if (c < 0) return null
            buf.write(c)
            m = when {
                (m == 0 || m == 2) && c == '\r'.code -> m + 1
                (m == 1 || m == 3) && c == '\n'.code -> m + 1
                c == '\r'.code -> 1
                else -> 0
            }
            if (m == 4) return buf.toString(Charsets.ISO_8859_1.name()).removeSuffix("\r\n\r\n")
        }
        return null
    }

    companion object {
        /** No request for this long means the TV stopped: free the port. */
        const val IDLE_MS = 15 * 60_000L
        private val URI_ATTR = Regex("URI=\"([^\"]*)\"")
        private val MOBILE = listOf("rmnet", "ccmni", "pdp", "tun", "ppp", "v4-", "dummy", "ims", "clat")

        /**
         * Rewrites every URI in an HLS playlist through [map] (absolute upstream
         * url, is-a-playlist). Variant lines and EXT-X-MEDIA / I-FRAME URIs are
         * playlists; segments, keys and EXT-X-MAP are not.
         */
        fun rewrite(text: String, baseUrl: String, map: (String, Boolean) -> String): String {
            val base = baseUrl.toHttpUrlOrNull()
            fun abs(ref: String): String? = base?.resolve(ref)?.toString()
            var nextIsPlaylist = false
            return text.split('\n').joinToString("\n") { raw ->
                val line = raw.trimEnd('\r')
                when {
                    line.isBlank() -> line
                    line.startsWith("#") -> {
                        if (line.startsWith("#EXT-X-STREAM-INF")) nextIsPlaylist = true
                        val pl = line.startsWith("#EXT-X-MEDIA") || line.startsWith("#EXT-X-I-FRAME-STREAM-INF")
                        URI_ATTR.replace(line) { m -> abs(m.groupValues[1])?.let { "URI=\"${map(it, pl)}\"" } ?: m.value }
                    }
                    else -> {
                        val pl = nextIsPlaylist
                        nextIsPlaylist = false
                        abs(line.trim())?.let { map(it, pl) } ?: line
                    }
                }
            }
        }

        /** Loopback, private ranges (RFC 1918), link-local and IPv6 ULA. Not CGNAT 100.64/10. */
        fun isLan(a: InetAddress): Boolean =
            a.isLoopbackAddress || a.isSiteLocalAddress || a.isLinkLocalAddress ||
                (a is Inet6Address && (a.address[0].toInt() and 0xfe) == 0xfc)

        /** The Wi-Fi (or hotspot / ethernet) IPv4 to bind to; never a mobile-data interface. */
        fun pickAddress(ifaces: List<Pair<String, List<InetAddress>>>): InetAddress? {
            val ok = ifaces.filter { (n, _) -> MOBILE.none { n.startsWith(it) } && n != "lo" }
                .sortedBy { (n, _) -> if (n.startsWith("wlan")) 0 else 1 }
            return ok.firstNotNullOfOrNull { (_, addrs) -> addrs.firstOrNull { it is Inet4Address && it.isSiteLocalAddress && !it.isLoopbackAddress } }
        }

        fun lanAddress(): InetAddress? = try {
            pickAddress(NetworkInterface.getNetworkInterfaces().toList().filter { it.isUp && !it.isLoopback }.map { it.name to it.inetAddresses.toList() })
        } catch (_: Exception) { null }

        /** A short id for the receiver: its user agent, else its address. */
        fun receiverId(ua: String?, from: InetAddress): String {
            val src = ua?.takeIf { it.isNotBlank() } ?: from.hostAddress.orEmpty()
            return java.security.MessageDigest.getInstance("SHA-256").digest(src.toByteArray()).take(6).joinToString("") { "%02x".format(it) }
        }

        private fun hex(s: String): String = s.toByteArray(Charsets.UTF_8).joinToString("") { "%02x".format(it) }

        private fun unhex(h: String): String? {
            if (h.isEmpty() || h.length % 2 != 0) return null
            return try {
                ByteArray(h.length / 2) { h.substring(it * 2, it * 2 + 2).toInt(16).toByte() }.toString(Charsets.UTF_8)
            } catch (_: NumberFormatException) { null }
        }
    }
}
