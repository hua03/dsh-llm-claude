/**
 * Manual smoke test: run the interceptor against a local mock Anthropic
 * endpoint that stands in for the route DSH already configured.
 *
 *   node scripts/smoke.mjs            # tool-call turn + tool-result continuation
 *   node scripts/smoke.mjs --thinking # ask for a thinking block too
 *
 * Prints the captured wire request (headers + body) and the harness chunks.
 */

import { basicMessages, call, mockServer, routeProfile, textBody, toolBody, mount } from '../tests/helpers.mjs'

const withThinking = process.argv.includes('--thinking')
const server = await mockServer([toolBody({ withThinking }), textBody({ text: 'Done: a.txt is one line.' })])

const model = withThinking ? 'claude-sonnet-5-5' : 'claude-haiku-5-5'
const { handle } = mount({ providers: { gateway: routeProfile(server.baseURL) } })

const messages = basicMessages('read a.txt')
const first = await call(handle, {
  provider: 'gateway',
  model,
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
})

const toolEnd = first.chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
const finish = first.chunks.find((chunk) => chunk.type === 'finish')
const assistantContent = first.chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block)

const second = await call(handle, {
  provider: 'gateway',
  model,
  messages: [
    ...messages,
    {
      role: 'assistant',
      id: 'm3',
      content: assistantContent,
      source: { kind: 'model', provider: 'gateway', model, replayState: finish.replayState },
    },
    {
      role: 'tool',
      id: 'm4',
      toolCallId: toolEnd.block.id,
      content: [{ type: 'text', text: 'one line' }],
      source: { kind: 'tool', callId: toolEnd.block.id },
    },
  ],
  sessionId: 'session-abc',
  signal: AbortSignal.timeout(5000),
})

server.close()

console.log('=== intercepted? ===')
console.log({ turn1: !first.passedThrough, turn2: !second.passedThrough })
console.log('=== request 1 headers ===')
console.log(
  JSON.stringify(
    Object.fromEntries(
      ['user-agent', 'x-app', 'x-dsh-attribution', 'anthropic-version', 'anthropic-beta', 'x-api-key'].map((key) => [
        key,
        server.captured[0].headers[key],
      ]),
    ),
    null,
    2,
  ),
)
console.log('=== request 1 body ===')
console.log(JSON.stringify(server.captured[0].body, null, 2))
console.log('=== chunks turn 1 ===')
for (const chunk of first.chunks) console.log(JSON.stringify(chunk))
console.log('=== request 2 body (history round-trip) ===')
console.log(JSON.stringify(server.captured[1]?.body?.messages, null, 2))
console.log('=== chunks turn 2 ===')
for (const chunk of second.chunks) console.log(JSON.stringify(chunk))
