import assert from 'node:assert/strict'
import test from 'node:test'
import * as plugin from '../src/index.js'
import { basicMessages, call, loopRequest, mount, mockServer, routeProfile, textBody, toolBody } from './helpers.mjs'

function request(overrides = {}) {
  return loopRequest({
    provider: 'gateway',
    model: 'claude-haiku-5-5',
    messages: basicMessages('hi'),
    signal: AbortSignal.timeout(5000),
    ...overrides,
  })
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
  // Route that DSH does not describe (no loader entry) is left alone.
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
  const server = await mockServer([toolBody(), textBody({ text: 'listed' })])
  try {
    const providers = { gateway: routeProfile(server.baseURL) }
    const { handle, ctx } = mount({ providers, credential: 'sk-from-store' })

    const first = await call(handle, request())
    assert.equal(first.passedThrough, false)
    const toolEnd = first.chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    assert.equal(toolEnd.block.name, 'bash')

    const http = server.captured[0]
    assert.match(http.url, /^\/v1\/messages/)
    assert.equal(http.headers['user-agent'], 'claude-cli/2.1.293 (external, cli)')
    assert.equal(http.headers['x-app'], 'cli')
    assert.match(http.headers['x-dsh-attribution'], /^deepseek-harness\//)
    // Credential came from the same apiKeyEnv the route already used.
    assert.equal(http.headers['x-api-key'], 'sk-from-store')
    // No route/model config was duplicated anywhere.
    assert.equal(ctx.loader !== undefined, true)

    assert.deepEqual(
      http.body.system.map((block) => block.text),
      [
        "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
        'You are an interactive agent that helps users with software engineering tasks.',
        'Harness prompt.',
      ],
    )
    assert.deepEqual(http.body.tools, undefined)
    const userId = JSON.parse(http.body.metadata.user_id)
    assert.deepEqual(userId, { device_id: 'device-test', account_uuid: '', session_id: '' })
    assert.equal(first.chunks.at(-1).reason.kind, 'tool-calls')
  } finally {
    await server.close()
  }
})

test('internal one-shot calls keep their own prompt and sampling protocol', async () => {
  const server = await mockServer([textBody({ text: '{"risk":"low","decision":"allow"}' })])
  try {
    const opusRoute = routeProfile(server.baseURL, {
      models: [
        {
          id: 'claude-opus-5-5',
          name: 'Claude Opus 5.5',
          contextWindow: 1000000,
          maxTokens: 128000,
          input: ['text', 'image'],
          compat: { supportsTemperature: true },
        },
      ],
    })
    const { handle } = mount({ providers: { gateway: opusRoute } })
    // The shape auto-review builds: fixed policy as system, one user payload,
    // temperature 0, and no agent-loop marker.
    const review = {
      provider: 'gateway',
      model: 'claude-opus-5-5',
      system: 'REVIEW_POLICY: reply with exactly one JSON object.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'PENDING_ACTION {...}' }] }],
      temperature: 0,
      signal: AbortSignal.timeout(5000),
    }
    const { passedThrough } = await call(handle, review)
    assert.equal(passedThrough, false)

    const http = server.captured[0]
    // The reviewer's own system prompt survives untouched: no agent persona.
    assert.equal(http.body.system.length, 1)
    assert.equal(http.body.system[0].text, review.system)
    // No thinking default was invented for an internal call.
    assert.ok(http.body.thinking === undefined || http.body.thinking.type === 'disabled')
    assert.equal(http.body.output_config, undefined)
    // Its explicit sampling control still reaches the wire.
    assert.equal(http.body.temperature, 0)
    // The gateway disguise itself still applies.
    assert.equal(http.headers['user-agent'], 'claude-cli/2.1.293 (external, cli)')
    assert.ok(http.headers['x-api-key'])
    assert.ok(JSON.parse(http.body.metadata.user_id).device_id)
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
    // compat default wins for the gateway marker.
    assert.equal(http.headers['x-app'], 'cli')
  } finally {
    await server.close()
  }
})
