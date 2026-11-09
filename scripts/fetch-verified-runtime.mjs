#!/usr/bin/env node
// Fetch an immutable, checksum-verified Android runtime before the existing APK gates.
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function runtimeArtifact(manifest, abi) {
  if (!['arm64', 'x86_64'].includes(abi)) throw new Error(`Unsupported ABI: ${abi}`)
  const artifact = manifest.artifacts?.[abi]
  const prefix = `https://github.com/${manifest.repository}/releases/download/${manifest.tag}/`
  if (!artifact || artifact.url !== `${prefix}snapshot-${abi}.tar.xz` ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || artifact.size <= 0 ||
      !/^[a-f0-9]{40}$/.test(manifest.commit) || !/^[a-f0-9]{40}$/.test(manifest.engineCommit)) {
    throw new Error(`Invalid pinned runtime manifest for ${abi}`)
  }
  return artifact
}

export async function verifyRuntime(file, artifact) {
  if (statSync(file).size !== artifact.size) throw new Error('Runtime size mismatch; refusing to build')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  if (hash.digest('hex') !== artifact.sha256) throw new Error('Runtime SHA-256 mismatch; refusing to build')
}

async function main() {
  const args = process.argv.slice(2)
  const value = (key, fallback) => {
    const index = args.indexOf(key)
    return index < 0 ? fallback : args[index + 1]
  }
  const abi = value('--abi', 'arm64')
  const manifest = JSON.parse(readFileSync(resolve(root, 'scripts/snapshot-config/verified-runtime.json'), 'utf8'))
  const contract = JSON.parse(readFileSync(resolve(root, 'scripts/contract.json'), 'utf8'))
  if (manifest.engineVersion !== contract.baseline || manifest.engineCommit !== contract.upstream.commit) {
    throw new Error('Pinned runtime and Harness contract disagree; refusing to build')
  }
  const artifact = runtimeArtifact(manifest, abi)
  const output = resolve(value('--output', resolve(root, `.deploy-tmp/snapshot-013/${abi}/snapshot.tar.xz`)))
  mkdirSync(dirname(output), { recursive: true })
  const temporary = `${output}.download-${process.pid}`
  try {
    if (existsSync(output)) {
      await verifyRuntime(output, artifact)
    } else {
      const result = spawnSync('curl', ['--fail', '--location', '--proto', '=https', '--proto-redir', '=https',
        '--retry', '2', '--max-time', '300', '--output', temporary, artifact.url], { stdio: 'inherit' })
      if (result.status !== 0) throw new Error(`Runtime download failed (${result.status ?? result.error?.code})`)
      await verifyRuntime(temporary, artifact)
      renameSync(temporary, output)
    }
    writeFileSync(`${output}.source.json`, JSON.stringify({ abi, repository: manifest.repository,
      tag: manifest.tag, commit: manifest.commit, engineVersion: manifest.engineVersion,
      engineCommit: manifest.engineCommit, ...artifact }, null, 2) + '\n')
    console.log(`Verified ${abi}: Harness ${manifest.engineVersion}, SHA-256 ${artifact.sha256}`)
    console.log(output)
  } finally {
    rmSync(temporary, { force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
