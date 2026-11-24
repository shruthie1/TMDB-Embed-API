package com.chitram.app.resolve

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** One failed step of a provider chain. `code` is the HTTP status, 0 for a network error. */
open class StepException(val step: String, val code: Int, detail: String) : IOException("$step: $detail")

/**
 * A provider held itself back (its own cooldown or request budget), or the upstream
 * said the title has nothing yet (vidrift orionStreams null): the provider did not
 * fail. Never counted by the circuit breaker.
 */
interface SelfImposedSkip

/** NetMirror's own pause or budget, thrown before any request. */
class NetmirrorSkip(detail: String) : StepException("netmirror", 0, detail), SelfImposedSkip

/** The device's IP may differ from the one that got the token (CGNAT, Wi-Fi to mobile). */
class SegmentForbidden(detail: String) : IOException(detail)

internal class Reply(val code: Int, val body: String, val headers: Headers, val bytes: ByteArray? = null) {
    val ok get() = code in 200..299
    fun location(): String? = headers["Location"]
}

/** Cancellable call; the body is read on IO. A cancelled coroutine cancels the call. */
internal suspend fun OkHttpClient.fetch(req: Request, asBytes: Boolean = false): Reply = withContext(Dispatchers.IO) {
    ensureCurrentConfiguration()
    val lease=kotlin.coroutines.coroutineContext[ResolveLeaseContext]
    val call=newCall(req)
    val unsubscribe=lease?.store?.onChange { _,_ -> if (!lease.store.isCurrent(lease.value)) call.cancel() }
    try {
        ensureCurrentConfiguration()
        val reply: Reply = suspendCancellableCoroutine { cont ->
            cont.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) { if (cont.isActive) cont.resumeWithException(e) }
                override fun onResponse(call: Call, response: Response) {
                    if (!cont.isActive) { response.close(); return }
                    try {
                        val value=response.use {
                            if (asBytes) Reply(it.code,"",it.headers,it.body?.bytes() ?: ByteArray(0))
                            else Reply(it.code,it.body?.string().orEmpty(),it.headers)
                        }
                        cont.resume(value)
                    } catch (error: Exception) { if (cont.isActive) cont.resumeWithException(error) }
                }
            })
        }
        ensureCurrentConfiguration()
        reply
    } catch (error: Exception) {
        ensureCurrentConfiguration()
        throw error
    } finally { unsubscribe?.invoke() }
}

/** Cookies for one provider session (mapple's /watch sets them, later steps need them). */
internal class Jar {
    private val m = LinkedHashMap<String, String>()
    fun absorb(h: Headers) = synchronized(m) {
        for (c in h.values("Set-Cookie")) {
            val kv = c.substringBefore(';')
            val i = kv.indexOf('=')
            if (i > 0) m[kv.substring(0, i).trim()] = kv.substring(i + 1).trim()
        }
    }
    fun header(): String? = synchronized(m) { if (m.isEmpty()) null else m.entries.joinToString("; ") { "${it.key}=${it.value}" } }
    fun names(): Set<String> = synchronized(m) { m.keys.toSet() }
}

internal fun originOf(url: String): String? = url.toHttpUrlOrNull()?.let { u ->
    val default = (u.scheme == "https" && u.port == 443) || (u.scheme == "http" && u.port == 80)
    if (default) "${u.scheme}://${u.host}" else "${u.scheme}://${u.host}:${u.port}"
}

/** Absolute url for a Location header, relative or not. */
internal fun resolveAgainst(base: String, ref: String): String? = base.toHttpUrlOrNull()?.resolve(ref)?.toString()
