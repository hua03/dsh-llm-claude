import assert from 'node:assert/strict'
import test from 'node:test'
import { buildReplayState } from '../src/replay.js'
import { toPiContext } from '../src/context.js'

const deps = { maxRequestImagesBytes: 1024 * 1024, onReplayDegrade: () => {} }

function piAssistant(overrides = {}) {
  return {
    api: 'anthropic-messages',
    provider: 'claude-test',
    model: 'claude-haiku-5-5',
    content: [{ type: 'text', text: 'ok' }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: 'stop',
    timestamp: 0,
    ...overrides,
  }
}

test('leading system message becomes the pi-ai system prompt', async () => {
  const { context } = await toPiContext(
    {
      provider: 'claude-test',
      model: 'claude-haiku-5-5',
      system: undefined,
      messages: [
        { role: 'system', id: 'm1', content: [{ type: 'text', text: 'Prompt A' }], source: { kind: 'system-prompt' } },
        { role: 'system', id: 'm2', content: [{ type: 'text', text: 'Prompt B' }], source: { kind: 'system-prompt' } },
        { role: 'user', id: 'm3', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
      ],
    },
    deps,
  )
  assert.equal(context.systemPrompt, 'Prompt A\n\nPrompt B')
  assert.deepEqual(context.messages, [{ role: 'user', content: 'hello', timestamp: 0 }])
})

test('tool declarations drop the harness activation marker', async () => {
  const { context } = await toPiContext(
    {
      provider: 'claude-test',
      model: 'claude-haiku-5-5',
      messages: [
        { role: 'user', id: 'm1', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
      ],
      tools: [
        { name: 'read', description: 'Read', parameters: { type: 'object' }, deferLoading: true },
        { name: 'bash', description: 'Bash', parameters: { type: 'object' } },
      ],
    },
    deps,
  )
  assert.deepEqual(context.tools.map((tool) => tool.name), ['bash'])
})

test('assistant replay restores thinking signatures', async () => {
  const piMessage = piAssistant({
    content: [
      { type: 'thinking', thinking: 'reasoned', thinkingSignature: 'sig-1' },
      { type: 'toolCall', id: 'toolu_1', name: 'bash', arguments: { command: 'ls' } },
    ],
    stopReason: 'toolUse',
  })
  const replayState = buildReplayState(piMessage, 'claude-haiku-5-5')
  const { context } = await toPiContext(
    {
      provider: 'claude-test',
      model: 'claude-haiku-5-5',
      messages: [
        { role: 'user', id: 'm1', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } },
        {
          role: 'assistant',
          id: 'm2',
          content: [
            { type: 'reasoning', text: 'reasoned' },
            { type: 'tool-call', id: 'toolu_1', name: 'bash', arguments: '{"command":"ls"}' },
          ],
          source: { kind: 'model', provider: 'claude-test', model: 'claude-haiku-5-5', replayState },
        },
        {
          role: 'tool',
          id: 'm3',
          toolCallId: 'toolu_1',
          content: [{ type: 'text', text: 'file list' }],
          source: { kind: 'tool', callId: 'toolu_1' },
        },
      ],
    },
    deps,
  )
  const assistant = context.messages[1]
  assert.equal(assistant.content[0].type, 'thinking')
  assert.equal(assistant.content[0].thinkingSignature, 'sig-1')
  const toolResult = context.messages[2]
  assert.equal(toolResult.role, 'toolResult')
  assert.equal(toolResult.toolName, 'bash')
  assert.equal(toolResult.toolCallId, 'toolu_1')
})

test('replay state from another model degrades to unsigned history', async () => {
  const piMessage = piAssistant({
    content: [{ type: 'thinking', thinking: 'reasoned', thinkingSignature: 'sig-1' }],
  })
  const replayState = buildReplayState({ ...piMessage, model: 'claude-sonnet-5-5' }, 'claude-sonnet-5-5')
  const degrades = []
  const { context } = await toPiContext(
    {
      provider: 'claude-test',
      model: 'claude-haiku-5-5',
      messages: [
        {
          role: 'assistant',
          id: 'm1',
          content: [{ type: 'reasoning', text: 'reasoned' }],
          source: { kind: 'model', provider: 'claude-test', model: 'claude-haiku-5-5', replayState },
        },
      ],
    },
    { ...deps, onReplayDegrade: (reason) => degrades.push(reason) },
  )
  assert.equal(context.messages[0].content[0].thinkingSignature, undefined)
  assert.equal(degrades.length, 1)
})

test('developer messages are not forwarded to the provider', async () => {
  const { context } = await toPiContext(
    {
      provider: 'claude-test',
      model: 'claude-haiku-5-5',
      messages: [
        { role: 'user', id: 'm1', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } },
        {
          role: 'developer',
          id: 'm2',
          content: [{ type: 'tool-removal', toolName: 'bash' }],
          source: { kind: 'user' },
        },
      ],
    },
    deps,
  )
  assert.equal(context.messages.length, 1)
})

test('images without the attachment service are refused loudly', async () => {
  await assert.rejects(
    toPiContext(
      {
        provider: 'claude-test',
        model: 'claude-haiku-5-5',
        messages: [
          {
            role: 'user',
            id: 'm1',
            content: [
              {
                type: 'image',
                attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 10, width: 4, height: 4 },
              },
            ],
            source: { kind: 'user' },
          },
        ],
      },
      { ...deps, attachments: undefined },
    ),
    /requires the durable attachment service/,
  )
})
