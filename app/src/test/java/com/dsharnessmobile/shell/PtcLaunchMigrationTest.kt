package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PtcLaunchMigrationTest {
  private val factory = """
    - id: ptc-runtime
      config:
        launch:
          kind: node-script
          executable: /factory/default-node
  """.trimIndent() + "\n"

  @Test fun upgradePreservesUserExecutableAndEveryOtherConfigValue() {
    val before = """
      # custom runtime settings
      - id: ptc-runtime
        config:
          heapMb: 768
          nodeExecutable: '/user/node with spaces' # keep this comment
          custom:
            nodeExecutable: do-not-touch-nested-value
      - id: user-plugin
        config:
          nodeExecutable: do-not-touch-other-plugin
    """.trimIndent() + "\n"
    val expected = before.replace(
      "    nodeExecutable: '/user/node with spaces' # keep this comment",
      "    launch:\n      kind: node-script\n      executable: '/user/node with spaces' # keep this comment",
    )
    val migrated = FactoryProfilePatch.merge(before, factory)
    assertEquals(expected, migrated.text)
    assertTrue(migrated.changes.any { it.contains("ptc-runtime") })
    assertFalse(migrated.text.contains("/factory/default-node"))
    val repeated = FactoryProfilePatch.merge(migrated.text, factory)
    assertEquals(expected, repeated.text)
    assertTrue(repeated.changes.isEmpty())
  }

  @Test fun insertChildMigrationDoesNotTouchItsSiblingOrTheirNestedIds() {
    val before = """
      - insert:
          - id: another-runtime
            config:
              nodeExecutable: /keep/other
              examples:
                - id: ptc-runtime
                  config:
                    nodeExecutable: /keep/nested
          - id: ptc-runtime
            name: '@deepseek-ai/dsh-ptc-runtime-node'
            config:
              nodeExecutable: /user/wrapper
              custom: true
    """.trimIndent() + "\n"
    val expected = before.replace("        nodeExecutable: /user/wrapper\n",
      "        launch:\n          kind: node-script\n          executable: /user/wrapper\n")
    assertEquals(expected, FactoryProfilePatch.merge(before, factory).text)
  }

  @Test fun crlfAndMissingFinalNewlineArePreserved() {
    val before = "- id: ptc-runtime\r\n  config:\r\n    nodeExecutable: \"/user/bin/node\""
    val expected = "- id: ptc-runtime\r\n  config:\r\n    launch:\r\n      kind: node-script\r\n      executable: \"/user/bin/node\""
    assertEquals(expected, FactoryProfilePatch.merge(before, factory).text)
  }

  @Test fun blockScalarExecutableRetainsItsContents() {
    val before = "- id: ptc-runtime\n  config:\n    nodeExecutable: >-\n      /user/bin/node\n    heapMb: 256\n"
    val expected = "- id: ptc-runtime\n  config:\n    launch:\n      kind: node-script\n      executable: >-\n        /user/bin/node\n    heapMb: 256\n"
    assertEquals(expected, FactoryProfilePatch.merge(before, factory).text)
  }

  @Test fun modernExplicitLaunchAndMixedLegacyFieldRemainUserOwned() {
    val before = """
      - id: ptc-runtime
        config:
          nodeExecutable: /legacy/fallback
          launch:
            kind: embedded
            executable: /user/native-runtime
            bootstrapPath: /user/bootstrap.js
          heapMb: 1024
    """.trimIndent() + "\n"
    val result = FactoryProfilePatch.merge(before, factory)
    assertEquals(before, result.text)
    assertTrue(result.changes.isEmpty())
  }

  @Test fun reusedIdForCustomPackageIsNotMigrated() {
    val before = "- id: ptc-runtime\n  name: user-owned-runtime\n  config:\n    nodeExecutable: /custom/path\n"
    assertEquals(before, FactoryProfilePatch.merge(before, factory).text)
  }

  @Test fun nestedLegacyKeyAndAmbiguousConfigAreLeftUntouched() {
    for (before in listOf(
      "- id: ptc-runtime\n  config:\n    nested:\n      nodeExecutable: /nested/path\n",
      "- id: ptc-runtime\n  config: { nodeExecutable: /inline/path }\n",
      "- id: ptc-runtime\n  config:\n    nodeExecutable: /one\n    nodeExecutable: /two\n",
    )) assertEquals(before, FactoryProfilePatch.merge(before, factory).text)
  }

  @Test fun oldFactoryDoesNotRewriteConfigurationToANewerSchema() {
    val before = "- id: ptc-runtime\n  config:\n    nodeExecutable: /user/path\n"
    assertEquals(before, FactoryProfilePatch.merge(before, before).text)
  }
}
