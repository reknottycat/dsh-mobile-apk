package com.dsharnessmobile.shell

import android.content.ContextWrapper
import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Real patch/manifests, with only the external CLI replaced to control its blocking window. */
class UndoGateCancellationTest {
  private class Fixture(val root: File, includeFailedPlugin: Boolean = true) {
    val context = object : ContextWrapper(null) {
      override fun getFilesDir(): File = root
    }
    val engine = EngineManager(context)
    val id = "20261109-120000-abcd"
    val patch = PluginMounts.patchFile(engine)
    val commands = mutableListOf<List<String>>()

    init {
      File(root, "undo-emergency.mjs").writeText("// CLI substituted by the test")
      File(root, ".undo-auto-armed").writeText("pending")
      File(root, ".snapshot-fingerprint").writeText("current-install")
      File(root, ".undo-known-good").writeText(id + "\ncurrent-install\n")
      File(engine.homeDir, ".dsh/undo-snapshots/auto/" + id).mkdirs()
      patch.parentFile!!.mkdirs()
      patch.writeText("- insert:\n    - id: keep\n      name: user-kept-plugin\n" +
        if (includeFailedPlugin) "    - id: broken\n      name: user-broken-plugin\n" else "")
      File(root, "engine.log").writeText("failed to import loader entry broken (user-broken-plugin)\n")
      PluginMounts.noteHealthy(context, patch)
    }

    fun execute(canRecover: () -> Boolean, duringList: () -> Unit = {}): UndoGate.UndoResult =
      UndoGate.execute(context, engine, canRecover, cliRunner = { arguments ->
        commands += arguments
        when (arguments.first()) {
          "list" -> {
            duringList()
            listOf("[auto] " + id)
          }
          "restore" -> {
            assertEquals(listOf("restore", id), arguments)
            patch.writeText("- id: restored-known-good\n")
            listOf("恢复快照 " + id, "完成：还原")
          }
          else -> throw AssertionError("Unexpected CLI operation: " + arguments)
        }
      })

    fun assertCancelled(result: UndoGate.UndoResult, before: String) {
      assertFalse(result.executed)
      assertTrue(result.summary.contains("取消"))
      assertEquals(before, patch.readText())
      assertEquals(listOf(listOf("list")), commands)
      assertFalse(File(root, ".undo-auto-done").exists())
      assertFalse(File(root, ".undo-auto-armed").exists())
    }
  }

  private fun withFixture(includeFailedPlugin: Boolean = true, block: (Fixture) -> Unit) {
    val root = Files.createTempDirectory("undo-cancellation-").toFile()
    try { block(Fixture(root, includeFailedPlugin)) } finally { SnapshotFs.deletePath(root) }
  }

  @Test fun engineAnsweringWhileListRunsLeavesTheFailedPluginMounted() = withFixture { fixture ->
    val before = fixture.patch.readText()
    var httpCode = -1
    val result = fixture.execute({ !EngineProbe.isHttpAlive(httpCode) }, duringList = { httpCode = 401 })
    fixture.assertCancelled(result, before)
  }

  @Test fun generationChangeDuringListCannotRestoreTheNewGeneration() = withFixture(false) { fixture ->
    val before = fixture.patch.readText()
    var generation = 7L
    val result = fixture.execute({ generation == 7L }, duringList = { generation++ })
    fixture.assertCancelled(result, before)
  }

  @Test fun userShutdownDuringListDoesNotRemoveAnyPlugin() = withFixture { fixture ->
    val before = fixture.patch.readText()
    var shutdown = false
    val result = fixture.execute({ !shutdown }, duringList = { shutdown = true })
    fixture.assertCancelled(result, before)
  }

  @Test fun recoveryAfterListIsCheckedAgainBeforePullWritesThePatch() = withFixture { fixture ->
    val before = fixture.patch.readText()
    var probes = 0
    // The entry and post-list probes fail; the next observation sees the engine recover.
    val result = fixture.execute({ ++probes < 3 })
    fixture.assertCancelled(result, before)
    assertTrue(File(fixture.root, "undo-gate.log").readText().contains("stage=before-pull"))
  }

  @Test fun unsuccessfulPullCannotBypassAFreshCheckBeforeRestore() = withFixture(false) { fixture ->
    val before = fixture.patch.readText()
    var probes = 0
    // A historical failure names an absent plugin: pull cannot remove it. Recovery
    // before the fallback restore must still cancel the whole-document replacement.
    val result = fixture.execute({ ++probes < 4 })
    fixture.assertCancelled(result, before)
    assertTrue(File(fixture.root, "undo-gate.log").readText().contains("stage=before-restore"))
  }

  @Test fun persistentFailureStillRemovesOnlyTheAttributedPlugin() = withFixture { fixture ->
    val result = fixture.execute({ true })
    assertTrue(result.executed)
    assertEquals("user-broken-plugin", result.snapshotId)
    assertTrue(fixture.patch.readText().contains("user-kept-plugin"))
    assertFalse(fixture.patch.readText().contains("user-broken-plugin"))
    assertEquals(listOf(listOf("list")), fixture.commands)
  }

  @Test fun persistentFailureStillRestoresTheCurrentInstallKnownGoodSnapshot() = withFixture(false) { fixture ->
    val result = fixture.execute({ true })
    assertTrue(result.executed)
    assertEquals(fixture.id, result.snapshotId)
    assertEquals("- id: restored-known-good\n", fixture.patch.readText())
    assertEquals(listOf(listOf("list"), listOf("restore", fixture.id)), fixture.commands)
    assertTrue(File(fixture.root, ".undo-auto-done").isFile)
  }
}
