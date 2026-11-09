import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { planPiStreaming } from '../patches/pi-upstream-streaming-020.mjs'

// Run npm ci --ignore-scripts and npm run prepare-runtime in the adjacent locked
// fixture first. --engine-root may point at another identically pinned npm tree.
const here = dirname(fileURLToPath(import.meta.url))
const option = name => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const runtimeRoot = resolve(option('--engine-root') ?? join(here, 'codex-protocol-runtime'))
const runtimeRequire = createRequire(join(runtimeRoot, 'package.json'))
const load = name => import(pathToFileURL(runtimeRequire.resolve(name)).href)
const readPackage = name => JSON.parse(readFileSync(join(runtimeRoot, 'node_modules', name, 'package.json'), 'utf8'))

test('saved Codex custom service uses real Responses HTTP with isolated credentials', { timeout: 30000 }, async () => {
  for (const name of ['dsh-credentials', 'dsh-llm', 'dsh-llm-pi-ai']) assert.equal(readPackage('@deepseek-ai/' + name).version, '0.2.2-rc.1')
  assert.equal(readPackage('@deepseek-ai/cordis').version, '4.1.0')
  assert.equal(readPackage('@earendil-works/pi-ai').version, '1.3.0')
  assert.ok(planPiStreaming(join(runtimeRoot, 'node_modules/@earendil-works/pi-ai')).every(plan => plan.before === plan.after),
    'apply the official pi-ai patch with npm run prepare-runtime before this test')
  const [{ Context }, { CredentialProvider }, { default: LlmRuntime, BlockAssembler, createUserMessage }, PiAi, { stream: codexStream }] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-credentials'), load('@deepseek-ai/dsh-llm'),
    load('@deepseek-ai/dsh-llm-pi-ai'), import(pathToFileURL(join(runtimeRoot, 'node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js')).href),
  ])
  const temporaryHome = mkdtempSync(join(tmpdir(), 'codex-protocol-'))
  const priorHome = process.env.DSH_HOME
  process.env.DSH_HOME = temporaryHome
  const subscriptionFile = join(temporaryHome, 'plugins/subscriptions/auth.json')
  mkdirSync(dirname(subscriptionFile), { recursive: true })
  const originalSubscription = JSON.stringify({ codex: { default: 'fixture', accounts: { fixture: { accessToken: 'official-subscription-sentinel', refreshToken: 'official-refresh-sentinel' } } } })
  writeFileSync(subscriptionFile, originalSubscription, { mode: 0o600 })
  const refs = new Map()
  const credentialReads = []
  const credentialWrites = []
  const officialGrant = { kind: 'grant', payload: { type: 'oauth', access: 'official-pi-sentinel', refresh: 'official-pi-refresh-sentinel', expires: Date.now() + 3600000 } }
  const records = new Map([['llm-pi-ai/openai-codex', structuredClone(officialGrant)]])
  const credentials = {
    async resolve(ref) { credentialReads.push(['resolve', ref]); const value = refs.get(ref); return value === undefined ? undefined : { value, source: 'test' } },
    async describe(ref) { credentialReads.push(['describe', ref]); return { configured: refs.has(ref), writable: true, source: refs.has(ref) ? 'test' : undefined } },
    async set(ref, value) { credentialWrites.push(['set', ref]); refs.set(ref, value) },
    async unset(ref) { credentialWrites.push(['unset', ref]); refs.delete(ref) },
    async readRecord(key) { credentialReads.push(['readRecord', key]); return records.get(key) },
    async describeRecord(key) { credentialReads.push(['describeRecord', key]); return { configured: records.has(key), writable: true } },
    async listRecords() { credentialReads.push(['listRecords']); return [...records].map(([key, value]) => ({ key, kind: value.kind })) },
    async modifyRecord(key, mutate) { credentialWrites.push(['modifyRecord', key]); const value = await mutate(records.get(key)); if (value !== undefined) records.set(key, value); return records.get(key) },
    async deleteRecord(key) { credentialWrites.push(['deleteRecord', key]); records.delete(key) },
  }
  class ProbeCredentials extends CredentialProvider {
    constructor(ctx) { super(ctx); for (const [name, method] of Object.entries(credentials)) this[name] = method }
  }
  let revision = 3
  let settingsValue = { providers: { unrelated: { api: 'openai-completions', baseURL: 'https://unchanged.invalid/v1', models: [{ id: 'keep-me' }] } } }
  const unrelatedBefore = structuredClone(settingsValue.providers.unrelated)
  const settings = {
    describe(options) {
      assert.equal(options.redactSecrets, true)
      return [{ ns: 'llm-pi-ai', revision, value: structuredClone(settingsValue) }]
    },
    async mutate(ns, mutations, expectedRevision) {
      assert.equal(ns, 'llm-pi-ai')
      assert.equal(expectedRevision, revision, 'controller must use the observed revision')
      for (const mutation of mutations) {
        assert.equal(mutation.op, 'set')
        assert.deepEqual(mutation.path, ['providers', 'codex-custom'])
        settingsValue.providers['codex-custom'] = structuredClone(mutation.value)
      }
      revision += 1
      return { revision, value: structuredClone(settingsValue) }
    },
  }
  const calls = []
  const item = { type: 'message', id: 'msg_custom', role: 'assistant', content: [{ type: 'output_text', text: 'custom gateway works', annotations: [] }] }
  const frames = [
    { type: 'response.created', response: { id: 'resp_custom' } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_custom', status: 'completed', output: [item], usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } } },
  ]
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    calls.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`)
    res.end()
  })
  await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady))
  const baseURL = `http://127.0.0.1:${server.address().port}/gateway/v1`
  const modelId = 'arbitrary-codex-gateway-model'
  const run = async profile => {
    const ctx = new Context()
    try {
      await ctx.plugin(ProbeCredentials)
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(PiAi, { providers: { 'codex-custom': profile } })
      const assembler = new BlockAssembler()
      for await (const chunk of ctx.llm.stream({ provider: 'codex-custom', model: modelId,
        messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Hello gateway' }] })],
        signal: AbortSignal.timeout(10000) })) assembler.push(chunk)
      return { finish: assembler.finish, content: assembler.message({ provider: 'codex-custom', model: modelId }).content }
    } finally { await ctx.fiber.dispose() }
  }
  try {
    const { createCodexCustomService, CODEX_CUSTOM_ROUTE } = await import('../../vendor/dsh-plugin-subscriptions/lib/codex-custom.js')
    assert.equal(CODEX_CUSTOM_ROUTE, 'codex-custom')
    const service = createCodexCustomService(() => ({ settings, credentials }))
    const initial = await service.get()
    assert.equal(initial.configured, false)
    assert.equal(initial.keyConfigured, false)
    await service.set({ baseURL, model: modelId, apiKey: 'plain-gateway-key', expectedRevision: revision })
    const firstProfile = structuredClone(settingsValue.providers['codex-custom'])
    assert.equal(firstProfile.api, 'openai-responses')
    assert.match(firstProfile.apiKeyEnv, /^SUBSCRIPTIONS_CODEX_CUSTOM_[A-Fa-f0-9]+_API_KEY$/)
    assert.deepEqual(firstProfile.models, [{ id: modelId }], 'exercise production defaults without adding capacity fields in the test')
    const first = await run(firstProfile)
    assert.deepEqual(first, { finish: { kind: 'stop' }, content: [{ type: 'text', text: 'custom gateway works' }] })
    await service.set({ baseURL, model: modelId, apiKey: 'rotated-gateway-key', expectedRevision: revision })
    const secondProfile = structuredClone(settingsValue.providers['codex-custom'])
    const second = await run(secondProfile)
    assert.deepEqual(second, first)
    assert.deepEqual(calls.map(call => call.url), ['/gateway/v1/responses', '/gateway/v1/responses'])
    assert.deepEqual(calls.map(call => call.headers.authorization), ['Bearer plain-gateway-key', 'Bearer rotated-gateway-key'])
    for (const call of calls) {
      assert.equal(call.method, 'POST')
      assert.equal(call.body.model, modelId)
      assert.equal(call.body.stream, true)
      assert.equal(call.headers['chatgpt-account-id'], undefined)
      assert.equal(JSON.stringify(call).includes('official-'), false)
    }
    refs.delete(secondProfile.apiKeyEnv)
    const missing = await run(secondProfile)
    assert.equal(missing.finish.kind, 'error')
    assert.equal(missing.finish.failure.code, 'MISSING_CREDENTIAL')
    assert.equal(calls.length, 2, 'missing configured credential must not reach the gateway or fall back to OAuth')
    assert.equal(credentialReads.some(entry => ['readRecord', 'describeRecord', 'listRecords'].includes(entry[0])), false)
    assert.equal(credentialWrites.some(entry => ['modifyRecord', 'deleteRecord'].includes(entry[0])), false)
    assert.deepEqual(records.get('llm-pi-ai/openai-codex'), officialGrant)
    assert.equal(readFileSync(subscriptionFile, 'utf8'), originalSubscription)
    assert.deepEqual(settingsValue.providers.unrelated, unrelatedBefore)
    assert.equal(JSON.stringify(settingsValue).includes('gateway-key'), false, 'settings stores only the credential reference')
    const model = { type: 'chat', id: modelId, name: 'mock', api: 'openai-codex-responses', provider: 'openai-codex', baseUrl: baseURL,
      reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
    const errors = []
    for await (const event of codexStream(model, { messages: [] }, { apiKey: 'plain-gateway-key', transport: 'sse', signal: AbortSignal.timeout(10000) })) {
      if (event.type === 'error') errors.push(event.error.errorMessage)
    }
    assert.equal(errors.length, 1)
    assert.match(errors[0], /Failed to extract accountId from token/)
    assert.equal(calls.length, 2, 'Codex-special transport rejects a normal key before network')
    const evidence = { harnessVersion: '0.2.2-rc.1', piAiVersion: '1.3.0', requests: calls.map(call => ({ method: call.method, path: call.url, model: call.body.model })),
      first, second, missingKeyCode: missing.finish.failure.code, officialOAuthRead: false, officialOAuthUnchanged: true,
      subscriptionAuthFileUnchanged: true, unrelatedProviderUnchanged: true, codexSpecialError: errors[0] }
    if (option('--output') !== undefined) writeFileSync(resolve(option('--output')), JSON.stringify(evidence, null, 2) + '\n')
  } finally {
    await new Promise(resolveClosed => { server.close(resolveClosed); server.closeAllConnections() })
    if (priorHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = priorHome
    rmSync(temporaryHome, { recursive: true, force: true })
  }
})
