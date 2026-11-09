package com.dsharnessmobile.shell

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class EngineRecoveryGuardTest {
  @Test fun staleStartupFinallyCannotReleaseTheReplacementFlow() {
    val lease = EngineStartLease()
    val old = requireNotNull(lease.acquire())
    assertNull(lease.acquire())
    lease.invalidate() // Explicit restart releases the old flow.
    val replacement = requireNotNull(lease.acquire())
    lease.release(old) // Delayed finally from the original startup.
    assertNull("the replacement must still own the flow", lease.acquire())
    lease.release(replacement)
    assertNotNull(lease.acquire())
  }

  @Test fun responseOneSecondAfterDeadlineCancelsRecoveryDuringGrace() {
    var elapsed = 90_000L
    var probes = 0
    val confirmed = confirmEngineRecovery(7, { 7 }, { false }, {
      probes++
      // Reported failure: the server begins answering at t=91s.
      !EngineProbe.isHttpAlive(if (elapsed >= 91_000L) 401 else -1)
    }, { elapsed += it })
    assertFalse(confirmed)
    assertEquals(95_000L, elapsed)
    assertEquals(1, probes)
  }

  @Test fun secondProbeCanStillRescueTheEngine() {
    var elapsed = 0L
    var probes = 0
    assertFalse(confirmEngineRecovery(9, { 9 }, { false }, {
      probes++
      elapsed < 9_000L
    }, { elapsed += it }))
    assertEquals(2, probes)
    assertEquals(10_000L, elapsed)
  }

  @Test fun permanentlyUnresponsiveEngineRemainsRecoverableAfterBothChecks() {
    val waits = mutableListOf<Long>()
    var probes = 0
    assertTrue(confirmEngineRecovery(11, { 11 }, { false }, { probes++; true }, { waits += it }))
    assertEquals(listOf(5_000L, 5_000L), waits)
    assertEquals(2, probes)
  }

  @Test fun newGenerationDuringGraceCancelsOldRecoveryWithoutProbingNewEngine() {
    var generation = 10L
    var probes = 0
    assertFalse(confirmEngineRecovery(10, { generation }, { false }, { probes++; true }, { generation++ }))
    assertEquals(0, probes)
  }

  @Test fun generationChangeDuringNetworkRequestCannotAuthorizeKillingReplacement() {
    var generation = 30L
    assertFalse(confirmEngineRecovery(30, { generation }, { false }, { generation++; true }, {}))
  }

  @Test fun userShutdownCancelsPendingRecovery() {
    var stopped = false
    var probes = 0
    assertFalse(confirmEngineRecovery(4, { 4 }, { stopped }, { probes++; true }, { stopped = true }))
    assertEquals(0, probes)
  }

  @Test fun interruptedServiceCannotContinueIntoDestructiveAction() {
    try {
      assertFalse(confirmEngineRecovery(1, { 1 }, { false }, { fail("must not probe"); true }, {
        throw InterruptedException("service stopped")
      }))
      assertTrue(Thread.currentThread().isInterrupted)
    } finally {
      Thread.interrupted()
    }
  }

  @Test fun authFailureIsLiveButNeverAuthenticated() {
    for (code in listOf(401, 403)) {
      assertTrue(EngineProbe.isHttpAlive(code))
      assertNotEquals(EngineProbe.EngineAuthState.OK, EngineProbe.classifyAuthState(code))
      assertFalse(confirmEngineRecovery(1, { 1 }, { false }, { !EngineProbe.isHttpAlive(code) }, {}))
    }
    assertFalse(EngineProbe.isHttpAlive(500))
    assertFalse(EngineProbe.isHttpAlive(-1))
  }

  @Test fun failureDetailIncludesSafeUrlStatusAndGenerationWithoutCredentials() {
    val probe = JSONObject().put("url", "http://user:secret@localhost/?token=secret")
      .put("code", 401).put("running", true).put("listening", true)
      .put("latencyMs", 15).put("error", "cookie=secret")
    val line = engineProbeDetail(probe, 42)
    assertTrue(line.contains("generation=42"))
    assertTrue(line.contains("url=http://127.0.0.1:3080"))
    assertTrue(line.contains("code=401"))
    assertTrue(line.contains("httpAlive=true"))
    assertFalse(line.contains("secret"))
    assertFalse(line.contains("cookie"))
  }
}
