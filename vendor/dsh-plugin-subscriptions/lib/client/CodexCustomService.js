import { jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime';
import { useEffect, useRef, useState } from 'react';
import { callSubscriptionsAuth } from './subscriptions-rpc.js';

const codexCustomErrorKeys = {
    CODEX_CUSTOM_INVALID_URL: 'codexCustomInvalidUrl',
    CODEX_CUSTOM_ENDPOINT_NOT_BASE: 'codexCustomEndpointNotBase',
    CODEX_CUSTOM_INVALID_MODEL: 'codexCustomInvalidModel',
    CODEX_CUSTOM_INVALID_KEY: 'codexCustomInvalidKey',
    CODEX_CUSTOM_INVALID_REVISION: 'codexCustomReloadRequired',
    CODEX_CUSTOM_SETTINGS_CHANGED: 'codexCustomSettingsChanged',
    CODEX_CUSTOM_ROUTE_CONFLICT: 'codexCustomRouteConflict',
    CODEX_CUSTOM_UNAVAILABLE: 'codexCustomUnavailable',
    CODEX_CUSTOM_KEY_REQUIRED: 'codexCustomKeyRequired',
    CODEX_CUSTOM_NEW_URL_NEEDS_KEY: 'codexCustomNewUrlNeedsKey',
    CODEX_CUSTOM_KEY_STORE_FAILED: 'codexCustomKeyStoreFailed',
    CODEX_CUSTOM_SAVE_FAILED: 'codexCustomSaveFailed',
    CODEX_CUSTOM_SAVE_UNCERTAIN: 'codexCustomSaveUncertain',
};
const codexCustomStyles = {
    form: { display: 'flex', flexDirection: 'column', gap: 12, width: '100%', minWidth: 0,
        boxSizing: 'border-box', paddingTop: 14, marginTop: 12,
        borderTop: '1px solid var(--dsw-alias-border-main)' },
    title: { margin: 0, fontSize: 14, fontWeight: 600 },
    field: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, fontSize: 13 },
    input: { width: '100%', minWidth: 0, minHeight: 40, boxSizing: 'border-box', fontSize: 14 },
    hint: { margin: 0, fontSize: 12, lineHeight: '1.6', color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' },
    actions: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
    message: { margin: 0, fontSize: 13, lineHeight: '1.6', overflowWrap: 'anywhere' },
};

/** Inline, independent API-key form on the Codex card; no login action is invoked. */
export function CodexCustomService({ rpc, t }) {
    const [draft, setDraft] = useState({ baseURL: '', apiKey: '', model: '' });
    const [saved, setSaved] = useState();
    const [busy, setBusy] = useState('loading');
    const [message, setMessage] = useState();
    const mounted = useRef(false);
    const request = useRef(0);
    const showError = (error, fallback = 'codexCustomSaveUncertain') => ({ tone: 'error', key: codexCustomErrorKeys[error?.message] ?? fallback });
    const load = async () => {
        const attempt = ++request.current;
        setBusy('loading');
        setMessage(undefined);
        try {
            const value = await callSubscriptionsAuth(rpc, 'codexCustomGet', {});
            if (!mounted.current || attempt !== request.current) return;
            setSaved(value);
            setDraft({ baseURL: value.baseURL, model: value.model, apiKey: '' });
        }
        catch (error) {
            if (!mounted.current || attempt !== request.current) return;
            setSaved(undefined);
            setMessage(showError(error, 'codexCustomUnavailable'));
        }
        finally {
            if (mounted.current && attempt === request.current) setBusy(undefined);
        }
    };
    useEffect(() => {
        mounted.current = true;
        void load();
        return () => { mounted.current = false; request.current += 1; };
    }, [rpc]);
    const edit = (key, value) => {
        setDraft(previous => ({ ...previous, [key]: value }));
        setMessage(undefined);
    };
    const submit = async event => {
        event.preventDefault();
        if (busy || !Number.isSafeInteger(saved?.revision)) return;
        const attempt = ++request.current;
        setBusy('saving');
        setMessage(undefined);
        try {
            const value = await callSubscriptionsAuth(rpc, 'codexCustomSet', {
                baseURL: draft.baseURL, model: draft.model, apiKey: draft.apiKey,
                expectedRevision: saved.revision,
            });
            if (!mounted.current || attempt !== request.current) return;
            setSaved(value);
            setDraft({ baseURL: value.baseURL, model: value.model, apiKey: '' });
            setMessage({ tone: 'success', key: value.refreshRequired ? 'codexCustomSavedReload' : 'codexCustomSaved' });
        }
        catch (error) {
            if (!mounted.current || attempt !== request.current) return;
            const feedback = showError(error);
            setMessage(feedback);
            // Conflicts and unknown transport outcomes require an explicit read
            // before retry. Never resend a previous draft to an unknown target.
            if (['codexCustomSettingsChanged', 'codexCustomSaveUncertain', 'codexCustomUnavailable'].includes(feedback.key))
                setSaved(previous => previous ? { ...previous, revision: null } : undefined);
        }
        finally {
            if (mounted.current && attempt === request.current) {
                // API keys are write-only and leave component state after every
                // submission, including errors and interrupted network results.
                setDraft(previous => ({ ...previous, apiKey: '' }));
                setBusy(undefined);
            }
        }
    };
    const destinationChanged = saved?.configured && draft.baseURL.trim().replace(/\/+$/, '') !== saved.baseURL;
    const keyRequired = !saved?.keyConfigured || destinationChanged;
    const field = (key, label, type, hint, placeholder) => _jsxs('label', {
        style: codexCustomStyles.field,
        htmlFor: `codex-custom-${key}`,
        children: [
            _jsx('span', { children: t(label) }),
            _jsx('input', { id: `codex-custom-${key}`, name: `codex-custom-${key}`, type,
                value: draft[key], style: codexCustomStyles.input, disabled: !!busy,
                required: key === 'apiKey' ? keyRequired : true,
                maxLength: key === 'apiKey' ? 8192 : key === 'baseURL' ? 2048 : 256,
                autoComplete: key === 'apiKey' ? 'new-password' : 'off', spellCheck: false,
                autoCapitalize: 'none', placeholder: t(placeholder),
                onChange: event => edit(key, event.target.value),
                'aria-describedby': `codex-custom-${key}-hint` }),
            _jsx('span', { id: `codex-custom-${key}-hint`, style: codexCustomStyles.hint, children: t(hint) }),
        ],
    });
    return _jsxs('form', { id: 'codex-custom-config', 'aria-label': t('codexCustomTitle'),
        onSubmit: submit, style: codexCustomStyles.form, children: [
            _jsx('h4', { style: codexCustomStyles.title, children: t('codexCustomTitle') }),
            _jsx('p', { style: codexCustomStyles.hint, children: t('codexCustomIntro') }),
            field('baseURL', 'codexCustomBaseUrl', 'url', 'codexCustomBaseUrlHint', 'codexCustomBaseUrlPlaceholder'),
            field('apiKey', 'codexCustomApiKey', 'password', destinationChanged ? 'codexCustomNewUrlNeedsKey' : 'codexCustomKeyHint',
                saved?.keyConfigured && !destinationChanged ? 'codexCustomKeySaved' : 'codexCustomKeyPlaceholder'),
            field('model', 'codexCustomModel', 'text', 'codexCustomModelHint', 'codexCustomModelPlaceholder'),
            message && _jsx('p', { role: message.tone === 'error' ? 'alert' : 'status',
                style: { ...codexCustomStyles.message, color: message.tone === 'error'
                    ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)' },
                children: t(message.key) }),
            _jsxs('div', { style: codexCustomStyles.actions, children: [
                _jsx('button', { type: 'submit', className: 'dsh-subscription-primary',
                    disabled: !!busy || !Number.isSafeInteger(saved?.revision),
                    children: t(busy === 'saving' ? 'codexCustomSaving' : 'codexCustomSave') }),
                _jsx('button', { type: 'button', disabled: !!busy, onClick: () => { void load(); },
                    children: t(busy === 'loading' ? 'codexCustomLoading' : 'codexCustomReload') }),
            ] }),
            _jsx('p', { style: codexCustomStyles.hint, children: t('codexCustomSelectionHint') }),
        ] });
}
