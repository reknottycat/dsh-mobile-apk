/** Keep chat-model capability declarations from both pi-ai catalog layouts. */
export function modelCapabilities(catalogs) {
  const models = {}
  for (const [providerId, catalog] of catalogs) {
    for (const [api, group] of Object.entries(catalog)) {
      if (!group || typeof group !== 'object' || Array.isArray(group)) continue
      for (const [catalogKey, raw] of Object.entries(group)) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
        // pi-ai 1.x keys are typed, e.g. chat:gpt-4; raw.id is the public model id.
        // Classifiers, embeddings and image generators are not chat model candidates.
        if (raw.type !== undefined && raw.type !== 'chat') continue
        const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : catalogKey
        const entry = { provider: typeof raw.provider === 'string' ? raw.provider : providerId }
        if (typeof (raw.api ?? api) === 'string') entry.api = raw.api ?? api
        if (typeof raw.reasoning === 'boolean') entry.reasoning = raw.reasoning
        if (raw.thinkingLevelMap && typeof raw.thinkingLevelMap === 'object') entry.thinkingLevelMap = raw.thinkingLevelMap
        if (Array.isArray(raw.input)) entry.input = raw.input.filter(value => typeof value === 'string')
        if (typeof raw.contextWindow === 'number') entry.contextWindow = raw.contextWindow
        if (typeof raw.maxTokens === 'number') entry.maxTokens = raw.maxTokens
        if (raw.compat && typeof raw.compat === 'object') {
          const compat = {}
          for (const key of ['thinkingFormat', 'supportsReasoningEffort', 'supportsReasoning', 'maxTokensField']) {
            if (raw.compat[key] !== undefined) compat[key] = raw.compat[key]
          }
          if (Object.keys(compat).length > 0) entry.compat = compat
        }
        const entries = models[id] ??= []
        const duplicate = entries.findIndex(value => value.provider === entry.provider && value.api === entry.api)
        if (duplicate >= 0) entries[duplicate] = entry
        else entries.push(entry)
      }
    }
  }
  for (const entries of Object.values(models)) entries.sort((a, b) => a.provider.localeCompare(b.provider))
  return models
}
