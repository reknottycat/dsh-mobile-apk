import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CODEX_CUSTOM_ROUTE, createCodexCustomService, normalizeCodexCustomBaseURL } from '../lib/codex-custom.js';

const input = { baseURL: 'https://relay.example/gateway/v1/', model: 'platform/arbitrary-model', apiKey: 'custom-test-key', expectedRevision: 0 };
const oldRef = `SUBSCRIPTIONS_CODEX_CUSTOM_${'A'.repeat(32)}_API_KEY`;
const owned = () => ({ api: 'openai-responses', baseURL: 'https://old.example/v1', apiKeyEnv: oldRef,
    displayName: 'My custom route', models: [{ id: 'old-model', contextWindow: 32768 }], timeoutMs: 12345 });
function setup({ profile, revision = 0 } = {}) {
    const originalProviders = { 'openai-codex': { api: 'openai-codex-responses' },
        'my-other-route': { api: 'openai-responses', apiKeyEnv: 'OTHER_USER_KEY', models: [{ id: 'other' }] },
        ...profile ? { [CODEX_CUSTOM_ROUTE]: structuredClone(profile) } : {} };
    let values = { providers: structuredClone(originalProviders), streamIdleTimeoutMs: 60000 };
    const refs = new Map([[oldRef, 'old-custom-secret'], ['OTHER_USER_KEY', 'other-user-secret']]);
    const calls = [];
    const settings = {
        describe(options) { assert.equal(options.redactSecrets, true); return [{ ns: 'llm-pi-ai', revision, value: structuredClone(values) }]; },
        async mutate(ns, ops, expected) {
            assert.equal(ns, 'llm-pi-ai');
            if (expected !== revision) throw Object.assign(new Error('concurrent edit'), { code: 'SETTINGS_CONFLICT' });
            assert.equal(ops.length, 1);
            assert.deepEqual(ops[0].path, ['providers', CODEX_CUSTOM_ROUTE]);
            values.providers[CODEX_CUSTOM_ROUTE] = structuredClone(ops[0].value);
            revision += 1;
        },
    };
    const credentials = {
        async describe(ref) { calls.push(['describe', ref]); return { configured: refs.has(ref), writable: true }; },
        async set(ref, value) { calls.push(['set', ref]); refs.set(ref, value); },
        async unset(ref) { calls.push(['unset', ref]); refs.delete(ref); },
        async resolve() { assert.fail('The configuration helper must never read an existing key'); },
        async readRecord() { assert.fail('Official OAuth records are out of scope'); },
        async modifyRecord() { assert.fail('Official OAuth records are out of scope'); },
    };
    return { settings, credentials, refs, calls, originalProviders,
        service: createCodexCustomService(() => ({ settings, credentials })),
        get value() { return values; }, get revision() { return revision; }, advance() { revision += 1; } };
}
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.message === code);

test('fresh save produces a generic Responses route and only an independent private key reference', async () => {
    const env = setup();
    assert.deepEqual(await env.service.get(), { route: CODEX_CUSTOM_ROUTE, configured: false, baseURL: '', model: '', keyConfigured: false, revision: 0 });
    const result = await env.service.set(input);
    const route = env.value.providers[CODEX_CUSTOM_ROUTE];
    assert.equal(route.api, 'openai-responses');
    assert.equal(route.baseURL, 'https://relay.example/gateway/v1');
    assert.deepEqual(route.models, [{ id: input.model }]);
    assert.match(route.apiKeyEnv, /^SUBSCRIPTIONS_CODEX_CUSTOM_[A-F0-9]{32}_API_KEY$/);
    assert.equal(env.refs.get(route.apiKeyEnv), input.apiKey);
    assert.deepEqual(env.value.providers['openai-codex'], env.originalProviders['openai-codex']);
    assert.deepEqual(env.value.providers['my-other-route'], env.originalProviders['my-other-route']);
    assert.equal(env.value.streamIdleTimeoutMs, 60000);
    assert.equal(result.saved, true);
    assert.equal(result.revision, 1);
    for (const secret of [input.apiKey, route.apiKeyEnv, 'old-custom-secret', 'other-user-secret'])
        assert.equal(JSON.stringify(result).includes(secret), false);
});

test('initial blank key cannot fall back to OAuth or an ambient OpenAI key', async () => {
    const env = setup();
    await rejectsCode(env.service.set({ ...input, apiKey: '' }), 'CODEX_CUSTOM_KEY_REQUIRED');
    assert.equal(env.revision, 0);
    assert.equal(env.calls.some(([operation]) => operation === 'set'), false);
});

test('same-address blank key preserves its reference and user advanced settings without reading the key', async () => {
    const env = setup({ profile: owned() });
    await env.service.set({ baseURL: 'https://old.example/v1/', model: 'old-model', expectedRevision: 0 });
    const route = env.value.providers[CODEX_CUSTOM_ROUTE];
    assert.equal(route.apiKeyEnv, oldRef);
    assert.equal(route.displayName, 'My custom route');
    assert.equal(route.timeoutMs, 12345);
    assert.deepEqual(route.models, [{ id: 'old-model', contextWindow: 32768 }]);
    assert.equal(env.calls.some(([operation]) => operation === 'set'), false);
});

test('changing the destination requires a new key and removes previous custom headers', async () => {
    const env = setup({ profile: { ...owned(), headers: { Authorization: 'Bearer old-header-secret', 'x-private-key': 'old-header-secret' } } });
    await rejectsCode(env.service.set({ ...input, apiKey: '' }), 'CODEX_CUSTOM_NEW_URL_NEEDS_KEY');
    assert.equal(env.revision, 0);
    await env.service.set(input);
    const route = env.value.providers[CODEX_CUSTOM_ROUTE];
    assert.notEqual(route.apiKeyEnv, oldRef);
    assert.equal(route.headers, undefined);
    assert.equal(route.timeoutMs, 12345);
    assert.equal(env.refs.get(oldRef), 'old-custom-secret', 'settings snapshots can still restore the preceding private ref');
});

test('same destination preserves advanced custom headers', async () => {
    const headers = { 'x-platform-tenant': 'tenant-1' };
    const env = setup({ profile: { ...owned(), headers } });
    await env.service.set({ ...input, baseURL: owned().baseURL });
    assert.deepEqual(env.value.providers[CODEX_CUSTOM_ROUTE].headers, headers);
});

test('missing previously configured key requires explicit input and never resolves another credential', async () => {
    const env = setup({ profile: owned() });
    env.refs.delete(oldRef);
    assert.equal((await env.service.get()).keyConfigured, false);
    await rejectsCode(env.service.set({ ...input, baseURL: owned().baseURL, apiKey: '' }), 'CODEX_CUSTOM_KEY_REQUIRED');
});

test('API base validation preserves gateway prefixes and rejects embedded credentials, query, fragment and full endpoints', () => {
    assert.equal(normalizeCodexCustomBaseURL(' http://127.0.0.1:3081/my-platform/v1/// '), 'http://127.0.0.1:3081/my-platform/v1');
    assert.equal(normalizeCodexCustomBaseURL('https://relay.example/custom%20prefix/v1'), 'https://relay.example/custom%20prefix/v1');
    for (const url of ['file:///etc/passwd', 'relay.example/v1', 'https://u:secret@example.com/v1', 'https://relay.example/v1?api_key=secret',
        'https://relay.example/v1#token', 'https://relay.example/\nprivate', 'https://relay.example/v1/responses/'])
        assert.throws(() => normalizeCodexCustomBaseURL(url), error => /^CODEX_CUSTOM_/.test(error.message) && !error.message.includes('secret'));
});

test('invalid inputs are refused before any credential write', async () => {
    for (const patch of [{ expectedRevision: -1 }, { expectedRevision: '0' }, { model: '' }, { model: 'line\nmodel' },
        { model: 'x'.repeat(257) }, { apiKey: null }, { apiKey: 'has space' }, { apiKey: 'a\rb' }, { apiKey: 'x'.repeat(8193) }]) {
        const env = setup();
        await assert.rejects(env.service.set({ ...input, ...patch }));
        assert.equal(env.calls.some(([operation]) => operation === 'set'), false);
    }
});

test('foreign codex-custom routes and OAuth references are never adopted or overwritten', async () => {
    for (const profile of [{ ...owned(), apiKeyEnv: 'OPENAI_API_KEY' }, { ...owned(), apiKeyEnv: 'llm-pi-ai/openai-codex' },
        { ...owned(), api: 'openai-codex-responses' }]) {
        const env = setup({ profile });
        await rejectsCode(env.service.get(), 'CODEX_CUSTOM_ROUTE_CONFLICT');
        await rejectsCode(env.service.set(input), 'CODEX_CUSTOM_ROUTE_CONFLICT');
        assert.equal(env.revision, 0);
        assert.equal(env.calls.length, 0);
    }
});

test('stale revisions and concurrent saves do not overwrite the current route', async () => {
    const env = setup();
    const first = env.service.set(input);
    const second = env.service.set({ ...input, model: 'second', apiKey: 'second-key' });
    await first;
    await rejectsCode(second, 'CODEX_CUSTOM_SETTINGS_CHANGED');
    assert.equal(env.value.providers[CODEX_CUSTOM_ROUTE].models[0].id, input.model);
    assert.equal(env.calls.filter(([operation]) => operation === 'set').length, 1);
});

test('credential storage errors expose no key or raw provider error and do not change settings', async () => {
    const env = setup({ profile: owned() });
    env.credentials.set = async (ref, value) => { env.refs.set(ref, value); throw new Error(`disk error with ${value}`); };
    await rejectsCode(env.service.set(input), 'CODEX_CUSTOM_KEY_STORE_FAILED');
    assert.equal(env.revision, 0);
    assert.deepEqual(env.value.providers[CODEX_CUSTOM_ROUTE], owned());
    assert.equal([...env.refs.values()].includes(input.apiKey), false);
});

test('a proved pre-commit settings failure cleans only the staged key and permits retry', async () => {
    const env = setup({ profile: owned() });
    const mutate = env.settings.mutate;
    env.settings.mutate = async () => { throw new Error('failure with secret-never-exposed'); };
    await rejectsCode(env.service.set(input), 'CODEX_CUSTOM_SAVE_FAILED');
    assert.equal(env.refs.size, 2);
    assert.deepEqual(env.value.providers[CODEX_CUSTOM_ROUTE], owned());
    env.settings.mutate = mutate;
    assert.equal((await env.service.set(input)).saved, true);
});

test('an exception after the actual commit is read back as success and never deletes the active key', async () => {
    const env = setup();
    const mutate = env.settings.mutate;
    env.settings.mutate = async (...args) => { await mutate(...args); throw new Error('notification failed'); };
    const result = await env.service.set(input);
    assert.equal(result.saved, true);
    assert.equal(env.refs.get(env.value.providers[CODEX_CUSTOM_ROUTE].apiKeyEnv), input.apiKey);
    assert.equal(env.calls.some(([operation]) => operation === 'unset'), false);
});

test('an unknown commit outcome retains the staged key and can be resolved by a later read', async () => {
    const env = setup();
    const mutate = env.settings.mutate;
    const describe = env.settings.describe;
    env.settings.mutate = async (...args) => { await mutate(...args); env.settings.describe = () => { throw new Error('temporarily unavailable'); }; throw new Error(input.apiKey); };
    await rejectsCode(env.service.set(input), 'CODEX_CUSTOM_SAVE_UNCERTAIN');
    assert.equal(env.refs.get(env.value.providers[CODEX_CUSTOM_ROUTE].apiKeyEnv), input.apiKey);
    assert.equal(env.calls.some(([operation]) => operation === 'unset'), false);
    env.settings.describe = describe;
    const result = await env.service.get();
    assert.equal(result.revision, 1);
    assert.equal(result.keyConfigured, true);
    assert.equal(JSON.stringify(result).includes(input.apiKey), false);
});

test('successful commit plus failed view refresh stays a success with an explicit reload requirement', async () => {
    const env = setup();
    const mutate = env.settings.mutate;
    env.settings.mutate = async (...args) => { await mutate(...args); env.settings.describe = () => { throw new Error('view unavailable'); }; };
    const result = await env.service.set(input);
    assert.equal(result.saved, true);
    assert.equal(result.refreshRequired, true);
    assert.equal(result.revision, null);
    assert.equal(env.refs.get(env.value.providers[CODEX_CUSTOM_ROUTE].apiKeyEnv), input.apiKey);
});

test('a competing settings edit between staging and commit is refused without deleting either active key', async () => {
    const env = setup({ profile: owned() });
    const set = env.credentials.set;
    env.credentials.set = async (...args) => { await set(...args); env.advance(); };
    await rejectsCode(env.service.set(input), 'CODEX_CUSTOM_SETTINGS_CHANGED');
    assert.deepEqual(env.value.providers[CODEX_CUSTOM_ROUTE], owned());
    assert.equal(env.refs.get(oldRef), 'old-custom-secret');
    assert.equal(env.calls.some(([operation]) => operation === 'unset'), false);
});

test('missing live settings services fail closed with a safe status', async () => {
    const service = createCodexCustomService(() => ({}));
    await rejectsCode(service.get(), 'CODEX_CUSTOM_UNAVAILABLE');
    await rejectsCode(service.set(input), 'CODEX_CUSTOM_UNAVAILABLE');
});
