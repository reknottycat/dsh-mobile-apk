import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planPiStreaming, OFFICIAL_PI_PATCH_SHA256 } from '../../patches/pi-upstream-streaming-020.mjs'

const root = dirname(fileURLToPath(import.meta.url))
for (const name of ['dsh-credentials', 'dsh-llm', 'dsh-llm-pi-ai']) {
  assert.equal(JSON.parse(readFileSync(join(root, 'node_modules/@deepseek-ai', name, 'package.json'), 'utf8')).version, '0.2.2-rc.1')
}
const piRoot = join(root, 'node_modules/@earendil-works/pi-ai')
const plans = planPiStreaming(piRoot)
for (const plan of plans) if (plan.before !== plan.after) writeFileSync(join(piRoot, plan.file), plan.after)
assert.ok(planPiStreaming(piRoot).every(plan => plan.before === plan.after), 'official patch must be idempotent')
console.log('Prepared Harness 0.2.2-rc.1 adapter / pi-ai 1.3.0 with official patch ' + OFFICIAL_PI_PATCH_SHA256)
