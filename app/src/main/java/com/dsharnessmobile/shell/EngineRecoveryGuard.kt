package com.dsharnessmobile.shell

/** Two fresh observations across a bounded grace period before destructive recovery.
 * The caller owns the generation and must check it again while holding the process
 * lifecycle lock immediately before a stop or rollback. No log text is a liveness input. */
internal fun confirmEngineRecovery(
  expectedGeneration: Long,
  currentGeneration: () -> Long,
  cancelled: () -> Boolean,
  stillUnhealthy: () -> Boolean,
  wait: (Long) -> Unit = { Thread.sleep(it) },
): Boolean {
  fun current() = !cancelled() && currentGeneration() == expectedGeneration
  repeat(ENGINE_RECOVERY_CONFIRMATIONS) {
    if (!current()) return false
    try {
      wait(ENGINE_RECOVERY_PROBE_INTERVAL_MS)
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
      return false
    }
    if (!current() || !stillUnhealthy() || !current()) return false
  }
  return current()
}

internal const val ENGINE_RECOVERY_CONFIRMATIONS = 2
internal const val ENGINE_RECOVERY_PROBE_INTERVAL_MS = 5_000L
internal const val ENGINE_RECOVERY_GRACE_MS = ENGINE_RECOVERY_CONFIRMATIONS * ENGINE_RECOVERY_PROBE_INTERVAL_MS

/** An old startup worker may finish after a replacement has acquired the flow. */
internal class EngineStartLease {
  private val owner = java.util.concurrent.atomic.AtomicReference<Any?>(null)

  fun acquire(): Any? {
    val token = Any()
    return if (owner.compareAndSet(null, token)) token else null
  }

  fun release(token: Any) { owner.compareAndSet(token, null) }
  fun invalidate() { owner.set(null) }
}
