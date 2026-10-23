import assert from 'node:assert/strict'
import test from 'node:test'
import * as plugin from '../src/index.js'

function fakeContext({ credential = 'sk-test' } = {}) {
  const registered = []
  const listeners = new Map()
  const ctx = {
    logger: { warn() {} },
    get(name) {
      if (name !== 'credentials') return undefined
      return {
        resolve: async () => (credential === null ? undefined : { value: credential, source: 'test' }),
      }
    },
    on(event, listener) {
      listeners.set(event, listener)
    },
    llm: {
      registerAdapter(providers, adapter) {
        const handle = () => {}
        handle.replace = () => {}
        registered.push({ providers, adapter, handle })
        return handle
      },
    },
  }
  return { ctx, registered, listeners }
}

test('plugin exposes the cordis contract and registers exactly one route', () => {
  assert.equal(plugin.name, 'llm-claude')
  assert.deepEqual(plugin.inject, ['llm'])
  assert.equal(typeof plugin.Config, 'function')
  assert.equal(typeof plugin.apply, 'function')

  const { ctx, registered } = fakeContext()
  const config = plugin.Config({ provider: 'claude-test', baseURL: 'http://127.0.0.1:9' })
  plugin.apply(ctx, config)
  assert.equal(registered.length, 1)
  assert.deepEqual(registered[0].providers, ['claude-test'])
  assert.equal(registered[0].adapter.providerInfo('claude-test').id, 'claude-test')
  assert.equal(registered[0].adapter.providerInfo('claude-test').name, 'claude-test')
})

test('invalid configuration fails at load time', () => {
  const { ctx } = fakeContext()
  assert.throws(
    () => plugin.apply(ctx, plugin.Config({ provider: 'claude-test', baseURL: 'https://user:pass@example.com' })),
    /must not embed credentials/,
  )
})

test('missing credentials surface as MISSING_CREDENTIAL', async () => {
  const { ctx, registered } = fakeContext({ credential: null })
  plugin.apply(ctx, plugin.Config({ provider: 'claude-test', baseURL: 'http://127.0.0.1:9' }))
  const adapter = registered[0].adapter
  const conn = {
    apiKeyEnv: 'MOCK_CLAUDE_KEY',
    authHeader: 'x-api-key',
    compat: { mode: 'auto', headers: {} },
    anthropicBeta: [],
  }
  await assert.rejects(
    adapter.dependencies.resolveAuth(conn),
    (error) => error.code === 'MISSING_CREDENTIAL' && !String(error.message).includes('sk-test'),
  )
})

test('resolved credentials are passed to pi-ai without leaking into config', async () => {
  const { ctx, registered } = fakeContext({ credential: 'sk-test' })
  plugin.apply(ctx, plugin.Config({ provider: 'claude-test', baseURL: 'http://127.0.0.1:9' }))
  const conn = { apiKeyEnv: 'MOCK_CLAUDE_KEY', authHeader: 'x-api-key', compat: { mode: 'auto', headers: {} }, anthropicBeta: [] }
  assert.deepEqual(await registered[0].adapter.dependencies.resolveAuth(conn), { apiKey: 'sk-test' })

  conn.authHeader = 'authorization-bearer'
  assert.deepEqual(await registered[0].adapter.dependencies.resolveAuth(conn), {
    headers: { authorization: 'Bearer sk-test' },
  })
})

test('models and reasoning metadata are advertised to the selection surfaces', async () => {
  const { ctx, registered } = fakeContext()
  plugin.apply(ctx, plugin.Config({ provider: 'claude-test', baseURL: 'http://127.0.0.1:9' }))
  const adapter = registered[0].adapter
  const models = await adapter.listModels('claude-test')
  assert.deepEqual(models.map((model) => model.id), ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'])
  const haiku = await adapter.resolveModel('claude-test', 'claude-haiku-5-5')
  assert.equal(haiku.context.contextWindow, 200000)
  assert.equal(haiku.defaultMaxTokens, 64000)
  assert.equal(haiku.reasoning, undefined)
  const sonnet = await adapter.resolveModel('claude-test', 'claude-sonnet-5-5')
  assert.ok(sonnet.reasoning.efforts.some((effort) => effort.id === 'high'))
  // Unlisted model ids still route (core routing, not the catalog, validates requests).
  const unlisted = await adapter.resolveModel('claude-test', 'claude-unlisted')
  assert.equal(unlisted.id, 'claude-unlisted')
  assert.equal(unlisted.context.contextWindow, 262144)
})
