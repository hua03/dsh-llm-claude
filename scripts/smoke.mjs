/**
 * Manual smoke test: run the adapter against a local mock Anthropic endpoint.
 *
 *   node scripts/smoke.mjs            # text + tool-call turn
 *   node scripts/smoke.mjs --thinking # also request a thinking block
 *
 * Prints the captured request (headers + body) and the harness chunks, which is
 * the fastest way to check the compat transform and the stream translation
 * without a gateway key.
 */

import http from 'node:http'
import { ClaudeAdapter } from '../src/adapter.js'
import { resolveAdapterOptions } from '../src/config.js'

const withThinking = process.argv.includes('--thinking')

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function bodyFor(turn) {
  if (turn === 1) {
    return [
      sse('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_mock_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-5-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 21, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      }),
      ...(withThinking
        ? [
            sse('content_block_start', {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'thinking', thinking: '', signature: '' },
            }),
            sse('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'thinking_delta', thinking: 'Weighing options.' },
            }),
            sse('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'signature_delta', signature: 'sig-abc' },
            }),
            sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
          ]
        : []),
      sse('content_block_start', {
        type: 'content_block_start',
        index: withThinking ? 1 : 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
      }),
      sse('content_block_delta', {
        type: 'content_block_delta',
        index: withThinking ? 1 : 0,
        delta: { type: 'input_json_delta', partial_json: '{"file_path":"a.txt"}' },
      }),
      sse('content_block_stop', { type: 'content_block_stop', index: withThinking ? 1 : 0 }),
      sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 12 },
      }),
      sse('message_stop', { type: 'message_stop' }),
    ].join('')
  }
  return [
    sse('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_mock_2',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 40, output_tokens: 1 },
      },
    }),
    sse('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    sse('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Done: a.txt is one line.' },
    }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 9 },
    }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}

const captured = []
const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk
  })
  req.on('end', () => {
    captured.push({ url: req.url, headers: req.headers, body: raw === '' ? undefined : JSON.parse(raw) })
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write(bodyFor(captured.length))
    res.end()
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const config = {
  provider: 'claude-mock',
  displayName: 'Mock Claude',
  baseURL: `http://127.0.0.1:${port}`,
  apiKeyEnv: 'MOCK_CLAUDE_KEY',
  models: [
    {
      id: 'claude-haiku-5-5',
      name: 'Claude Haiku 5.5',
      contextWindow: 200000,
      maxTokens: 64000,
      inputModalities: ['text', 'image'],
      reasoning: withThinking ? 'adaptive' : false,
      supportsTemperature: false,
    },
  ],
  claudeCodeCompat: { mode: 'auto' },
  reasoningEffort: 'high',
  streamIdleTimeoutMs: 5000,
}

const adapter = new ClaudeAdapter({
  options: () => resolveAdapterOptions(config),
  resolveAuth: async () => ({ apiKey: 'sk-test' }),
  deviceId: () => 'device-0123456789abcdef',
})

const messages = [
  {
    role: 'system',
    id: 'm1',
    content: [{ type: 'text', text: 'Harness system prompt.' }],
    source: { kind: 'system-prompt' },
  },
  { role: 'user', id: 'm2', content: [{ type: 'text', text: 'read a.txt' }], source: { kind: 'user' } },
]

const chunks1 = []
for await (const chunk of adapter.stream({
  provider: 'claude-mock',
  model: 'claude-haiku-5-5',
  messages,
  sessionId: 'session-abc',
  tools: [
    {
      name: 'read',
      description: 'Read a file',
      parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
    },
  ],
  signal: AbortSignal.timeout(5000),
})) {
  chunks1.push(chunk)
}

const toolCall = chunks1.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
const assistantContent = chunks1
  .filter((chunk) => chunk.type === 'block-end')
  .map((chunk) => chunk.block)

const chunks2 = []
for await (const chunk of adapter.stream({
  provider: 'claude-mock',
  model: 'claude-haiku-5-5',
  messages: [
    ...messages,
    { role: 'assistant', id: 'm3', content: assistantContent, source: { kind: 'model', provider: 'claude-mock', model: 'claude-haiku-5-5', replayState: chunks1.find((c) => c.type === 'finish')?.replayState } },
    { role: 'tool', id: 'm4', toolCallId: toolCall?.block.id, content: [{ type: 'text', text: 'one line' }], source: { kind: 'tool', callId: toolCall?.block.id } },
  ],
  sessionId: 'session-abc',
  signal: AbortSignal.timeout(5000),
})) {
  chunks2.push(chunk)
}

server.close()

console.log('=== request 1 headers ===')
console.log(
  JSON.stringify(
    Object.fromEntries(
      ['user-agent', 'x-app', 'x-dsh-attribution', 'anthropic-version', 'anthropic-beta', 'x-api-key'].map((key) => [
        key,
        captured[0].headers[key],
      ]),
    ),
    null,
    2,
  ),
)
console.log('=== request 1 body ===')
console.log(JSON.stringify(captured[0].body, null, 2))
console.log('=== chunks turn 1 ===')
for (const chunk of chunks1) console.log(JSON.stringify(chunk))
console.log('=== request 2 body (history round-trip) ===')
console.log(JSON.stringify(captured[1]?.body?.messages, null, 2))
console.log('=== chunks turn 2 ===')
for (const chunk of chunks2) console.log(JSON.stringify(chunk))
