import assert from 'node:assert/strict'
import test from 'node:test'
import * as plugin from '../src/index.js'
import { basicMessages, call, loopRequest, mount, mockServer, routeProfile, textBody } from './helpers.mjs'

function request(overrides = {}) {
  return loopRequest({
    provider: 'gateway',
    model: 'claude-haiku-5-5',
    messages: basicMessages('hi'),
    signal: AbortSignal.timeout(5000),
    ...overrides,
  })
}

/** The shape auto-review's classifyRisk builds. */
function reviewRequest(overrides = {}) {
  return {
    provider: 'gateway',
    model: 'claude-opus-5-5',
    system: 'REVIEW_POLICY\nYou are the final authorization reviewer for exactly one pending tool call.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'PENDING_ACTION {...}' }] }],
    temperature: 0,
    signal: AbortSignal.timeout(5000),
    ...overrides,
  }
}

test('plugin is an interceptor: no provider route is registered', () => {
  assert.equal(plugin.name, 'llm-claude')
  assert.deepEqual(plugin.inject, ['llm', 'loader'])
  assert.equal(typeof plugin.Config, 'function')
  assert.equal(typeof plugin.apply, 'function')

  const registered = []
  const ctx = {
    logger: {},
    on(event, listener) {
      registered.push({ event, listener })
    },
    get() {
      return undefined
    },
    loader: { entries: function* () {} },
  }
  plugin.apply(ctx, plugin.Config({}))
  assert.deepEqual(registered.map((entry) => entry.event), ['llm/stream'])
})

test('non-Claude models and non-Messages routes pass through untouched', async () => {
  const providers = {
    gateway: routeProfile('http://127.0.0.1:9'),
    other: { api: 'openai-completions', baseURL: 'http://127.0.0.1:9', apiKeyEnv: 'OTHER_KEY', models: [] },
  }
  const { handle } = mount({ providers })

  assert.equal((await call(handle, request({ model: 'deepseek-flash' }))).passedThrough, true)
  assert.equal((await call(handle, request({ model: 'gpt-5' }))).passedThrough, true)
  assert.equal(
    (await call(handle, request({ provider: 'other', model: 'claude-haiku-5-5' }))).passedThrough,
    true,
  )
  assert.equal(
    (await call(handle, request({ provider: 'unconfigured', model: 'claude-haiku-5-5' }))).passedThrough,
    true,
  )
})

test('filters, disabled flag and missing credentials all fall back to the owner', async () => {
  const providers = { gateway: routeProfile('http://127.0.0.1:9') }
  const excluded = mount({ providers, config: { excludeProviders: ['gateway'] } })
  assert.equal((await call(excluded.handle, request())).passedThrough, true)

  const notIncluded = mount({ providers, config: { includeProviders: ['other'] } })
  assert.equal((await call(notIncluded.handle, request())).passedThrough, true)

  const disabled = mount({ providers, config: { enabled: false } })
  assert.equal((await call(disabled.handle, request())).passedThrough, true)

  const missingCredential = mount({ providers, credential: null })
  assert.equal((await call(missingCredential.handle, request())).passedThrough, true)
})

test('matching requests reuse the existing route profile and credential', async () => {
  const server = await mockServer([textBody()])
  try {
    const providers = { gateway: routeProfile(server.baseURL) }
    const { handle } = mount({ providers, credential: 'sk-from-store' })

    const { passedThrough, chunks } = await call(handle, request())
    assert.equal(passedThrough, false)
    assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })

    const http = server.captured[0]
    assert.match(http.url, /^\/v1\/messages/)
    assert.equal(http.headers['user-agent'], 'claude-cli/2.1.293 (external, cli)')
    assert.equal(http.headers['x-app'], 'cli')
    assert.match(http.headers['x-dsh-attribution'], /^deepseek-harness\//)
    assert.equal(http.headers['x-api-key'], 'sk-from-store')
    assert.deepEqual(
      http.body.system.map((block) => block.text),
      [
        "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
        'You are an interactive agent that helps users with software engineering tasks.',
        'Harness prompt.',
      ],
    )
    const userId = JSON.parse(http.body.metadata.user_id)
    assert.deepEqual(userId, { device_id: 'device-test', account_uuid: '', session_id: '' })
  } finally {
    await server.close()
  }
})

test('reviewer calls are left to the dedicated reviewer-model plugin', async () => {
  const providers = { gateway: routeProfile('http://127.0.0.1:9') }
  const { handle, reroutes } = mount({ providers })
  const { passedThrough } = await call(handle, reviewRequest())
  assert.equal(passedThrough, true)
  assert.equal(reroutes.length, 0)
})

test('non-review internal calls still get the gateway disguise', async () => {
  const server = await mockServer([textBody({ text: 'A title' })])
  try {
    const { handle } = mount({ providers: { gateway: routeProfile(server.baseURL) } })
    // Session-title shape: fixed system string, no tools, a session id.
    await call(handle, {
      provider: 'gateway',
      model: 'claude-haiku-5-5',
      system: 'Create a concise title for this session.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      sessionId: 'session-1',
      signal: AbortSignal.timeout(5000),
    })
    const system = server.captured[0].body.system.map((block) => block.text)
    assert.equal(system[0], "You are a Claude agent, built on Anthropic's Claude Agent SDK.")
    assert.equal(system.at(-1), 'Create a concise title for this session.')
  } finally {
    await server.close()
  }
})

test('route headers are preserved and compat headers are merged over them', async () => {
  const server = await mockServer([textBody()])
  try {
    const providers = {
      gateway: routeProfile(server.baseURL, { headers: { 'x-route': 'yes', 'x-app': 'route' } }),
    }
    const { handle } = mount({ providers })
    await call(handle, request())
    const http = server.captured[0]
    assert.equal(http.headers['x-route'], 'yes')
    assert.equal(http.headers['x-app'], 'cli')
  } finally {
    await server.close()
  }
})
