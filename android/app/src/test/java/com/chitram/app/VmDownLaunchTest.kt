package com.chitram.app

import com.chitram.app.data.MemoryKeyValue
import com.chitram.app.player.PlayerVm
import com.chitram.app.resolve.HostBook
import com.chitram.app.resolve.MappleResolver
import com.chitram.app.resolve.MultiMoviesResolver
import com.chitram.app.resolve.OnDeviceResolver
import com.chitram.app.resolve.OneTouchTvResolver
import com.chitram.app.resolve.ResolveConfigStore
import com.chitram.app.resolve.ShowsstResolver
import com.chitram.app.resolve.VaplayerResolver
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The VM fails after the start began (vmUp was true): every VM-down-only
 * on-device provider joins, once each, and none waits before the first row.
 */
class VmDownLaunchTest {
    private val client = OkHttpClient()
    private val kv = MemoryKeyValue()
    private val od = OnDeviceResolver(null, ResolveConfigStore(client, "http://127.0.0.1:9/config", kv), MappleResolver(client, HostBook(kv), kv),
        VaplayerResolver(client, HostBook(kv)) { null }, titleFor = { _, _ -> null }, imdbFor = { _, _ -> null },
        multimovies = MultiMoviesResolver(client, origin = "http://127.0.0.1:9"), showsst = ShowsstResolver(client), onetouch = OneTouchTvResolver(client))

    private fun extras(running: List<String>) = PlayerVm.vmDownExtras(od.names(vmDown = true), od.names(vmDown = false), running)

    @Test fun vmFailMidStartAddsEveryVmDownOnlyProvider() {
        // Start with VM up: the running jobs are the vmDown=false names.
        val running = od.names(vmDown = false)
        assertEquals(listOf(OnDeviceResolver.MULTIMOVIES, OnDeviceResolver.SHOWSST, OnDeviceResolver.ONETOUCH), extras(running))
    }

    @Test fun noDuplicateRowsWhenAlreadyRunningOrCalledTwice() {
        // VM down at start: all were launched already.
        assertEquals(emptyList<String>(), extras(od.names(vmDown = true)))
        // Mid-start fail then a late VM failure (joinVm): the second call adds nothing.
        val first = od.names(vmDown = false) + extras(od.names(vmDown = false))
        assertEquals(emptyList<String>(), extras(first))
        // Only the missing ones join.
        assertEquals(listOf(OnDeviceResolver.SHOWSST, OnDeviceResolver.ONETOUCH), extras(od.names(vmDown = false) + OnDeviceResolver.MULTIMOVIES))
    }

    @Test fun absentResolversAreNotLaunched() {
        val bare = OnDeviceResolver(null, ResolveConfigStore(client, "http://127.0.0.1:9/config", kv), MappleResolver(client, HostBook(kv), kv),
            VaplayerResolver(client, HostBook(kv)) { null }, titleFor = { _, _ -> null }, imdbFor = { _, _ -> null })
        assertEquals(emptyList<String>(), PlayerVm.vmDownExtras(bare.names(vmDown = true), bare.names(vmDown = false), bare.names(vmDown = false)))
    }

    @Test fun bothFailurePathsUseTheLoopAndItNeverWaits() {
        val vm = listOf(File("src/main/java/com/chitram/app/player/PlayerVm.kt"), File("app/src/main/java/com/chitram/app/player/PlayerVm.kt")).first { it.exists() }.readText()
        assertFalse("old single-provider launcher must be gone", vm.contains("launchMultiMovies"))
        assertEquals("start path + late VM failure path", 2, Regex("""\blaunchVmDownOnly\(r, """).findAll(vm).count())
        val body = vm.substringAfter("private fun launchVmDownOnly(").substringBefore("\n    }\n")
        assertTrue(body.contains("vmDownExtras("))
        assertFalse("must not delay the first row", body.contains(".await()") || body.contains("runBlocking") || body.contains("join()"))
    }
}
