package com.chitram.app.resolve

import kotlinx.coroutines.ensureActive

/** One immutable extraction configuration; a repair cancels obsolete metadata requests only. */
internal class ResolveLeaseContext(val store: ResolveConfigStore, val value: ResolveConfigStore.Lease) : kotlin.coroutines.AbstractCoroutineContextElement(ResolveLeaseContext) {
    companion object Key : kotlin.coroutines.CoroutineContext.Key<ResolveLeaseContext>
}
internal class ObsoleteConfiguration : kotlinx.coroutines.CancellationException("Extractor configuration changed")
internal suspend fun ensureCurrentConfiguration() {
    kotlinx.coroutines.currentCoroutineContext().ensureActive()
    val lease=kotlin.coroutines.coroutineContext[ResolveLeaseContext] ?: return
    if (!lease.store.isCurrent(lease.value)) throw ObsoleteConfiguration()
}
