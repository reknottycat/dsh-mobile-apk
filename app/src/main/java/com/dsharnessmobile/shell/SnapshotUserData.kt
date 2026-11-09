package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.Files
import java.nio.file.NoSuchFileException
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.nio.file.attribute.BasicFileAttributes

/**
 * Recovers the user-owned subset of DSH_HOME from a backup left by a pre-transaction
 * refresh (versions up to 0.13.2 copied `.dsh` aside, extracted over the live tree and
 * copied it back; a kill in the middle left `.dsh-backup` behind).
 *
 * The current refresh no longer creates that backup — [SnapshotTransaction] never
 * touches user-owned paths — so this restore is a one-time migration (only reachable
 * via a leftover `.dsh-backup` from ≤0.13.2).
 *
 * Boundary (review C14, comment corrected to match behavior): for the user-owned trees
 * the restore is deliberately additive — only missing entries and truncated regular
 * files are copied, so a stale backup can never roll back data the user created after
 * the interrupted refresh. The small singletons in [replacedSingletons] are the
 * exception: they are replaced wholesale, because the interrupted refresh could have
 * overwritten them with factory content during extraction, which makes the
 * pre-extraction backup the authoritative content for exactly those files.
 * Broken symbolic links are logged and skipped, and the live source tree is never
 * mutated to make a copy work.
 */
internal object SnapshotUserData {

  /** DSH_HOME paths that survive a factory snapshot replacement. */
  internal val preservedNames = listOf(
    "sessions", "storages", "attachments", "workspaces", "undo-snapshots", "llm-deepseek",
    ".credentials.yaml", "settings.yaml", "settings.yaml.imported", ".anonymous-user-id", ".private-layout",
    "models-store.json", ".node-compile-cache",
  )

  /**
   * Small singletons that are restored wholesale. A leftover backup means the refresh
   * that could have overwritten them did not finish, and the backup copy predates that
   * extraction, so it is the authoritative content.
   */
  private val replacedSingletons = setOf(
    "settings.yaml", ".credentials.yaml", ".anonymous-user-id", ".private-layout", "models-store.json",
  )

  /**
   * A missing legacy file after import is intentional. Remove factory seeds only from
   * staging, before the transaction merges it with the live, user-owned profile tree.
   */
  fun prepareStagedSnapshot(stagedDsh: File, liveDsh: File): List<String> {
    require(stagedDsh.canonicalFile != liveDsh.canonicalFile) { "staging must differ from live DSH_HOME" }
    val notes = mutableListOf<String>()
    fun discard(path: File, label: String) {
      if (!SnapshotFs.exists(path)) return
      SnapshotFs.deletePathStrict(path)
      notes += "省略出厂用户数据 " + label
    }
    val liveProfiles = File(liveDsh, "profiles")
    val hasProfilePatch = liveProfiles.listFiles()?.any {
      !Files.isSymbolicLink(it.toPath()) && it.isDirectory && SnapshotFs.exists(File(it, "cordis.patch.yml"))
    } == true
    if (SnapshotFs.exists(File(liveDsh, "settings.yaml.imported")) ||
        (!SnapshotFs.exists(File(liveDsh, "settings.yaml")) && hasProfilePatch)) {
      discard(File(stagedDsh, "settings.yaml"), "settings.yaml（已迁移到活动 profile）")
    }
    // Migration markers describe one installation; a factory archive cannot supply them.
    discard(File(stagedDsh, "settings.yaml.imported"), "settings.yaml.imported")
    val stagedProfiles = File(stagedDsh, "profiles")
    if (Files.isSymbolicLink(stagedProfiles.toPath())) return notes
    for (profile in stagedProfiles.listFiles() ?: emptyArray()) {
      if (Files.isSymbolicLink(profile.toPath()) || !profile.isDirectory) continue
      val liveProfile = File(liveProfiles, profile.name)
      if (SnapshotFs.exists(File(liveProfile, "settings.yaml.imported"))) {
        discard(File(profile, "settings.yaml"), "profiles/" + profile.name + "/settings.yaml（已迁移）")
      }
      discard(File(profile, "settings.yaml.imported"), "profiles/" + profile.name + "/settings.yaml.imported")
      for (name in preservedNames) {
        if (SnapshotFs.exists(File(liveProfile, name))) {
          discard(File(profile, name), "profiles/" + profile.name + "/" + name)
        }
      }
    }
    return notes
  }

  /** Selects the actual document, retaining legacy settings until migration has happened. */
  fun configurationDocument(dshRoot: File, profileName: String = "web"): File {
    val legacy = File(dshRoot, "settings.yaml")
    val profile = File(File(dshRoot, "profiles"), profileName)
    val patch = File(profile, "cordis.patch.yml")
    val migrated = SnapshotFs.exists(File(dshRoot, "settings.yaml.imported")) ||
      SnapshotFs.exists(File(profile, "settings.yaml.imported"))
    return if (migrated || (!SnapshotFs.exists(legacy) && SnapshotFs.exists(patch))) patch else legacy
  }

  /** Exports the complete active document; executable YAML remains backup-only. */
  @Synchronized
  fun exportConfiguration(dshRoot: File, sharedRoot: File): File {
    val source = configurationDocument(dshRoot)
    require(source.isFile && !Files.isSymbolicLink(source.toPath())) { "活动配置尚未生成，请等待引擎初始化后再导出" }
    val directory = File(File(sharedRoot, "exports"), "config")
    SnapshotFs.createDirectories(directory)
    return File(directory, source.name).also { replaceConfiguration(source.readBytes(), it) }
  }

  /** External documents may not introduce executable Cordis YAML or tag aliases. */
  internal fun firstExecutableTag(document: List<String>): Pair<Int, String>? {
    // Do not strip comments: '#' can occur inside a quoted scalar before an executable
    // tag. Conservative rejection also covers comments, verbatim tags and encoded
    // tag suffixes, which could otherwise spell the same executable tag indirectly.
    val pattern = Regex("""!!?\s*(?:js\b|[^\s,\]}]*%)|!<[^>]*>|^\s*%TAG\b""", RegexOption.IGNORE_CASE)
    document.forEachIndexed { index, line ->
      val match = pattern.find(line.removePrefix("\uFEFF"))
      if (match != null) return (index + 1) to match.value
    }
    return null
  }

  /** Validates one captured input, backs up the full private document, then replaces it. */
  @Synchronized
  fun importConfiguration(dshRoot: File, sharedRoot: File): File {
    val target = configurationDocument(dshRoot)
    val source = File(File(File(sharedRoot, "exports"), "config"), target.name)
    require(source.isFile && !Files.isSymbolicLink(source.toPath())) {
      "未找到 exports/config/" + target.name + "；请先导出当前活动配置（旧 settings.yaml 不会覆盖已迁移的 profile）"
    }
    require(target.isFile && !Files.isSymbolicLink(target.toPath())) { "活动配置尚未生成，请等待引擎初始化后再导入" }
    val content = source.readBytes()
    val offending = firstExecutableTag(content.toString(Charsets.UTF_8).lines())
    require(offending == null) {
      "拒绝导入：exports/config/" + target.name + " 含执行型 YAML 标签或标签别名（第 " +
        offending?.first + " 行）。完整配置可作备份；共享目录导入不允许执行型标签，请先移除后再导入。"
    }
    replaceConfiguration(target.readBytes(), File(target.parentFile, target.name + ".import-backup"))
    replaceConfiguration(content, target)
    return target
  }

  private fun replaceConfiguration(content: ByteArray, target: File) {
    val temporary = File.createTempFile(".config-", ".tmp", target.parentFile)
    try {
      temporary.writeBytes(content)
      Files.move(temporary.toPath(), target.toPath(), ATOMIC_MOVE, REPLACE_EXISTING)
    } finally {
      Files.deleteIfExists(temporary.toPath())
    }
  }

  internal data class CopyResult(
    val copiedEntries: Int,
    val skippedExisting: Int,
    val skippedBrokenLinks: Int,
  )

  fun restoreLegacyBackup(
    backupRoot: File,
    destinationRoot: File,
    onBrokenLink: (File) -> Unit,
  ): CopyResult {
    if (!SnapshotFs.exists(backupRoot)) return CopyResult(0, 0, 0)
    SnapshotFs.createDirectories(destinationRoot)
    var copied = 0
    var skipped = 0
    var broken = 0
    val migratedSettings = SnapshotFs.exists(File(destinationRoot, "settings.yaml.imported")) ||
      SnapshotFs.exists(File(backupRoot, "settings.yaml.imported"))
    for (name in preservedNames + "profiles") {
      val source = File(backupRoot, name)
      if (!SnapshotFs.exists(source)) continue
      // Never re-import an obsolete root document over a recovered/current profile.
      if (name == "settings.yaml" && migratedSettings) { skipped++; continue }
      val destination = File(destinationRoot, name)
      val result = if (name in replacedSingletons) {
        replaceEntry(source, destination, onBrokenLink)
      } else {
        // A valid user profile can become shorter after editing. Only missing profile
        // files may be recovered; the session truncation heuristic does not apply.
        mergeMissing(source, destination, onBrokenLink, replaceTruncated = name != "profiles")
      }
      copied += result.copiedEntries
      skipped += result.skippedExisting
      broken += result.skippedBrokenLinks
    }
    return CopyResult(copied, skipped, broken)
  }

  private fun replaceEntry(source: File, destination: File, onBrokenLink: (File) -> Unit): CopyResult {
    SnapshotFs.deletePath(destination)
    return mergeMissing(source, destination, onBrokenLink)
  }

  /** Copies only what the destination lacks: missing entries and truncated regular files. */
  private fun mergeMissing(
    source: File,
    destination: File,
    onBrokenLink: (File) -> Unit,
    replaceTruncated: Boolean = true,
  ): CopyResult {
    val sourcePath = source.toPath()
    val attributes = Files.readAttributes(sourcePath, BasicFileAttributes::class.java, java.nio.file.LinkOption.NOFOLLOW_LINKS)
    return try {
      when {
        attributes.isSymbolicLink -> {
          if (!Files.exists(sourcePath)) {
            // Dangling link: disposable runtime residue, never recreated.
            onBrokenLink(source)
            CopyResult(0, 0, 1)
          } else if (SnapshotFs.exists(destination)) {
            CopyResult(0, 1, 0)
          } else {
            SnapshotFs.createDirectories(destination.parentFile ?: source.parentFile)
            Files.createSymbolicLink(destination.toPath(), Files.readSymbolicLink(sourcePath))
            CopyResult(1, 0, 0)
          }
        }
        attributes.isDirectory -> {
          SnapshotFs.createDirectories(destination)
          var copied = 0
          var skipped = 0
          var broken = 0
          Files.list(sourcePath).use { children ->
            children.forEach { child ->
              val result = mergeMissing(child.toFile(), File(destination, child.fileName.toString()), onBrokenLink, replaceTruncated)
              copied += result.copiedEntries
              skipped += result.skippedExisting
              broken += result.skippedBrokenLinks
            }
          }
          CopyResult(copied, skipped, broken)
        }
        attributes.isRegularFile -> {
          val existing = if (SnapshotFs.exists(destination)) destination.length() else -1L
          if (existing >= attributes.size() || (existing >= 0L && !replaceTruncated)) {
            CopyResult(0, 1, 0)
          } else {
            SnapshotFs.createDirectories(destination.parentFile ?: source.parentFile)
            SnapshotFs.deletePath(destination)
            Files.copy(sourcePath, destination.toPath())
            CopyResult(1, 0, 0)
          }
        }
        else -> throw IllegalStateException("unsupported user-data entry: " + source.absolutePath)
      }
    } catch (e: NoSuchFileException) {
      if (!attributes.isSymbolicLink) throw e
      onBrokenLink(source)
      CopyResult(0, 0, 1)
    }
  }
}
