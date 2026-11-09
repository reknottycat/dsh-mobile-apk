package com.dsharnessmobile.shell

import java.net.ServerSocket
import java.net.URL
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import org.junit.Assert.*
import org.junit.Test

/** Exercise the actual HttpURLConnection transport, not only status-code classifiers. */
class EngineProbeHttpTest {
  private fun withResponse(status: Int, extra: String = "", check: (URL) -> Unit) {
    ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1")).use { server ->
      server.soTimeout = 5_000
      val error = AtomicReference<Throwable?>()
      val worker = thread(isDaemon = true) {
        try {
          server.accept().use { client ->
            client.soTimeout = 2_000
            val reader = client.getInputStream().bufferedReader()
            while (!reader.readLine().isNullOrEmpty()) { /* consume request headers */ }
            client.getOutputStream().write(("HTTP/1.1 $status Response\r\n" + extra +
              "Content-Length: 0\r\nConnection: close\r\n\r\n").toByteArray())
            client.getOutputStream().flush()
          }
        } catch (failure: Throwable) { error.set(failure) }
      }
      check(URL("http://127.0.0.1:${server.localPort}/"))
      worker.join(5_000)
      assertFalse("fixture server must finish", worker.isAlive)
      error.get()?.let { throw AssertionError("fixture server failed", it) }
    }
  }

  @Test fun unauthorizedResponseIsObservedAsLiveAndAuthRequired() = withResponse(401) { url ->
    val result = EngineProbe.checkUrl(url, 1_000)
    assertTrue(result.optBoolean("running"))
    assertTrue(result.optBoolean("listening"))
    assertEquals(401, result.optInt("code"))
    assertEquals("required", result.optString("auth"))
  }

  @Test fun forbiddenResponseIsObservedAsLiveButDenied() = withResponse(403) { url ->
    val result = EngineProbe.checkUrl(url, 1_000)
    assertTrue(result.optBoolean("running"))
    assertEquals(403, result.optInt("code"))
    assertEquals("denied", result.optString("auth"))
  }

  @Test fun redirectDoesNotFollowAwayFromReadinessEndpoint() =
    withResponse(303, "Location: http://127.0.0.1:1/not-the-engine?token=secret\r\n") { url ->
      val result = EngineProbe.checkUrl(url, 1_000)
      assertEquals(303, result.optInt("code"))
      assertTrue(result.optBoolean("running"))
      assertFalse(result.toString().contains("secret"))
    }

  @Test fun serverErrorIsListeningButNotHealthy() = withResponse(503) { url ->
    val result = EngineProbe.checkUrl(url, 1_000)
    assertTrue(result.optBoolean("listening"))
    assertFalse(result.optBoolean("running"))
    assertEquals(503, result.optInt("code"))
  }
}
