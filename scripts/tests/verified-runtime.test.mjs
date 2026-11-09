import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runtimeArtifact, verifyRuntime } from '../fetch-verified-runtime.mjs'

test('truncation and same-size tampering both prevent use of a downloaded runtime', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-integrity-'))
  const path = join(directory, 'snapshot.tar.xz')
  const bytes = Buffer.from('known immutable archive bytes')
  const artifact = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  try {
    writeFileSync(path, bytes)
    await verifyRuntime(path, artifact)
    writeFileSync(path, bytes.subarray(1))
    await assert.rejects(verifyRuntime(path, artifact), /size mismatch/)
    const altered = Buffer.from(bytes)
    altered[0] ^= 1
    writeFileSync(path, altered)
    await assert.rejects(verifyRuntime(path, artifact), /SHA-256 mismatch/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('ABI cannot silently fall back to another archive or an unpinned download', () => {
  const manifest = { repository: 'owner/repository', tag: 'v1', commit: 'a'.repeat(40),
    engineCommit: 'b'.repeat(40), artifacts: { arm64: {
      url: 'https://github.com/owner/repository/releases/download/v1/snapshot-arm64.tar.xz',
      size: 42, sha256: 'c'.repeat(64) } } }
  assert.equal(runtimeArtifact(manifest, 'arm64').size, 42)
  assert.throws(() => runtimeArtifact(manifest, 'x86_64'), /Invalid pinned/)
  assert.throws(() => runtimeArtifact(manifest, 'armeabi-v7a'), /Unsupported ABI/)
  manifest.artifacts.arm64.url = 'https://example.invalid/unverified.tar.xz'
  assert.throws(() => runtimeArtifact(manifest, 'arm64'), /Invalid pinned/)
})
