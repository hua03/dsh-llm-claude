import assert from 'node:assert/strict'
import test from 'node:test'
import { toPiModel } from '../src/claude-stream.js'
import { toStreamChunks } from '../src/stream.js'

const compat = { mode: 'auto', unknownToolPrefix: 'mcp__dsh__' }

function streamOf(events) {
  return (async function* () {
    for (const event of events) yield event
  })()
}

const usage = { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14 }

function assistant(content, overrides = {}) {
  return {
    role: 'assistant',
    content,
    api: 'anthropic-messages',
    provider: 'claude-test',
    model: 'claude-haiku-5-5',
    usage,
    stopReason: 'stop',
    timestamp: 0,
    ...overrides,
  }
}

async function collect(events) {
  const chunks = []
  for await (const chunk of toStreamChunks(streamOf(events), {
    requestedModel: 'claude-haiku-5-5',
    compat,
  })) {
    chunks.push(chunk)
  }
  return chunks
}

test('text turns become block chunks, then usage, then finish', async () => {
  const chunks = await collect([
    { type: 'start', partial: assistant([]) },
    { type: 'text_start', contentIndex: 0, partial: assistant([]) },
    { type: 'text_delta', contentIndex: 0, delta: 'hi ' },
    { type: 'text_delta', contentIndex: 0, delta: 'there' },
    { type: 'text_end', contentIndex: 0, content: 'hi there' },
    { type: 'done', reason: 'stop', message: assistant([{ type: 'text', text: 'hi there' }]) },
  ])
  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish'],
  )
  assert.deepEqual(chunks[3].block, { type: 'text', text: 'hi there' })
  assert.deepEqual(chunks[5].reason, { kind: 'stop' })
  assert.equal(chunks[5].replayState.response.kind, 'dsh-claude')
  assert.deepEqual(chunks[5].replayState.blocks, [{ type: 'text' }])
})

test('wire tool names and arguments are converted back to the harness spelling', async () => {
  const toolCall = { type: 'toolCall', id: 'toolu_1', name: 'Bash', arguments: { command: 'ls', timeout: 2500 } }
  const chunks = await collect([
    { type: 'toolcall_start', contentIndex: 0, partial: assistant([{ ...toolCall, arguments: {} }]) },
    { type: 'toolcall_delta', contentIndex: 0, delta: '{"command":"ls","timeout":2500}' },
    { type: 'toolcall_end', contentIndex: 0, toolCall },
    { type: 'done', reason: 'toolUse', message: assistant([toolCall], { stopReason: 'toolUse' }) },
  ])
  const delta = chunks.find((chunk) => chunk.type === 'tool-call-delta')
  assert.equal(delta.name, 'bash')
  const end = chunks.find((chunk) => chunk.type === 'block-end')
  assert.equal(end.block.name, 'bash')
  assert.deepEqual(JSON.parse(end.block.arguments), { command: 'ls', timeoutMs: 2500 })
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
})

test('unknown wire tools keep their mcp names', async () => {
  const toolCall = { type: 'toolCall', id: 'toolu_2', name: 'mcp__dsh__todo_write', arguments: {} }
  const chunks = await collect([
    { type: 'toolcall_start', contentIndex: 0, partial: assistant([toolCall]) },
    { type: 'toolcall_end', contentIndex: 0, toolCall },
    { type: 'done', reason: 'toolUse', message: assistant([toolCall], { stopReason: 'toolUse' }) },
  ])
  const end = chunks.find((chunk) => chunk.type === 'block-end')
  assert.equal(end.block.name, 'todo_write')
})

test('max_tokens maps to the harness max-tokens reason', async () => {
  const chunks = await collect([
    { type: 'text_start', contentIndex: 0, partial: assistant([]) },
    { type: 'text_end', contentIndex: 0, content: 'partial' },
    {
      type: 'done',
      reason: 'length',
      message: assistant([{ type: 'text', text: 'partial' }], { stopReason: 'length' }),
    },
  ])
  assert.deepEqual(chunks.at(-1).reason, { kind: 'max-tokens' })
})

test('provider failures become classified error finishes', async () => {
  const chunks = await collect([
    {
      type: 'error',
      reason: 'error',
      error: assistant([], { stopReason: 'error', errorMessage: '401 unauthorized: invalid api key' }),
    },
  ])
  assert.deepEqual(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'AUTH')
})

test('an empty completed response becomes EMPTY_RESPONSE', async () => {
  const chunks = await collect([{ type: 'done', reason: 'stop', message: assistant([]) }])
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'EMPTY_RESPONSE')
})

test('a stream without a terminal event fails loudly', async () => {
  await assert.rejects(
    collect([{ type: 'text_start', contentIndex: 0, partial: assistant([]) }]),
    /ended without done\/error/,
  )
})

test('an adaptive pi model maps thinking off to an omitted clause', () => {
  const model = toPiModel(
    { provider: 'gateway', baseURL: 'https://gateway.example' },
    {
      id: 'claude-sonnet-5-5',
      name: 'Claude Sonnet 5.5',
      inputModalities: ['text', 'image'],
      contextWindow: 1000000,
      maxTokens: 128000,
      reasoning: 'adaptive',
      supportsTemperature: false,
      supportsStrictTools: true,
    },
    { thinkingMode: 'auto' },
  )
  assert.equal(model.reasoning, true)
  assert.equal(model.compat.forceAdaptiveThinking, true)
  assert.deepEqual(model.thinkingLevelMap, { off: null })
})
