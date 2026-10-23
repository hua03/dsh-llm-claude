/**
 * Test helpers: a local Anthropic-compatible SSE endpoint and an adapter
 * factory that needs no cordis context.
 */

import http from 'node:http'
import { ClaudeAdapter } from '../src/adapter.js'
import { resolveAdapterOptions } from '../src/config.js'

export function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** One text response turn. */
export function textBody({ text = 'hello', stopReason = 'end_turn', inputTokens = 10, outputTokens = 5 } = {}) {
  return [
    sse('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_text',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}

/** One tool-use response turn, optionally preceded by a thinking block. */
export function toolBody({ withThinking = false } = {}) {
  const thinkingIndex = 0
  const toolIndex = withThinking ? 1 : 0
  return [
    sse('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_tool',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 1 },
      },
    }),
    ...(withThinking
      ? [
          sse('content_block_start', {
            type: 'content_block_start',
            index: thinkingIndex,
            content_block: { type: 'thinking', thinking: '', signature: '' },
          }),
          sse('content_block_delta', {
            type: 'content_block_delta',
            index: thinkingIndex,
            delta: { type: 'thinking_delta', thinking: 'thinking text' },
          }),
          sse('content_block_delta', {
            type: 'content_block_delta',
            index: thinkingIndex,
            delta: { type: 'signature_delta', signature: 'sig-1' },
          }),
          sse('content_block_stop', { type: 'content_block_stop', index: thinkingIndex }),
        ]
      : []),
    sse('content_block_start', {
      type: 'content_block_start',
      index: toolIndex,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
    }),
    sse('content_block_delta', {
      type: 'content_block_delta',
      index: toolIndex,
      delta: { type: 'input_json_delta', partial_json: '{"command":"ls","timeout":2500}' },
    }),
    sse('content_block_stop', { type: 'content_block_stop', index: toolIndex }),
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 11 },
    }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}

/** Start a mock endpoint; `responses` is one entry per request (SSE text or a status). */
export async function mockServer(responses) {
  const captured = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      captured.push({ url: req.url, headers: req.headers, body: raw === '' ? undefined : JSON.parse(raw) })
      const response = responses[Math.min(captured.length - 1, responses.length - 1)]
      if (typeof response === 'object' && response.status !== undefined) {
        res.writeHead(response.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(response.body))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(response)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    captured,
    baseURL: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** Adapter over the mock endpoint with stub auth/identity. */
export function adapterFor(baseURL, overrides = {}, extra = {}) {
  const config = {
    provider: 'claude-mock',
    displayName: 'Mock Claude',
    baseURL,
    apiKeyEnv: 'MOCK_CLAUDE_KEY',
    models: [
      {
        id: 'claude-haiku-5-5',
        name: 'Claude Haiku 5.5',
        contextWindow: 200000,
        maxTokens: 64000,
        inputModalities: ['text', 'image'],
        reasoning: false,
        supportsTemperature: false,
      },
      {
        id: 'claude-sonnet-5-5',
        name: 'Claude Sonnet 5.5',
        contextWindow: 1000000,
        maxTokens: 128000,
        inputModalities: ['text', 'image'],
        reasoning: 'adaptive',
      },
    ],
    claudeCodeCompat: { mode: 'auto' },
    reasoningEffort: 'high',
    streamIdleTimeoutMs: 5000,
    ...overrides,
  }
  return new ClaudeAdapter({
    options: () => resolveAdapterOptions(config),
    resolveAuth: async () => ({ apiKey: 'sk-test' }),
    deviceId: () => 'device-test',
    ...extra,
  })
}

/** System + user messages matching the runtime's loop-built shape. */
export function basicMessages(text = 'say hello') {
  return [
    {
      role: 'system',
      id: 'm1',
      content: [{ type: 'text', text: 'Harness prompt.' }],
      source: { kind: 'system-prompt' },
    },
    { role: 'user', id: 'm2', content: [{ type: 'text', text }], source: { kind: 'user' } },
  ]
}

/** Collect one full adapter stream. */
export async function collect(adapter, options) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}
