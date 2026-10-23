import assert from 'node:assert/strict'
import test from 'node:test'
import { basicMessages, call, mockServer, routeProfile, textBody, toolBody, mount } from './helpers.mjs'

const request = (overrides = {}) => ({
  provider: 'gateway',
  model: 'claude-haiku-5-5',
  messages: basicMessages('go'),
  signal: AbortSignal.timeout(5000),
  ...overrides,
})

test('a tool round-trip keeps wire names on the wire and harness names locally', async () => {
  const server = await mockServer([toolBody(), textBody({ text: 'listed' })])
  try {
    const { handle } = mount({ providers: { gateway: routeProfile(server.baseURL) } })
    const first = await call(handle, request())
    const toolEnd = first.chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    assert.equal(toolEnd.block.name, 'bash')
    assert.deepEqual(JSON.parse(toolEnd.block.arguments), { command: 'ls', timeoutMs: 2500 })

    const finish = first.chunks.find((chunk) => chunk.type === 'finish')
    const assistantContent = first.chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block)
    await call(
      handle,
      request({
        messages: [
          ...basicMessages('go'),
          {
            role: 'assistant',
            id: 'm3',
            content: assistantContent,
            source: {
              kind: 'model',
              provider: 'gateway',
              model: 'claude-haiku-5-5',
              replayState: finish.replayState,
            },
          },
          {
            role: 'tool',
            id: 'm4',
            toolCallId: toolEnd.block.id,
            content: [{ type: 'text', text: 'a.txt' }],
            source: { kind: 'tool', callId: toolEnd.block.id },
          },
        ],
      }),
    )
    const history = server.captured[1].body.messages
    const assistant = history.find((message) => message.role === 'assistant')
    assert.equal(assistant.content[0].name, 'Bash')
    assert.deepEqual(assistant.content[0].input, { command: 'ls', timeout: 2500 })
    const toolResult = history.at(-1).content[0]
    assert.equal(toolResult.tool_use_id, toolEnd.block.id)
  } finally {
    await server.close()
  }
})

test('adaptive thinking is requested and its signature is replayed', async () => {
  const server = await mockServer([toolBody({ withThinking: true }), textBody({ text: 'done' })])
  try {
    const { handle } = mount({ providers: { gateway: routeProfile(server.baseURL) } })
    const first = await call(handle, request({ model: 'claude-sonnet-5-5' }))
    assert.deepEqual(server.captured[0].body.thinking, { type: 'adaptive', display: 'summarized' })
    assert.deepEqual(server.captured[0].body.output_config, { effort: 'high' })
    const finish = first.chunks.find((chunk) => chunk.type === 'finish')
    assert.deepEqual(finish.replayState.blocks[0], { type: 'reasoning', thinkingSignature: 'sig-1' })

    const toolEnd = first.chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    await call(
      handle,
      request({
        model: 'claude-sonnet-5-5',
        messages: [
          ...basicMessages('go'),
          {
            role: 'assistant',
            id: 'm3',
            content: first.chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block),
            source: {
              kind: 'model',
              provider: 'gateway',
              model: 'claude-sonnet-5-5',
              replayState: finish.replayState,
            },
          },
          {
            role: 'tool',
            id: 'm4',
            toolCallId: toolEnd.block.id,
            content: [{ type: 'text', text: 'ok' }],
            source: { kind: 'tool', callId: toolEnd.block.id },
          },
        ],
      }),
    )
    const replayed = server.captured[1].body.messages[1]
    assert.equal(replayed.content[0].type, 'thinking')
    assert.equal(replayed.content[0].signature, 'sig-1')
  } finally {
    await server.close()
  }
})

test('auxiliary calls do not acquire thinking from the route default', async () => {
  const server = await mockServer([textBody({ text: 'title' })])
  try {
    const { handle } = mount({ providers: { gateway: routeProfile(server.baseURL) } })
    await call(handle, request({ model: 'claude-sonnet-5-5', purpose: 'session-title' }))
    const thinking = server.captured[0].body.thinking
    assert.ok(thinking === undefined || thinking.type === 'disabled')
    assert.equal(server.captured[0].body.output_config, undefined)
  } finally {
    await server.close()
  }
})

test('gateway failures keep their retry classification', async () => {
  const server = await mockServer([
    { status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } } },
  ])
  try {
    const { handle } = mount({ providers: { gateway: routeProfile(server.baseURL) } })
    const { chunks } = await call(handle, request())
    assert.equal(chunks.at(-1).reason.kind, 'error')
    assert.equal(chunks.at(-1).reason.failure.code, 'RATE_LIMIT')
  } finally {
    await server.close()
  }
})

test('claude-code tool schema mode narrows the wire declarations', async () => {
  const server = await mockServer([textBody()])
  try {
    const { handle } = mount({
      providers: { gateway: routeProfile(server.baseURL) },
      config: { claudeCodeCompat: { toolSchema: 'claude-code' } },
    })
    await call(
      handle,
      request({
        tools: [
          {
            name: 'edit',
            description: 'Edit a file',
            parameters: {
              type: 'object',
              properties: {
                file_path: { type: 'string' },
                old_string: { type: 'string' },
                new_string: { type: 'string' },
                replace_all: { type: 'boolean' },
              },
            },
          },
          {
            name: 'bash',
            description: 'Run',
            parameters: {
              type: 'object',
              properties: { command: { type: 'string' }, timeoutMs: { type: 'number' }, workdir: { type: 'string' } },
            },
          },
        ],
      }),
    )
    const tools = server.captured[0].body.tools
    const edit = tools.find((tool) => tool.name === 'Edit')
    assert.deepEqual(Object.keys(edit.input_schema.properties), ['file_path', 'old_string', 'new_string'])
    const bash = tools.find((tool) => tool.name === 'Bash')
    assert.equal(bash.input_schema.properties.timeoutMs, undefined)
    assert.equal(bash.input_schema.properties.timeout.type, 'number')
  } finally {
    await server.close()
  }
})

test('models outside the route catalog are left to the owning plugin', async () => {
  const server = await mockServer([textBody()])
  try {
    const { handle } = mount({ providers: { gateway: routeProfile(server.baseURL) } })
    const { passedThrough } = await call(handle, request({ model: 'claude-unlisted' }))
    assert.equal(passedThrough, true)
    assert.equal(server.captured.length, 0)
  } finally {
    await server.close()
  }
})
