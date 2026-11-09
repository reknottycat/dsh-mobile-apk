import { randomBytes } from 'node:crypto';

/** The generic Responses route is deliberately distinct from every OAuth route. */
export const CODEX_CUSTOM_ROUTE = 'codex-custom';
const SETTINGS_NS = 'llm-pi-ai';
const REF_PATTERN = /^SUBSCRIPTIONS_CODEX_CUSTOM_[A-F0-9]{32}_API_KEY$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Stable, secret-free messages are translated by the client, never raw storage errors. */
export class CodexCustomError extends Error {
    constructor(code) {
        super(code);
        this.name = 'CodexCustomError';
    }
}
const fail = code => { throw new CodexCustomError(code); };

export function normalizeCodexCustomBaseURL(value) {
    if (typeof value !== 'string' || value.length > 2048 || !/^https?:\/\//i.test(value.trim()))
        fail('CODEX_CUSTOM_INVALID_URL');
    let url;
    try { url = new URL(value.trim()); }
    catch { fail('CODEX_CUSTOM_INVALID_URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
        || url.search || url.hash || /[\u0000-\u0020\u007f]/.test(value.trim()))
        fail('CODEX_CUSTOM_INVALID_URL');
    // Users supply the API base, including any gateway prefix and /v1. The SDK
    // appends /responses; accepting a complete endpoint would duplicate it.
    const normalized = url.toString().replace(/\/+$/, '');
    if (/\/responses$/i.test(url.pathname.replace(/\/+$/, '')))
        fail('CODEX_CUSTOM_ENDPOINT_NOT_BASE');
    return normalized;
}

function readModel(value) {
    if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 256
        || /[\u0000-\u001f\u007f]/.test(value)) fail('CODEX_CUSTOM_INVALID_MODEL');
    return value.trim();
}

function ownedProfile(providers) {
    if (!record(providers) || !own(providers, CODEX_CUSTOM_ROUTE)) return undefined;
    const profile = providers[CODEX_CUSTOM_ROUTE];
    // Never adopt a pre-existing route or credential reference. In particular,
    // neither OPENAI_API_KEY nor an OAuth-scoped record can enter this path.
    if (!record(profile) || profile.api !== 'openai-responses'
        || typeof profile.apiKeyEnv !== 'string' || !REF_PATTERN.test(profile.apiKeyEnv))
        fail('CODEX_CUSTOM_ROUTE_CONFLICT');
    return profile;
}

function readDescriptor(settings) {
    let descriptor;
    try { descriptor = settings.describe({ redactSecrets: true }).find(row => row.ns === SETTINGS_NS); }
    catch { fail('CODEX_CUSTOM_UNAVAILABLE'); }
    if (!descriptor || !Number.isSafeInteger(descriptor.revision) || !record(descriptor.value))
        fail('CODEX_CUSTOM_UNAVAILABLE');
    return descriptor;
}

/**
 * Uses the host's live settings and private credential services. It never opens
 * subscription auth.json, resolves an existing secret, or reads a grant record.
 * A fresh reference per key change stages the secret before the revision-checked
 * settings commit; a failed commit cannot change the active endpoint/key pair.
 */
export function createCodexCustomService(resolveServices) {
    let pending = Promise.resolve();
    const services = () => {
        let resolved;
        try { resolved = resolveServices(); }
        catch { fail('CODEX_CUSTOM_UNAVAILABLE'); }
        if (!resolved?.settings?.describe || !resolved.settings.mutate
            || !resolved.credentials?.describe || !resolved.credentials.set || !resolved.credentials.unset)
            fail('CODEX_CUSTOM_UNAVAILABLE');
        return resolved;
    };
    const view = async (settings, credentials) => {
        const descriptor = readDescriptor(settings);
        const profile = ownedProfile(descriptor.value.providers);
        let keyConfigured = false;
        if (profile) {
            try { keyConfigured = (await credentials.describe(profile.apiKeyEnv)).configured === true; }
            catch { fail('CODEX_CUSTOM_UNAVAILABLE'); }
        }
        return {
            route: CODEX_CUSTOM_ROUTE,
            configured: profile !== undefined,
            baseURL: typeof profile?.baseURL === 'string' ? normalizeCodexCustomBaseURL(profile.baseURL) : '',
            model: typeof profile?.models?.[0]?.id === 'string' ? profile.models[0].id : '',
            keyConfigured,
            revision: descriptor.revision,
        };
    };
    const get = async () => {
        const { settings, credentials } = services();
        return view(settings, credentials);
    };
    const save = async input => {
        if (!record(input) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
            fail('CODEX_CUSTOM_INVALID_REVISION');
        const baseURL = normalizeCodexCustomBaseURL(input.baseURL);
        const model = readModel(input.model);
        if (input.apiKey !== undefined && typeof input.apiKey !== 'string') fail('CODEX_CUSTOM_INVALID_KEY');
        const apiKey = (input.apiKey ?? '').trim();
        if (apiKey.length > 8192 || /\s|[\u0000-\u001f\u007f]/.test(apiKey)) fail('CODEX_CUSTOM_INVALID_KEY');
        const { settings, credentials } = services();
        const descriptor = readDescriptor(settings);
        if (descriptor.revision !== input.expectedRevision) fail('CODEX_CUSTOM_SETTINGS_CHANGED');
        const previous = ownedProfile(descriptor.value.providers);
        const changedDestination = previous && normalizeCodexCustomBaseURL(previous.baseURL) !== baseURL;
        let ref = previous?.apiKeyEnv;
        if (!apiKey) {
            if (changedDestination) fail('CODEX_CUSTOM_NEW_URL_NEEDS_KEY');
            let configured = false;
            if (ref) {
                try { configured = (await credentials.describe(ref)).configured === true; }
                catch { fail('CODEX_CUSTOM_UNAVAILABLE'); }
            }
            if (!configured) fail('CODEX_CUSTOM_KEY_REQUIRED');
        }

        let stagedRef;
        if (apiKey) {
            // The random name is internal; clients cannot choose or redirect it.
            ref = `SUBSCRIPTIONS_CODEX_CUSTOM_${randomBytes(16).toString('hex').toUpperCase()}_API_KEY`;
            let info;
            try { info = await credentials.describe(ref); }
            catch { fail('CODEX_CUSTOM_KEY_STORE_FAILED'); }
            if (info.configured || info.writable !== true) fail('CODEX_CUSTOM_KEY_STORE_FAILED');
            stagedRef = ref;
            try { await credentials.set(ref, apiKey); }
            catch {
                await credentials.unset(ref).catch(() => {});
                fail('CODEX_CUSTOM_KEY_STORE_FAILED');
            }
        }
        const oldModel = previous?.models?.find(row => row?.id === model);
        const profile = {
            ...previous,
            displayName: previous?.displayName || 'Codex 自定义服务',
            api: 'openai-responses',
            baseURL,
            apiKeyEnv: ref,
            models: [{ ...oldModel, id: model }],
        };
        // Advanced settings may contain platform-specific auth headers. A new
        // destination starts with only the newly supplied API key.
        if (changedDestination) delete profile.headers;
        try {
            await settings.mutate(SETTINGS_NS, [{ op: 'set', path: ['providers', CODEX_CUSTOM_ROUTE], value: profile }], input.expectedRevision);
        }
        catch (error) {
            // A persistence adapter may commit before a later notification
            // throws. Read back before cleanup: removing an already-active key
            // would turn a successful commit into a broken route.
            let after;
            try { after = readDescriptor(settings); }
            catch { fail('CODEX_CUSTOM_SAVE_UNCERTAIN'); }
            const active = after.value.providers?.[CODEX_CUSTOM_ROUTE];
            const committed = active?.apiKeyEnv === ref && active?.baseURL === baseURL
                && active?.models?.[0]?.id === model;
            if (!committed) {
                // An unchanged readable revision proves this attempt did not
                // commit. For an advanced/unknown revision keep the private
                // staged ref so concurrent changes and snapshots remain valid.
                if (stagedRef && after.revision === descriptor.revision
                    && !Object.values(after.value.providers ?? {}).some(row => row?.apiKeyEnv === stagedRef))
                    await credentials.unset(stagedRef).catch(() => {});
                fail(error?.code === 'SETTINGS_CONFLICT' || after.revision !== descriptor.revision
                    ? 'CODEX_CUSTOM_SETTINGS_CHANGED' : 'CODEX_CUSTOM_SAVE_FAILED');
            }
        }
        // Retain the preceding private ref: older settings snapshots and custom
        // routes may still name it. Deleting it here would invalidate rollback.
        // No old key is read, returned, copied, or sent to a changed destination.
        // A read failure after commit must not masquerade as an unsaved draft.
        try { return { ...await view(settings, credentials), saved: true }; }
        catch {
            return { route: CODEX_CUSTOM_ROUTE, configured: true, baseURL, model, keyConfigured: true,
                revision: null, saved: true, refreshRequired: true };
        }
    };
    return {
        get,
        set(input) {
            const task = pending.then(() => save(input));
            pending = task.catch(() => {});
            return task;
        },
    };
}
