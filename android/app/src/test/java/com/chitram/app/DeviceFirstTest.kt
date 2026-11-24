package com.chitram.app

import com.chitram.app.data.MemoryKeyValue
import com.chitram.app.data.Source
import com.chitram.app.data.VmHealth
import com.chitram.app.player.StartRace
import com.chitram.app.resolve.HostBook
import com.chitram.app.resolve.InsertunitResolver
import com.chitram.app.resolve.MappleResolver
import com.chitram.app.resolve.MultiMoviesResolver
import com.chitram.app.resolve.OnDeviceResolver
import com.chitram.app.resolve.OneTouchTvResolver
import com.chitram.app.resolve.ResolveConfigStore
import com.chitram.app.resolve.ShowsstResolver
import com.chitram.app.resolve.VaplayerResolver
import com.chitram.app.resolve.VidoutResolver
import com.chitram.app.resolve.VidriftResolver
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Device-first (owner 2026-11-24): every provider the phone can resolve starts on
 * every play, VM up or down; play never waits on the VM for a device row; the VM
 * is asked only for what the phone cannot do; its late rows never duplicate.
 */
class DeviceFirstTest {
    private val client = OkHttpClient()
    private val kv = MemoryKeyValue()
    private val od = OnDeviceResolver(null, ResolveConfigStore(client, "http://127.0.0.1:9/config", kv), MappleResolver(client, HostBook(kv), kv),
        VaplayerResolver(client, HostBook(kv)) { null }, titleFor = { _, _ -> null }, imdbFor = { _, _ -> null },
        multimovies = MultiMoviesResolver(client, origin = "http://127.0.0.1:9"), showsst = ShowsstResolver(client), onetouch = OneTouchTvResolver(client),
        vidrift = VidriftResolver(client), insertunit = InsertunitResolver(client), vidout = VidoutResolver(client))

    private fun row(id: String, provider: String, lang: String, device: Boolean = true, url: String = "https://x/$id.m3u8") =
        Source(id, provider, provider, url, false, "1080p", emptyList(), listOf(lang), false, false, emptyList(), null, null, false,
            onDevice = if (device) provider else null, audioLanguages = listOf(lang))

    private fun vmSource() = listOf(File("src/main/java/com/chitram/app/player/PlayerVm.kt"), File("app/src/main/java/com/chitram/app/player/PlayerVm.kt")).first { it.exists() }.readText()

    @Test fun everyDeviceProviderStartsWithNoVmGate() {
        assertEquals(listOf(OnDeviceResolver.MAPPLE, OnDeviceResolver.VAPLAYER, OnDeviceResolver.MULTIMOVIES, OnDeviceResolver.SHOWSST, OnDeviceResolver.ONETOUCH,
            OnDeviceResolver.VIDRIFT, OnDeviceResolver.INSERTUNIT, OnDeviceResolver.VIDOUT), od.names())
        val src = vmSource()
        assertFalse("no VM-down-only launcher left", src.contains("launchVmDownOnly") || src.contains("vmDownExtras"))
        assertTrue(src.contains("g.onDevice.names()"))
    }

    /** (a) VM down (no VM call): the device Telugu row is the first list at once. */
    @Test fun vmDownDeviceRowsPlayWithNoVmWait() = runBlocking {
        val castle = async { delay(50); listOf(row("c", "CastleTV", "Telugu")) }
        val t0 = System.currentTimeMillis()
        val first = StartRace().firstMany(null, listOf(castle), "Telugu")
        val ms = System.currentTimeMillis() - t0
        assertTrue("took $ms ms", ms < 1_000)
        assertEquals(listOf("c"), first.device.map { it.id })
        assertTrue(first.backend.isEmpty())
        assertEquals(listOf("[route] castletv device-first", "[route] vm unreachable, device only"), StartRace.routeLines(listOf("castletv"), vmAsked = false))
    }

    /** (a) VM unreachable (call hangs until its timeout): a device Telugu row still starts without waiting on it. */
    @Test fun vmHangingNeverHoldsADeviceRow() = runBlocking {
        val vm = CompletableDeferred<List<Source>>() // never answers
        val dev = async { delay(100); listOf(row("i", "Insertunit", "Telugu")) }
        val t0 = System.currentTimeMillis()
        val first = StartRace().firstMany(vm, listOf(dev), "Telugu")
        val ms = System.currentTimeMillis() - t0
        assertTrue("took $ms ms, lead is ${StartRace.VM_LEAD_MS}", ms < 1_000)
        assertTrue(first.backendPending)
        assertEquals(listOf("i"), first.device.map { it.id })
    }

    /** (b) VM answers in 10 s: the device Telugu row is picked first; the VM rows join late. */
    @Test fun vmSlowDeviceTeluguPickedBeforeVmAnswers() = runBlocking {
        val vm = async { delay(10_000); listOf(row("v", "vixsrc", "Telugu", device = false)) }
        val hindi = async { delay(50); listOf(row("h", "mapple", "Hindi")) }
        val tel = async { delay(300); listOf(row("t", "CastleTV", "Telugu")) }
        val t0 = System.currentTimeMillis()
        val first = StartRace().firstMany(vm, listOf(hindi, tel), "Telugu")
        val ms = System.currentTimeMillis() - t0
        assertTrue("took $ms ms", ms < 1_500)
        assertFalse("VM still out", vm.isCompleted)
        assertTrue(first.backendPending)
        assertTrue(first.device.any { it.id == "t" })
        assertEquals("t", com.chitram.app.data.Ranking.rank(first.device, "Telugu").first().id)
        vm.cancel()
    }

    /** (c) VM-required providers are still asked of the VM: VM up sends the call, and its rows are kept. */
    @Test fun vmRequiredProviderStillAskedOfVm() = runBlocking {
        assertEquals("[route] vm-required: VM asked for providers the phone cannot resolve", StartRace.routeLines(emptyList(), vmAsked = true).single())
        // Device has nothing good: the race takes the VM's answer.
        val vm = async { delay(200); listOf(row("v", "vixsrc", "Telugu", device = false)) }
        val dev = async { delay(50); listOf(row("h", "mapple", "Hindi")) }
        val first = StartRace().firstMany(vm, listOf(dev), "Telugu")
        assertFalse(first.backendPending)
        assertEquals(listOf("v"), first.backend.map { it.id })
        // A late VM row of a provider the phone cannot resolve always joins.
        val (kept, dropped) = StartRace.dropVmDupes(listOf(row("t", "CastleTV", "Telugu")), listOf(row("v", "vixsrc", "Telugu", device = false)))
        assertEquals(listOf("v"), kept.map { it.id })
        assertTrue(dropped.isEmpty())
        assertEquals(listOf("[route] vixsrc vm-required rows=1"), StartRace.vmRequiredLines(kept + row("c2", "CastleTV", "Telugu", device = false)))
        // The start path still sends the VM call when its breaker is closed.
        val src = vmSource()
        assertTrue(src.contains("val vm = if (vmDown) null else viewModelScope.async {"))
    }

    /** (d) Both sides return the same source: one row. A VM row adding a language stays (no info lost). */
    @Test fun noDuplicateRowsWhenBothReturnTheSameSource() {
        val shown = listOf(row("dc", "CastleTV", "Telugu"), row("dn", "NetMirror", "Telugu", url = "https://n/a.m3u8"))
        val vm = listOf(
            row("vc", "CastleTV", "Telugu", device = false),
            row("vn", "NetMirror", "Telugu", device = false, url = "https://n/a.m3u8"),
            row("vn2", "NetMirror", "Hindi", device = false, url = "https://n/b.m3u8"),
            row("vc2", "CastleTV", "Tamil", device = false),
            row("vx", "vixsrc", "English", device = false),
        )
        val (kept, dropped) = StartRace.dropVmDupes(shown, vm)
        assertEquals(listOf("vc", "vn"), dropped.map { it.id })
        assertEquals(listOf("vn2", "vc2", "vx"), kept.map { it.id })
        val merged = com.chitram.app.data.Ranking.merge(shown, kept, "Telugu")
        assertEquals(1, merged.count { it.provider == "CastleTV" && it.languages == listOf("Telugu") })
        // joinVm uses it.
        assertTrue(vmSource().substringAfter("private suspend fun joinVm(").substringBefore("\n    }\n").contains("StartRace.dropVmDupes("))
    }

    @Test fun launchExtraForcesVmDownLikeTwoFailuresAndClearsOnSuccess() {
        var t = 1_000_000L
        val store = MemoryKeyValue()
        val h = VmHealth(store) { t }
        assertTrue(h.allow())
        h.forceDown()
        assertFalse(h.allow())
        assertEquals((t + VmHealth.MAX_MS).toString(), store.get(VmHealth.UNTIL_KEY))
        assertEquals(VmHealth.FAILS.toString(), store.get(VmHealth.FAILS_KEY))
        // Same state after a restart (kept keys).
        assertFalse(VmHealth(store) { t }.allow())
        // Clears itself after 10 min: the next call is a probe.
        t += VmHealth.MAX_MS
        assertTrue(h.allow())
        assertTrue(h.halfOpen)
        h.onSuccess()
        assertFalse(h.halfOpen)
        // Or on the next VM success before then.
        h.forceDown(); h.onSuccess()
        assertTrue(h.allow())
        val act = listOf(File("src/main/java/com/chitram/app/MainActivity.kt"), File("app/src/main/java/com/chitram/app/MainActivity.kt")).first { it.exists() }.readText()
        assertTrue(act.contains("const val EXTRA_VM_DOWN = \"vmDown\""))
        assertTrue(act.contains("getBooleanExtra(EXTRA_VM_DOWN, false)") && act.contains("api.forceVmDown()"))
        assertTrue(act.contains("override fun onNewIntent("))
    }
}
