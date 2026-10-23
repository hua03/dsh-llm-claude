import assert from 'node:assert/strict'
import test from 'node:test'
import { adapterFor, basicMessages, collect, mockServer, textBody, toolBody } from './helpers.mjs'

test('first turn carries the Claude Code wire shape', async () => {
  const server = await mockServer([textBody()])
  try {
    const adapter = adapterFor(server.baseURL)
    const chunks = await collect(adapter, {
      provider: 'claude-mock',
      model: 'claude-haiku-5-5',
      messages: basicMessages('say hello'),
      sessionId: 'session-1',
      tools: [
        {
          name: 'read',
          description: 'Read a file',
          parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
        },
      ],
      signal: AbortSignal.timeout(5000),
    })

    const request = server.captured[0]
    assert.match(request.url, /^\/v1\/messages/)
    assert.equal(request.headers['user-agent'], 'claude-cli/2.1.293 (external, cli)')
    assert.equal(request.headers['x-app'], 'cli')
    assert.match(request.headers['x-dsh-attribution'], /^deepseek-harness\//)
    assert.equal(request.headers['anthropic-version'], '2023-06-01')
    assert.equal(request.headers['x-api-key'], 'sk-test')

    assert.equal(request.body.model, 'claude-haiku-5-5')
    assert.deepEqual(
      request.body.system.map((block) => block.text),
      [
        "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
        'You are an interactive agent that helps users with software engineering tasks.',
        'Harness prompt.',
      ],
    )
    assert.deepEqual(request.body.tools.map((tool) => tool.name), ['Read'])
    const userId = JSON.parse(request.body.metadata.user_id)
    assert.deepEqual(userId, { device_id: 'device-test', account_uuid: '', session_id: 'session-1' })
    assert.equal(request.body.stream, true)
    assert.equal(request.body.max_tokens, 64000)

    assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
    assert.equal(chunks.at(-2).type, 'usage')
  } finally {
    await server.close()
  }
})

test('a tool round-trip keeps wire names on the wire and harness names locally', async () => {
  const server = await mockServer([toolBody(), textBody({ text: 'listed' })])
  try {
    const adapter = adapterFor(server.baseURL)
    const first = await collect(adapter, {
      provider: 'claude-mock',
      model: 'claude-haiku-5-5',
      messages: basicMessages('list files'),
      signal: AbortSignal.timeout(5000),
    })
    const toolEnd = first.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    assert.equal(toolEnd.block.name, 'bash')
    assert.deepEqual(JSON.parse(toolEnd.block.arguments), { command: 'ls', timeoutMs: 2500 })

    const assistantContent = first.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block)
    const finish = first.find((chunk) => chunk.type === 'finish')
    await collect(adapter, {
      provider: 'claude-mock',
      model: 'claude-haiku-5-5',
      messages: [
        ...basicMessages('list files'),
        {
          role: 'assistant',
          id: 'm3',
          content: assistantContent,
          source: {
            kind: 'model',
            provider: 'claude-mock',
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
      signal: AbortSignal.timeout(5000),
    })

    const history = server.captured[1].body.messages
    const assistant = history.find((message) => message.role === 'assistant')
    assert.equal(assistant.content[0].name, 'Bash')
    assert.deepEqual(assistant.content[0].input, { command: 'ls', timeout: 2500 })
    const toolResult = history.at(-1).content[0]
    assert.equal(toolResult.type, 'tool_result')
    assert.equal(toolResult.tool_use_id, toolEnd.block.id)
  } finally {
    await server.close()
  }
})

test('adaptive thinking is requested and its signature is replayed', async () => {
  const server = await mockServer([toolBody({ withThinking: true }), textBody({ text: 'done' })])
  try {
    const adapter = adapterFor(server.baseURL, { reasoningEffort: 'high' })
    const first = await collect(adapter, {
      provider: 'claude-mock',
      model: 'claude-sonnet-5-5',
      messages: basicMessages('go'),
      signal: AbortSignal.timeout(5000),
    })
    assert.deepEqual(server.captured[0].body.thinking, { type: 'adaptive', display: 'summarized' })
    assert.deepEqual(server.captured[0].body.output_config, { effort: 'high' })
    const reasoningEnd = first.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'reasoning')
    assert.equal(reasoningEnd.block.text, 'thinking text')
    const finish = first.find((chunk) => chunk.type === 'finish')
    assert.deepEqual(finish.replayState.blocks[0], { type: 'reasoning', thinkingSignature: 'sig-1' })

    const toolEnd = first.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    await collect(adapter, {
      provider: 'claude-mock',
      model: 'claude-sonnet-5-5',
      messages: [
        ...basicMessages('go'),
        {
          role: 'assistant',
          id: 'm3',
          content: first.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block),
          source: {
            kind: 'model',
            provider: 'claude-mock',
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
      signal: AbortSignal.timeout(5000),
    })
    const replayed = server.captured[1].body.messages[1]
    assert.equal(replayed.content[0].type, 'thinking')
    assert.equal(replayed.content[0].signature, 'sig-1')
  } finally {
    await server.close()
  }
})

test('gateway failures keep their retry classification', async () => {
  const server = await mockServer([
    {
      status: 429,
      body: { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } },
    },
  ])
  try {
    const adapter = adapterFor(server.baseURL)
    const chunks = await collect(adapter, {
      provider: 'claude-mock',
      model: 'claude-haiku-5-5',
      messages: basicMessages('hi'),
      signal: AbortSignal.timeout(5000),
    })
    const finish = chunks.at(-1)
    assert.equal(finish.reason.kind, 'error')
    assert.equal(finish.reason.failure.code, 'RATE_LIMIT')
  } finally {
    await server.close()
  }
})

test('compat can be turned off for a plain Anthropic endpoint', async () => {
  const server = await mockServer([textBody()])
  try {
    const adapter = adapterFor(server.baseURL, { claudeCodeCompat: { mode: 'off' } })
    await collect(adapter, {
      provider: 'claude-mock',
      model: 'claude-haiku-5-5',
      messages: basicMessages('hi'),
      signal: AbortSignal.timeout(5000),
    })
    const request = server.captured[0]
    assert.deepEqual(request.body.system.map((block) => block.text), ['Harness prompt.'])
    assert.equal(request.body.metadata, undefined)
    assert.equal(request.headers['x-dsh-attribution'], undefined)
    assert.notEqual(request.headers['user-agent'], 'claude-cli/2.1.293 (external, cli)')
  } finally {
    await server.close()
  }
})
