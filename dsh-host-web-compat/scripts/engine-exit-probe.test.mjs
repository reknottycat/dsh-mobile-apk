import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PROBE = new URL('../lib/engine-exit-probe.mjs', import.meta.url).href

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-engine-exit-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const entry = join(directory, 'engine.mjs')
  const log = join(directory, 'engine-exit.log')
  return {
    directory, entry, log,
    write(body) {
      writeFileSync(entry, `import { installEngineExitProbe } from ${JSON.stringify(PROBE)}\n${body}`)
    },
    rows() { return readFileSync(log, 'utf8').trim().split('\n').map((row) => JSON.parse(row)) },
    env(extra = {}) { return { ...process.env, DSH_FILES_DIR: directory, DSH_ENGINE_EXIT_PROBE: '1', ...extra } },
  }
}

test('normal exit records boot and the actual exit code, without keeping Node alive', (t) => {
  const f = fixture(t)
  f.write('installEngineExitProbe(); process.exitCode = 7')
  const run = spawnSync(process.execPath, [f.entry], { env: f.env(), timeout: 5000 })
  assert.equal(run.error, undefined)
  assert.equal(run.status, 7)
  assert.deepEqual(f.rows().map(({ event, code }) => ({ event, code })), [
    { event: 'boot', code: undefined }, { event: 'exit', code: 7 },
  ])
  assert.ok(f.rows().every((row) => Number.isInteger(row.pid) && !Number.isNaN(Date.parse(row.at))))
})

test('uncaught exception remains fatal; secrets in errors or env never enter the log', (t) => {
  const f = fixture(t)
  f.write("installEngineExitProbe(); throw new Error('token=SECRET_TEST_TOKEN')")
  const run = spawnSync(process.execPath, [f.entry], { env: f.env({ DSH_PICK_TOKEN: 'SECRET_TEST_TOKEN' }), timeout: 5000 })
  assert.equal(run.status, 1)
  assert.deepEqual(f.rows().map((row) => row.event), ['boot', 'uncaughtException', 'exit'])
  assert.equal(f.rows().at(-1).code, 1)
  assert.equal(readFileSync(f.log, 'utf8').includes('SECRET_TEST_TOKEN'), false)
})

test('an existing exception handler keeps its behavior', (t) => {
  const f = fixture(t)
  f.write("process.on('uncaughtException', () => { process.exitCode = 17 }); installEngineExitProbe(); throw new Error('handled')")
  const run = spawnSync(process.execPath, [f.entry], { env: f.env(), timeout: 5000 })
  assert.equal(run.status, 17)
  assert.equal(f.rows().at(-1).code, 17)
})

test('repeated apply and a fresh module import add no duplicate observers or boot rows', (t) => {
  const f = fixture(t)
  f.write(`
    import assert from 'node:assert/strict'
    const before = Object.fromEntries(['exit', 'uncaughtExceptionMonitor', 'SIGTERM', 'SIGINT'].map((event) => [event, process.listenerCount(event)]))
    installEngineExitProbe()
    installEngineExitProbe()
    const again = await import(${JSON.stringify(PROBE + '?reload=1')})
    again.installEngineExitProbe()
    for (const event of ['exit', 'uncaughtExceptionMonitor']) assert.equal(process.listenerCount(event), before[event] + 1)
    for (const event of ['SIGTERM', 'SIGINT']) assert.equal(process.listenerCount(event), before[event])
  `)
  const run = spawnSync(process.execPath, [f.entry], { env: f.env(), timeout: 5000 })
  assert.equal(run.status, 0, run.stderr.toString())
  assert.deepEqual(f.rows().map((row) => row.event), ['boot', 'exit'])
})

async function signalChild(t, f, signal) {
  const child = spawn(process.execPath, [f.entry], { env: f.env(), stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  const result = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, received) => resolve({ code, signal: received }))
  })
  await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.stdout.once('data', resolve)
    child.once('close', () => reject(new Error('child exited before ready')))
  })
  child.kill(signal)
  return result
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGKILL']) {
  test(`${signal} keeps its default signal termination; absence of an exit row is not a diagnosis`, { timeout: 5000 }, async (t) => {
    const f = fixture(t)
    f.write("installEngineExitProbe(); setInterval(() => {}, 1000); process.stdout.write('ready')")
    assert.deepEqual(await signalChild(t, f, signal), { code: null, signal })
    assert.deepEqual(f.rows().map((row) => row.event), ['boot'])
  })
}

test('an existing SIGTERM handler can finish its graceful shutdown', { timeout: 5000 }, async (t) => {
  const f = fixture(t)
  f.write(`
    const keepAlive = setInterval(() => {}, 1000)
    process.once('SIGTERM', () => { clearInterval(keepAlive); process.exitCode = 23 })
    installEngineExitProbe()
    process.stdout.write('ready')
  `)
  assert.deepEqual(await signalChild(t, f, 'SIGTERM'), { code: 23, signal: null })
  assert.deepEqual(f.rows().map((row) => row.event), ['boot', 'exit'])
  assert.equal(f.rows().at(-1).code, 23)
})

test('probe is Android scoped, optional, and tolerates an unwritable log path', (t) => {
  const f = fixture(t)
  f.write('installEngineExitProbe(); process.exitCode = 3')
  for (const settings of [{ DSH_FILES_DIR: '' }, { DSH_FILES_DIR: 'relative' }, { DSH_ENGINE_EXIT_PROBE: '0' }]) {
    const run = spawnSync(process.execPath, [f.entry], { env: f.env(settings), timeout: 5000 })
    assert.equal(run.status, 3)
    assert.equal(existsSync(f.log), false)
  }
  // A file instead of a directory fails before observers are installed.
  const run = spawnSync(process.execPath, [f.entry], { env: f.env({ DSH_FILES_DIR: f.entry }), timeout: 5000 })
  assert.equal(run.status, 3)
  assert.equal(existsSync(f.log), false)
  // Once installed, even appendFileSync failing (EISDIR) must not replace exitCode.
  mkdirSync(f.log)
  const blocked = spawnSync(process.execPath, [f.entry], { env: f.env(), timeout: 5000 })
  assert.equal(blocked.status, 3)
})

test('a large previous log is rotated at boot', (t) => {
  const f = fixture(t)
  writeFileSync(f.log, 'x'.repeat(256 * 1024))
  f.write('installEngineExitProbe()')
  const run = spawnSync(process.execPath, [f.entry], { env: f.env(), timeout: 5000 })
  assert.equal(run.status, 0)
  assert.equal(readFileSync(f.log + '.1', 'utf8').length, 256 * 1024)
  assert.deepEqual(f.rows().map((row) => row.event), ['boot', 'exit'])
})
