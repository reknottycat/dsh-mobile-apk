import assert from 'node:assert/strict'
import test from 'node:test'
import { modelCapabilities } from './lib/model-catalog.mjs'

test('legacy catalog ids and declared capabilities survive unchanged', () => {
  const result = modelCapabilities([['legacy', { completion: {
    'model-a': { reasoning: true, thinkingLevelMap: { low: 'low' }, contextWindow: 2000,
      compat: { thinkingFormat: 'openai', supportsReasoningEffort: true, unrelated: 'omit' } },
  } }]])
  assert.deepEqual(result['model-a'], [{ provider: 'legacy', api: 'completion', reasoning: true,
    thinkingLevelMap: { low: 'low' }, contextWindow: 2000,
    compat: { thinkingFormat: 'openai', supportsReasoningEffort: true } }])
})

test('pi-ai 1.3 typed keys use the public id and exclude non-chat variants', () => {
  const result = modelCapabilities([['provider', { responses: {
    'chat:model-a': { id: 'model-a', type: 'chat', input: ['text', 'image'], maxTokens: 4096 },
    'classifier:model-a': { id: 'model-a', type: 'classifier', contextWindow: 99 },
    'embedding:model-b': { id: 'model-b', type: 'embedding' },
  } }]])
  assert.deepEqual(Object.keys(result), ['model-a'])
  assert.deepEqual(result['model-a'], [{ provider: 'provider', api: 'responses', input: ['text', 'image'], maxTokens: 4096 }])
  assert.equal(result['chat:model-a'], undefined)
})

test('provider declarations remain separate while duplicate provider/api uses the last declaration', () => {
  const result = modelCapabilities([
    ['z', { completion: { a: { id: 'shared', maxTokens: 1 }, b: { id: 'shared', maxTokens: 2 } } }],
    ['a', { completion: { shared: { maxTokens: 3 } } }],
  ])
  assert.deepEqual(result.shared.map(value => [value.provider, value.maxTokens]), [['a', 3], ['z', 2]])
})
