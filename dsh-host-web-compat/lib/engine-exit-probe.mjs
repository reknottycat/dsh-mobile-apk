// Process-lifetime diagnostics for the Android-owned Node engine. This module has no
// Harness dependencies so it can be tested in real, short-lived Node subprocesses.
import { appendFileSync, renameSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const PROBE_KEY = Symbol.for('dsh.android.engine-exit-probe.v1')
const MAX_BYTES = 256 * 1024

/**
 * Install once per Node process, including across Cordis reloads / duplicate imports.
 * Only the Android shell supplies DSH_FILES_DIR; other hosts remain unchanged.
 * The directory must already exist. Diagnostics never create arbitrary directories.
 *
 * Deliberately no SIGTERM/SIGINT listener: Node removes the default terminating action
 * as soon as a signal listener is installed. "Log then exit" also bypasses other
 * plugins' graceful-shutdown handlers. The process owner records requested signals;
 * a missing exit row alone cannot distinguish SIGTERM, SIGKILL, or a native crash.
 */
export function installEngineExitProbe() {
  if (globalThis[PROBE_KEY]) return true
  const directory = process.env.DSH_FILES_DIR
  if (process.env.DSH_ENGINE_EXIT_PROBE === '0' || !directory || !isAbsolute(directory)) return false
  try { if (!statSync(directory).isDirectory()) return false } catch { return false }

  const logPath = join(directory, 'engine-exit.log')
  // Rotate at process start only. At most one small previous generation is retained;
  // writing a terminal event remains a single synchronous append, without async work.
  try { if (statSync(logPath).size >= MAX_BYTES) renameSync(logPath, logPath + '.1') } catch { /* optional */ }
  const write = (event, fields = {}) => {
    try {
      appendFileSync(logPath, JSON.stringify({
        at: new Date().toISOString(), pid: process.pid, event, ...fields,
      }) + '\n', { encoding: 'utf8', mode: 0o600 })
    } catch { /* A full/unwritable disk must not change engine termination. */ }
  }
  const onExit = (code) => write('exit', { code })
  const onException = (_error, origin) => {
    // No exception message, stack, argv, or env: all can contain user data/tokens.
    write('uncaughtException', { origin: origin === 'unhandledRejection' ? origin : 'uncaughtException' })
  }
  globalThis[PROBE_KEY] = { logPath }
  process.on('exit', onExit)
  // Monitor observes without intercepting Node's default exception handling.
  process.on('uncaughtExceptionMonitor', onException)
  write('boot')
  return true
}
