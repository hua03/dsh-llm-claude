import assert from 'node:assert/strict'
import test from 'node:test'
import { Config, DEFAULT_MODELS, plainOptions, resolveAdapterOptions } from '../src/config.js'

function resolve(overrides = {}) {
  return resolveAdapterOptions({ provider: 'claude-test', ...overrides })
}

test('schema applies documented defaults', () => {
  const config = Config({ provider: 'claude-test' })
  const plain = plainOptions(config)
  assert.equal(plain.baseURL, 'https://api.anthropic.com')
  assert.equal(plain.apiKeyEnv, 'ANTHROPIC_API_KEY')
  assert.equal(plain.auth.header, 'x-api-key')
  assert.equal(plain.claudeCodeCompat.mode, 'auto')
  assert.equal(plain.claudeCodeCompat.toolSchema, 'names-only')
  assert.equal(plain.reasoningEffort, 'high')
  assert.equal(plain.cacheRetention, 'short')
  assert.equal(plain.models.length, DEFAULT_MODELS.length)
  const resolved = resolveAdapterOptions(plain)
  assert.equal(resolved.provider, 'claude-test')
  assert.equal(resolved.compat.userAgent, 'claude-cli/2.1.293 (external, cli)')
  assert.equal(resolved.models.length, 3)
  assert.equal(resolved.modelsById.get('claude-haiku-5-5').reasoning, false)
  assert.equal(resolved.modelsById.get('claude-opus-5-5').reasoning, 'adaptive')
  assert.equal(resolved.modelsById.get('claude-opus-5-5').supportsTemperature, false)
  assert.equal(resolved.retryPolicy.maxRetries, 5)
})

test('baseURL must be a credential-free http(s) URL', () => {
  assert.throws(() => resolve({ baseURL: 'ftp://example.com' }), /must be http\(s\)/)
  assert.throws(() => resolve({ baseURL: 'https://user:pass@example.com' }), /must not embed credentials/)
  assert.throws(() => resolve({ baseURL: 'https://example.com/?x=1' }), /must not carry a query/)
  assert.equal(resolve({ baseURL: 'https://gateway.example.com/api' }).baseURL, 'https://gateway.example.com/api')
})

test('provider and models are validated', () => {
  assert.throws(() => resolveAdapterOptions({}), /provider must be a non-empty route key/)
  assert.throws(
    () => resolve({ models: [{ id: 'claude-a' }, { id: 'claude-a' }] }),
    /lists model "claude-a" twice/,
  )
  assert.throws(
    () =>
      resolve({
        models: [{ id: 'gpt-x' }],
        claudeCodeCompat: { mode: 'auto' },
      }),
    /no model id starts with "claude-"/,
  )
  // compat off allows a non-Claude catalog on the same adapter.
  assert.equal(
    resolve({ models: [{ id: 'gpt-x' }], claudeCodeCompat: { mode: 'off' } }).models[0].id,
    'gpt-x',
  )
})

test('reasoning and compat enums are validated', () => {
  assert.throws(() => resolve({ reasoningEffort: 'turbo' }), /reasoningEffort must be one of/)
  assert.throws(
    () => resolve({ claudeCodeCompat: { mode: 'auto', toolSchema: 'weird' } }),
    /toolSchema must be names-only or claude-code/,
  )
  assert.throws(() => resolve({ claudeCodeCompat: { mode: 'auto', headers: { 'bad header': 'x' } } }), /not a single-line/)
  assert.equal(resolve({ thinking: { mode: 'off' } }).thinkingMode, 'off')
})

test('apiKeyEnv must be a credential reference', () => {
  assert.throws(() => resolve({ apiKeyEnv: 'not a ref' }))
})
