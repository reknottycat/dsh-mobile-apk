import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundleCheck, buildConfig, computeSafeBundles, runDoctor } from '../lib/core.mjs'

const CORE = new URL('../lib/core.mjs', import.meta.url).href

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bundle-preflight-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const profile = join(home, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  const cfg = buildConfig({ homeDir: home, profileDir: profile, profileName: 'web',
    manualDir: join(root, 'manual'), autoDir: join(root, 'auto') })
  return { root, home, profile, cfg }
}

function bundle(base, name, patch, files = []) {
  const dir = join(base, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, dsh: { bundle: { patch } } }))
  for (const file of files) writeFileSync(join(dir, file), '[]\n')
  return dir
}

test('legacy string and all five dsh-web-app patches pass real doctor preflight', async (t) => {
  const f = fixture(t)
  bundle(f.profile, 'dsh-base', './base.yml', ['base.yml'])
  const patches = ['one.yml', 'two.yml', 'three.yml', 'four.yml', 'five.yml']
  bundle(f.profile, 'dsh-web-app', patches, patches)
  writeFileSync(join(f.profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-base', 'dsh-web-app'] } } }))
  assert.equal((await bundleCheck(f.cfg, 'dsh-base')).ok, true)
  assert.equal((await bundleCheck(f.cfg, 'dsh-web-app')).ok, true)
  const doctor = await runDoctor(f.cfg)
  assert.deepEqual(doctor.checks.filter((check) => check.code === 'pre-bundle'), [])
  const safe = await computeSafeBundles(f.cfg, { dsh: { profile: { bundles: ['dsh-base', 'dsh-web-app'] } } })
  assert.deepEqual(safe.kept, ['dsh-base', 'dsh-web-app'])
  assert.deepEqual(safe.pruned, [])
})

test('a missing later patch is detected rather than checking just the first', async (t) => {
  const f = fixture(t)
  bundle(f.profile, 'dsh-web-app', ['first.yml', 'missing.yml'], ['first.yml'])
  const result = await bundleCheck(f.cfg, 'dsh-web-app')
  assert.equal(result.ok, false)
  assert.match(result.reason, /missing\.yml/)
  writeFileSync(join(f.profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-web-app'] } } }))
  const errors = (await runDoctor(f.cfg)).checks.filter((check) => check.code === 'pre-bundle')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].level, 'err')
  assert.match(errors[0].detail, /missing\.yml/)
})

test('invalid patch declarations and directories still fail closed', async (t) => {
  const f = fixture(t)
  const invalid = [undefined, null, '', ' ', 3, {}, ['first.yml', null], ['first.yml', '']]
  for (let i = 0; i < invalid.length; i++) {
    const name = `invalid-${i}`
    bundle(f.profile, name, invalid[i], ['first.yml'])
    assert.equal((await bundleCheck(f.cfg, name)).ok, false, JSON.stringify(invalid[i]))
  }
  const dir = bundle(f.profile, 'directory-patch', 'not-a-file')
  mkdirSync(join(dir, 'not-a-file'))
  assert.equal((await bundleCheck(f.cfg, 'directory-patch')).ok, false)
})

test('an explicitly empty patch list is a valid bundle, matching Harness', async (t) => {
  const f = fixture(t)
  const dir = bundle(f.profile, 'empty-bundle', [])
  assert.deepEqual(await bundleCheck(f.cfg, 'empty-bundle'), { ok: true, dir })
})

test('a home override resolves its own packages instead of a module-load DSH_HOME', async (t) => {
  const f = fixture(t)
  // Keep the profile outside home so Node's ancestor search cannot accidentally
  // make the old, module-load DSH_HOME anchor appear correct.
  f.cfg.profileDir = join(f.root, 'elsewhere', 'web')
  mkdirSync(f.cfg.profileDir, { recursive: true })
  const dir = bundle(f.home, 'dsh-home-bundle', 'home.yml', ['home.yml'])
  assert.deepEqual(await bundleCheck(f.cfg, 'dsh-home-bundle'), { ok: true, dir })
})

test('an engine-only bundle resolves from the actual process entry, including symlinks', (t) => {
  const f = fixture(t)
  const engine = join(f.root, 'engine')
  mkdirSync(join(engine, 'lib'), { recursive: true })
  const dir = bundle(engine, 'agent-team-profile', 'team.yml', ['team.yml'])
  const entry = join(engine, 'lib', 'bin.mjs')
  writeFileSync(entry, `import { bundleCheck } from ${JSON.stringify(CORE)}; console.log(JSON.stringify(await bundleCheck(${JSON.stringify(f.cfg)}, 'agent-team-profile')))`)
  for (const script of [entry, join(f.root, 'dsh.mjs')]) {
    if (script !== entry) symlinkSync(entry, script)
    const run = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 5000 })
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(JSON.parse(run.stdout), { ok: true, dir })
  }
  // The engine fallback must not hide a broken local override at the previous priority.
  bundle(f.profile, 'agent-team-profile', ['absent.yml'])
  const run = spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 5000 })
  assert.equal(run.status, 0, run.stderr)
  const result = JSON.parse(run.stdout)
  assert.equal(result.ok, false)
  assert.ok(result.reason.includes(join(f.profile, 'node_modules', 'agent-team-profile', 'absent.yml')))
})

test('an entirely unresolved bundle remains an error', async (t) => {
  const f = fixture(t)
  assert.deepEqual(await bundleCheck(f.cfg, 'missing-bundle-fixture'), { ok: false, reason: 'cannot resolve missing-bundle-fixture' })
})
