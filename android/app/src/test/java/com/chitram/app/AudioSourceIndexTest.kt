package com.chitram.app

import com.chitram.app.data.*
import com.chitram.app.player.AudioChoice
import com.chitram.app.player.PlayPolicy
import org.junit.Assert.*
import org.junit.Test

class AudioSourceIndexTest {
    private fun source(id: String, languages: List<String>, selectable: Boolean = false) = Ranking.toSource(RawStream(url="https://fixture/$id.m3u8",provider=id,languages=languages,selectableAudio=selectable),0,CodecSupport { _,_ -> true })!!
    @Test fun retainsAllCandidatesAndFailsToNextTeluguRatherThanOldHindi() {
        val a=source("a", listOf("Telugu", "Hindi"), true)
        val b=source("b", listOf("te"))
        val hi=source("hi",listOf("Hindi"))
        val all=listOf(hi,a,b)
        assertEquals(listOf(a,b),AudioChoice.index(all)["Telugu"])
        val tried=hashSetOf(a.id)
        assertEquals(b,PlayPolicy.nextAlive(AudioChoice.candidates(all,"Telugu",tried),tried,"Telugu",null))
        tried+=b.id
        assertTrue(AudioChoice.candidates(all,"Telugu",tried).isEmpty())
        val late=source("late",listOf("Telugu"))
        assertEquals(listOf(late),AudioChoice.candidates(all+late,"Telugu",tried))
        assertEquals(listOf(a,b),AudioChoice.candidates(all,"Telugu"))
        assertTrue(AudioChoice.index(listOf(hi)).containsKey("Hindi"))
        assertFalse(AudioChoice.index(listOf(hi)).containsKey("Telugu"))
    }
    @Test fun staleLanguageCandidateAdvancesWithinLanguageInsteadOfGlobalRefresh() {
        val a=source("A",listOf("Telugu")); val b=source("B",listOf("Telugu")); val hi=source("H",listOf("Hindi"))
        assertEquals(com.chitram.app.player.FailPolicy.Action.FAILOVER, com.chitram.app.player.FailPolicy.onError(a,403,false,languageSelection=true))
        assertEquals(listOf(b),AudioChoice.candidates(listOf(hi,a,b),"Telugu",setOf(a.id)))
        assertFalse(AudioChoice.knownLanguage("Audio 1"))
        assertFalse(AudioChoice.knownLanguage("Track 2"))
    }
    @Test fun unchangedNetmirrorTargetAdvancesButRenewedUrlRemainsEligible() {
        val old=source("NetMirror",listOf("Telugu"))
        assertTrue(com.chitram.app.player.FailPolicy.unchangedNetmirrorRetry(old,old.copy()))
        assertFalse(com.chitram.app.player.FailPolicy.unchangedNetmirrorRetry(old,old.copy(url="https://fixture/renewed.m3u8")))
        val alternative=source("Other",listOf("Telugu"))
        assertEquals(alternative,PlayPolicy.nextAlive(AudioChoice.candidates(listOf(old,alternative),"Telugu",setOf(old.id)),setOf(old.id),"Telugu",null))
    }
    @Test fun catalogOnlyAudioCannotCreatePlayableEntryAndCatalogIdentitySurvivesAdapter() {
        val raw=RawStream(url="https://fixture/nm.m3u8",provider="NetMirror",languages=emptyList(),catalogLanguages=listOf("Telugu"),audio=emptyList(),selectableAudio=true,netmirrorCatalog="Prime Video")
        val row=Ranking.toSource(raw,0,CodecSupport { _,_ -> true })!!
        assertEquals("Prime Video",row.netmirrorCatalog)
        assertTrue(AudioChoice.index(listOf(row)).isEmpty())
    }
}
