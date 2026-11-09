import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { createCodexCustomService } from '../lib/codex-custom.js';

// Use the repository's existing pinned UI test dependencies. No production
// dependency, browser bundle, or user credential is installed by this test.
const require = createRequire(new URL('../../../dsh-client-ui-responsive/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' });
// jsdom has no native dialog implementation. The unrelated subscription quota
// dialog closes on mount; emulate its standard open-state API only.
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
after(() => { dom.window.close(); delete globalThis.IS_REACT_ACT_ENVIRONMENT; });

async function mount({ failRead = false, ambiguousSave = false } = {}) {
    let revision = 0;
    const values = { providers: {} };
    const keys = new Map();
    const calls = [];
    const settings = {
        describe: () => [{ ns: 'llm-pi-ai', revision, value: structuredClone(values) }],
        async mutate(_ns, ops, expected) {
            if (expected !== revision) throw Object.assign(new Error('changed'), { code: 'SETTINGS_CONFLICT' });
            values.providers['codex-custom'] = structuredClone(ops[0].value);
            revision += 1;
        },
    };
    const credentials = {
        async describe(ref) { return { configured: keys.has(ref), writable: true }; },
        async set(ref, value) { keys.set(ref, value); },
        async unset(ref) { keys.delete(ref); },
    };
    const service = createCodexCustomService(() => ({ settings, credentials }));
    const flags = { failRead, ambiguousSave };
    const rpc = { async call(channel, method, payload) {
        calls.push({ channel, method, payload });
        assert.equal(channel, '/api');
        if (method === 'subscriptions-auth.status') return { ok: true, value: { providers: Object.fromEntries(['codex', 'claude', 'grok', 'copilot'].map(id => [id, { busy: false, accounts: [] }])) } };
        if (method === 'subscriptions-auth.proxyGet') return { ok: true, value: { enabled: false, url: '', passwordSet: false } };
        if (method === 'subscriptions-auth.codexCustomGet') {
            if (flags.failRead) throw new Error('transport failed with should-never-be-shown');
            return { ok: true, value: await service.get() };
        }
        if (method === 'subscriptions-auth.codexCustomSet') {
            let value;
            try { value = await service.set(payload); }
            catch (error) { return { ok: false, error: { message: error.message } }; }
            if (flags.ambiguousSave) throw new Error(`lost response with ${payload.apiKey}`);
            return { ok: true, value };
        }
        throw new Error(`Unexpected RPC ${method}`);
    } };
    let exported;
    let Section;
    let dictionaries;
    const disposers = [];
    dom.window.__ModuleLoader__ = { load({ factory }) { exported = factory(name => {
        if (['react', 'react-dom', 'react/jsx-runtime'].includes(name)) return require(name);
        if (name === '@deepseek-ai/dsh-client-ui-primitives') return {};
        throw new Error(`Unexpected browser dependency ${name}`);
    }); } };
    vm.runInNewContext(source, { window: dom.window, document: dom.window.document, console, setTimeout, clearTimeout, setInterval, clearInterval,
        navigator: dom.window.navigator, localStorage: dom.window.localStorage, AbortController, URL }, { filename: 'subscriptions-client.js' });
    const translate = (key, params = {}) => {
        let text = dictionaries.zh[key] ?? key;
        for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value));
        return text;
    };
    exported.apply({
        effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') disposers.push(cleanup); },
        locale: { register(_ns, value) { dictionaries = value; return () => {}; }, bind: () => translate },
        get: name => name === 'connection' ? { rpc } : undefined,
        slots: { inject(_name, callback) { callback(); }, register(seat, Component) { if (seat.name === 'settings.section' && seat.id === 'subscriptions') Section = Component; return () => {}; } },
        inject() {},
    });
    assert.equal(typeof Section, 'function', 'exercise the actual shipped settings slot');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(React.createElement(Section, { rpc, t: translate })); });
    const button = text => [...container.querySelectorAll('button')].find(node => node.textContent === text);
    const click = async node => { assert.ok(node, 'target button exists'); await act(async () => { node.click(); }); };
    const fill = async (name, value) => {
        const node = container.querySelector(`#codex-custom-${name}`);
        assert.ok(node, `field ${name} exists`);
        await act(async () => {
            Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(node, value);
            node.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        });
    };
    const submit = async () => { await act(async () => { container.querySelector('#codex-custom-config').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); }); };
    return { container, button, click, fill, submit, flags, values, keys, calls, advance() { revision += 1; },
        async close() { await act(async () => { root.unmount(); }); container.remove(); disposers.forEach(fn => fn()); } };
}

test('shipped custom component and locale bundle match their maintained source modules', () => {
    execFileSync(process.execPath, [new URL('../scripts/sync-codex-custom-client.mjs', import.meta.url).pathname, '--check'], { stdio: 'pipe' });
});

test('actual subscriptions bundle keeps login and saves three fields through the independent custom endpoints', async () => {
    const ui = await mount();
    try {
        const custom = ui.button('自定义服务');
        assert.ok(custom);
        assert.ok(custom.parentElement.textContent.includes('登录'), 'custom entry sits beside the existing login action');
        assert.equal([...ui.container.querySelectorAll('button')].filter(node => node.textContent === '登录').length, 4);
        await ui.click(custom);
        const form = ui.container.querySelector('#codex-custom-config');
        assert.equal(form.querySelectorAll('input').length, 3);
        assert.equal(form.querySelector('#codex-custom-apiKey').type, 'password');
        for (const input of form.querySelectorAll('input')) assert.ok(form.querySelector(`label[for="${input.id}"]`));
        await ui.fill('baseURL', 'https://relay.example/gateway/v1');
        await ui.fill('apiKey', 'form-private-key');
        await ui.fill('model', 'gateway/model-not-in-a-catalog');
        await ui.submit();
        const route = ui.values.providers['codex-custom'];
        assert.equal(route.baseURL, 'https://relay.example/gateway/v1');
        assert.deepEqual(route.models, [{ id: 'gateway/model-not-in-a-catalog' }]);
        assert.equal(route.api, 'openai-responses');
        assert.equal(ui.keys.get(route.apiKeyEnv), 'form-private-key');
        assert.equal(form.querySelector('#codex-custom-apiKey').value, '');
        assert.match(ui.container.textContent, /配置已保存/);
        assert.match(ui.container.textContent, /模型选择器/);
        assert.match(ui.container.textContent, /不代表地址已连通/);
        assert.equal(ui.container.textContent.includes('form-private-key'), false);
        assert.equal(ui.calls.some(call => /\.login|\.manual/.test(call.method)), false);
    } finally { await ui.close(); }
});

test('saved keys never reappear and a changed address requires a newly supplied key', async () => {
    const ui = await mount();
    try {
        await ui.click(ui.button('自定义服务'));
        await ui.fill('baseURL', 'https://one.example/v1');
        await ui.fill('apiKey', 'first-private-key');
        await ui.fill('model', 'known-model');
        await ui.submit();
        const firstRef = ui.values.providers['codex-custom'].apiKeyEnv;
        await ui.fill('model', 'known-model-two');
        await ui.submit();
        assert.equal(ui.values.providers['codex-custom'].apiKeyEnv, firstRef);
        await ui.fill('baseURL', 'https://two.example/api/v1');
        assert.equal(ui.container.querySelector('#codex-custom-apiKey').required, true);
        await ui.submit();
        assert.match(ui.container.querySelector('[role="alert"]').textContent, /地址已改变/);
        assert.equal(ui.values.providers['codex-custom'].baseURL, 'https://one.example/v1');
        await ui.fill('apiKey', 'second-private-key');
        await ui.submit();
        assert.equal(ui.values.providers['codex-custom'].baseURL, 'https://two.example/api/v1');
        assert.notEqual(ui.values.providers['codex-custom'].apiKeyEnv, firstRef);
        await ui.click(ui.button('重新读取已保存配置'));
        assert.equal(ui.container.querySelector('#codex-custom-apiKey').value, '');
        assert.equal(ui.container.innerHTML.includes('first-private-key'), false);
        assert.equal(ui.container.innerHTML.includes('second-private-key'), false);
    } finally { await ui.close(); }
});

test('unknown save result clears the key, hides raw errors and requires readback before retry', async () => {
    const ui = await mount({ ambiguousSave: true });
    try {
        await ui.click(ui.button('自定义服务'));
        await ui.fill('baseURL', 'http://127.0.0.1:39100/my-platform/v1');
        await ui.fill('apiKey', 'secret-in-transport-error');
        await ui.fill('model', 'local-model');
        await ui.submit();
        assert.match(ui.container.querySelector('[role="alert"]').textContent, /尚不能确认保存结果/);
        assert.equal(ui.container.querySelector('#codex-custom-apiKey').value, '');
        assert.equal(ui.container.innerHTML.includes('secret-in-transport-error'), false);
        assert.equal(ui.button('保存自定义服务').disabled, true);
        assert.ok(ui.values.providers['codex-custom'], 'the mock committed before losing its response');
        ui.flags.ambiguousSave = false;
        await ui.click(ui.button('重新读取已保存配置'));
        assert.equal(ui.button('保存自定义服务').disabled, false);
        assert.equal(ui.container.querySelector('#codex-custom-model').value, 'local-model');
        await ui.fill('model', 'next-model');
        await ui.submit();
        assert.equal(ui.values.providers['codex-custom'].models[0].id, 'next-model');
    } finally { await ui.close(); }
});

test('initial read failures and later settings conflicts have an explicit working readback path', async () => {
    const ui = await mount({ failRead: true });
    try {
        await ui.click(ui.button('自定义服务'));
        assert.match(ui.container.querySelector('[role="alert"]').textContent, /无法读取/);
        assert.equal(ui.button('保存自定义服务').disabled, true);
        assert.equal(ui.container.textContent.includes('should-never-be-shown'), false);
        ui.flags.failRead = false;
        await ui.click(ui.button('重新读取已保存配置'));
        await ui.fill('baseURL', 'https://relay.example/v1');
        await ui.fill('apiKey', 'conflicting-key');
        await ui.fill('model', 'draft-model');
        ui.advance();
        await ui.submit();
        assert.match(ui.container.querySelector('[role="alert"]').textContent, /其他页面发生变化/);
        assert.equal(ui.container.querySelector('#codex-custom-model').value, 'draft-model');
        assert.equal(ui.container.querySelector('#codex-custom-apiKey').value, '');
        assert.equal(ui.button('保存自定义服务').disabled, true);
        assert.equal(ui.values.providers['codex-custom'], undefined);
        await ui.click(ui.button('重新读取已保存配置'));
        assert.equal(ui.button('保存自定义服务').disabled, false);
    } finally { await ui.close(); }
});
