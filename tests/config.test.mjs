import assert from 'node:assert/strict'
import test from 'node:test'
import { Config, plainOptions, resolveInterceptOptions } from '../src/config.js'

function resolve(overrides = {}) {
  return resolveInterceptOptions(plainOptions(Config(overrides)))
}

test('schema defaults describe a no-op-safe interceptor', () => {
  const plain = plainOptions(Config({}))
  assert.equal(plain.enabled, true)
  assert.deepEqual(plain.includeProviders, [])
  assert.deepEqual(plain.excludeProviders, [])
  assert.equal(plain.claudeCodeCompat.identityBlocks, true)
  assert.equal(plain.claudeCodeCompat.userAgent, 'claude-cli/2.1.293 (external, cli)')
  assert.deepEqual(plain.claudeCodeCompat.headers, { 'x-app': 'cli' })
  assert.equal(plain.claudeCodeCompat.toolSchema, 'names-only')
  assert.equal(plain.claudeCodeCompat.thinking, 'auto')
  assert.equal(plain.maxRequestImagesBytes, 20971520)
  assert.equal(plain.debug, false)

  const resolved = resolve({})
  assert.equal(resolved.enabled, true)
  assert.equal(resolved.compat.mode, 'auto')
  assert.equal(resolved.compat.thinkingMode, 'auto')
  // No endpoint/credential/model fields exist: those come from the route.
  assert.equal('baseURL' in resolved, false)
  assert.equal('apiKeyEnv' in resolved, false)
})

test('enums and header values are validated', () => {
  assert.throws(
    () => resolve({ claudeCodeCompat: { toolSchema: 'weird' } }),
    /toolSchema/,
  )
  assert.throws(() => resolve({ claudeCodeCompat: { thinking: 'always' } }), /thinking/)
  assert.throws(() => resolve({ claudeCodeCompat: { userAgent: '' } }), /userAgent must not be empty/)
  assert.throws(
    () => resolve({ claudeCodeCompat: { headers: { 'bad header': 'x' } } }),
    /not a single-line/,
  )
})

test('provider filters and image budget are validated', () => {
  assert.throws(() => resolve({ includeProviders: [''] }), /non-empty route keys/)
  assert.throws(() => resolve({ maxRequestImagesBytes: 0 }), /maxRequestImagesBytes/)
  assert.deepEqual(resolve({ includeProviders: ['gateway'], excludeProviders: ['other'] }).includeProviders, [
    'gateway',
  ])
  assert.equal(resolve({ enabled: false }).enabled, false)
})
