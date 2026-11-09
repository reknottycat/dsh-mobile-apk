package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.Files
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HarnessConfigurationMigrationTest {
  private fun withTree(block: (File) -> Unit) {
    val root = Files.createTempDirectory("harness-config-migration-").toFile()
    try { block(root) } finally { SnapshotFs.deletePath(root) }
  }

  private fun file(root: File, path: String, content: String): File =
    File(root, path).apply { parentFile!!.mkdirs(); writeText(content) }

  @Test fun migratedInstallDoesNotReseedSettingsOrCopyFactoryImportMarkers() = withTree { root ->
    val live = File(root, "live")
    val stage = File(root, "stage")
    val historical = file(live, "settings.yaml.imported", "historical user settings\n")
    val patch = file(live, "profiles/web/cordis.patch.yml", "- id: user-plugin\n")
    file(stage, "settings.yaml", "factory: true\n")
    file(stage, "settings.yaml.imported", "factory marker\n")
    val stagedPatch = file(stage, "profiles/web/cordis.patch.yml", "- id: factory-plugin\n")
    file(stage, "profiles/web/settings.yaml.imported", "factory profile marker\n")

    assertTrue(SnapshotUserData.prepareStagedSnapshot(stage, live).isNotEmpty())
    assertFalse(File(stage, "settings.yaml").exists())
    assertFalse(File(stage, "settings.yaml.imported").exists())
    assertFalse(File(stage, "profiles/web/settings.yaml.imported").exists())
    assertEquals("- id: factory-plugin\n", stagedPatch.readText())
    assertEquals("- id: user-plugin\n", patch.readText())
    assertEquals("historical user settings\n", historical.readText())
    assertTrue(SnapshotUserData.prepareStagedSnapshot(stage, live).isEmpty())
    assertTrue("The transaction must preserve the user's importer marker", "settings.yaml.imported" in SnapshotUserData.preservedNames)
  }

  @Test fun missingLegacyWithExistingCustomProfileDoesNotReseedRootSettings() = withTree { root ->
    val live = File(root, "live")
    val stage = File(root, "stage")
    file(live, "profiles/custom/cordis.patch.yml", "- id: my-config\n")
    file(stage, "settings.yaml", "factory: true\n")
    SnapshotUserData.prepareStagedSnapshot(stage, live)
    assertFalse(File(stage, "settings.yaml").exists())
  }

  @Test fun freshAndUnmigratedInstallKeepTheLegacyFactorySeed() = withTree { root ->
    val live = File(root, "live")
    val stage = File(root, "stage")
    val seed = file(stage, "settings.yaml", "factory: true\n")
    SnapshotUserData.prepareStagedSnapshot(stage, live)
    assertTrue(seed.exists())
    file(live, "settings.yaml", "user: true\n")
    file(live, "profiles/web/cordis.patch.yml", "- id: old-factory-patch\n")
    SnapshotUserData.prepareStagedSnapshot(stage, live)
    assertTrue(seed.exists())
    assertEquals(File(live, "settings.yaml"), SnapshotUserData.configurationDocument(live))
  }

  @Test fun profileSettingsAndUserDataSurviveWhileFactoryRuntimePatchStillMerges() = withTree { root ->
    val live = File(root, "live")
    val stage = File(root, "stage")
    file(live, "profiles/web/settings.yaml.imported", "user marker")
    file(live, "profiles/web/sessions/user.jsonl", "user session")
    file(live, "profiles/web/.credentials.yaml", "user credential")
    file(stage, "profiles/web/settings.yaml", "obsolete factory settings")
    file(stage, "profiles/web/sessions/factory.jsonl", "factory session")
    file(stage, "profiles/web/.credentials.yaml", "factory credential")
    val patch = file(stage, "profiles/web/cordis.patch.yml", "- id: factory-runtime\n")
    SnapshotUserData.prepareStagedSnapshot(stage, live)
    assertFalse(File(stage, "profiles/web/settings.yaml").exists())
    assertFalse(File(stage, "profiles/web/sessions").exists())
    assertFalse(File(stage, "profiles/web/.credentials.yaml").exists())
    assertEquals("- id: factory-runtime\n", patch.readText())
    assertEquals("user session", File(live, "profiles/web/sessions/user.jsonl").readText())
    assertEquals("user credential", File(live, "profiles/web/.credentials.yaml").readText())
  }

  @Test fun stagingNeverTraversesProfileSymlinks() = withTree { root ->
    val live = File(root, "live")
    val stage = File(root, "stage")
    val outside = File(root, "outside")
    val sentinel = file(outside, "settings.yaml.imported", "untouched")
    File(stage, "profiles").mkdirs()
    Files.createSymbolicLink(File(stage, "profiles/web").toPath(), outside.toPath())
    SnapshotUserData.prepareStagedSnapshot(stage, live)
    assertEquals("untouched", sentinel.readText())
  }

  @Test fun activeDocumentHonorsBothMigrationMarkersAndDoesNotUseHistoricalYaml() = withTree { root ->
    val legacy = file(root, "settings.yaml", "legacy: true\n")
    val patch = file(root, "profiles/web/cordis.patch.yml", "- id: profile-value\n")
    assertEquals(legacy, SnapshotUserData.configurationDocument(root))
    file(root, "profiles/web/settings.yaml.imported", "already imported")
    assertEquals(patch, SnapshotUserData.configurationDocument(root))
    File(root, "profiles/web/settings.yaml.imported").delete()
    file(root, "settings.yaml.imported", "already imported")
    assertEquals(patch, SnapshotUserData.configurationDocument(root))
    patch.delete()
    assertEquals("A missing current patch must not silently export stale history", patch,
      SnapshotUserData.configurationDocument(root))
  }

  @Test fun legacyExportImportAndPrivateBackupRetainTheOriginalFormat() = withTree { root ->
    val home = File(root, "home")
    val shared = File(root, "shared")
    val legacy = file(home, ".dsh/settings.yaml", "user: before\n")
    file(home, ".dsh/profiles/web/cordis.patch.yml", "- id: old-factory\n")
    val transfer = ConfigTransfer(home, shared)
    val exported = JSONObject(transfer.exportToShared())
    assertTrue(exported.getBoolean("ok"))
    assertTrue(exported.getBoolean("importable"))
    assertEquals("settings.yaml", File(exported.getString("path")).name)
    file(shared, "exports/config/settings.yaml", "user: after\n")
    val imported = JSONObject(transfer.importFromShared())
    assertTrue(imported.getBoolean("ok"))
    assertEquals(File(legacy.parentFile, "settings.yaml.import-backup").absolutePath, imported.getString("backupPath"))
    assertEquals("user: after\n", legacy.readText())
    assertEquals("user: before\n", File(legacy.parentFile, "settings.yaml.import-backup").readText())
    assertEquals("- id: old-factory\n", File(home, ".dsh/profiles/web/cordis.patch.yml").readText())
  }

  @Test fun modernExportImportUsesProfileAndKeepsCompletePrivateBackup() = withTree { root ->
    val home = File(root, "home")
    val dsh = File(home, ".dsh")
    val shared = File(root, "shared")
    val original = "- id: user\n  config:\n    value: before\n"
    val patch = file(dsh, "profiles/web/cordis.patch.yml", original)
    file(dsh, "settings.yaml.imported", "historical settings")
    val exported = SnapshotUserData.exportConfiguration(dsh, shared)
    assertEquals("cordis.patch.yml", exported.name)
    assertEquals(original, exported.readText())
    exported.writeText("- id: user\n  config:\n    value: after\n")
    val imported = JSONObject(ConfigTransfer(home, shared).importFromShared())
    assertTrue(imported.getBoolean("ok"))
    assertEquals(File(patch.parentFile, "cordis.patch.yml.import-backup").absolutePath, imported.getString("backupPath"))
    assertEquals(exported.readText(), patch.readText())
    assertEquals(original, File(patch.parentFile, "cordis.patch.yml.import-backup").readText())
    assertEquals("historical settings", File(dsh, "settings.yaml.imported").readText())
    assertFalse(File(dsh, "settings.yaml").exists())
  }

  @Test fun staleSharedSettingsCannotOverwriteMigratedProfileOrBackup() = withTree { root ->
    val dsh = File(root, "dsh")
    val shared = File(root, "shared")
    val patch = file(dsh, "profiles/web/cordis.patch.yml", "- id: current\n")
    val backup = file(dsh, "profiles/web/cordis.patch.yml.import-backup", "- id: previous\n")
    file(dsh, "settings.yaml.imported", "migrated")
    file(shared, "exports/config/settings.yaml", "obsolete: settings\n")
    val failed = runCatching { SnapshotUserData.importConfiguration(dsh, shared) }
    assertTrue(failed.isFailure)
    assertTrue(failed.exceptionOrNull()!!.message!!.contains("cordis.patch.yml"))
    assertEquals("- id: current\n", patch.readText())
    assertEquals("- id: previous\n", backup.readText())
  }

  @Test fun executableProfileExportIsExplicitlyBackupOnlyAndRejectedBeforeBackupChanges() = withTree { root ->
    val home = File(root, "home")
    val shared = File(root, "shared")
    val patch = file(home, ".dsh/profiles/web/cordis.patch.yml", "- id: user\n  config: !!js 'value'\n")
    val backup = file(home, ".dsh/profiles/web/cordis.patch.yml.import-backup", "previous full document")
    val transfer = ConfigTransfer(home, shared)
    val exported = JSONObject(transfer.exportToShared())
    assertTrue(exported.getBoolean("ok"))
    assertFalse(exported.getBoolean("importable"))
    assertTrue(exported.getString("hint").contains("备份"))
    assertEquals(patch.readText(), File(exported.getString("path")).readText())
    val imported = JSONObject(transfer.importFromShared())
    assertFalse(imported.getBoolean("ok"))
    assertTrue(imported.getString("error").contains("执行型"))
    assertEquals("previous full document", backup.readText())
    assertEquals("- id: user\n  config: !!js 'value'\n", patch.readText())
  }

  @Test fun executableTagAliasesAndQuotedHashesDoNotBypassValidation() {
    for (body in listOf(
      "value: !!js 'x'", "value: !js/function 'x'", "value: !<tag:yaml.org,2002:js> 'x'",
      "value: !!%6A%73 'x'", "value: !<tag:yaml.org,2002:%6A%73> 'x'",
      "%TAG !run! tag:yaml.org,2002:\nvalue: !run!js 'x'",
      "\uFEFF%TAG !run! tag:yaml.org,2002:\nvalue: !run!js 'x'",
      "['# quoted hash', !!js 'x']",
    )) {
      assertTrue(body, SnapshotUserData.firstExecutableTag(body.lines()) != null)
    }
    assertEquals(null, SnapshotUserData.firstExecutableTag(listOf("provider: user", "model: configured")))
  }

  @Test fun legacyRecoveryPreservesMigrationAndNeverRollsBackAShorterCurrentProfile() = withTree { root ->
    val backup = File(root, "backup")
    val live = File(root, "live")
    file(backup, "settings.yaml", "obsolete settings must not return")
    file(backup, "settings.yaml.imported", "historical user configuration")
    file(backup, "profiles/web/cordis.patch.yml", "- id: an-older-longer-user-document\n")
    file(backup, "profiles/custom/cordis.patch.yml", "- id: recover-missing-profile\n")
    val patch = file(live, "profiles/web/cordis.patch.yml", "[]\n")
    SnapshotUserData.restoreLegacyBackup(backup, live) { }
    assertFalse(File(live, "settings.yaml").exists())
    assertEquals("historical user configuration", File(live, "settings.yaml.imported").readText())
    assertEquals("[]\n", patch.readText())
    assertEquals("- id: recover-missing-profile\n", File(live, "profiles/custom/cordis.patch.yml").readText())
  }
}
