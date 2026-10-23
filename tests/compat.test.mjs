import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyPayload,
  requestToolName,
  responseToolName,
  toHarnessArguments,
} from '../src/compat.js'

const compat = {
  mode: 'auto',
  identityBlocks: true,
  metadataUserId: true,
  toolSchema: 'names-only',
  unknownToolPrefix: 'mcp__dsh__',
}

function payload(overrides = {}) {
  return {
    model: 'claude-haiku-5-5',
    max_tokens: 1024,
    system: [{ type: 'text', text: 'Harness prompt.', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [
      {
        name: 'bash',
        description: 'Run a command',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' }, timeoutMs: { type: 'number' }, workdir: { type: 'string' } },
          required: ['command'],
        },
      },
      { name: 'read', description: 'Read a file', input_schema: { type: 'object', properties: {} } },
      { name: 'todo_write', description: 'Write todos', input_schema: { type: 'object', properties: {} } },
      { name: 'mcp__other__tool', description: 'MCP tool', input_schema: { type: 'object', properties: {} } },
    ],
    ...overrides,
  }
}

test('tool names map to Claude Code names and back', () => {
  assert.equal(requestToolName('read', compat), 'Read')
  assert.equal(requestToolName('bash', compat), 'Bash')
  assert.equal(requestToolName('todo_write', compat), 'mcp__dsh__todo_write')
  assert.equal(requestToolName('mcp__other__tool', compat), 'mcp__other__tool')
  assert.equal(responseToolName('Bash', compat), 'bash')
  assert.equal(responseToolName('mcp__dsh__todo_write', compat), 'todo_write')
  assert.equal(responseToolName('SomethingElse', compat), 'SomethingElse')
})

test('applyPayload injects identity blocks, metadata and rewrites tools/history', () => {
  const input = payload({
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: { file_path: 'a' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' }] },
    ],
  })
  const out = applyPayload(input, {
    model: 'claude-haiku-5-5',
    sessionId: 'session-1',
    deviceId: 'device-1',
    compat,
  })
  assert.equal(out.system[0].text, "You are a Claude agent, built on Anthropic's Claude Agent SDK.")
  assert.equal(out.system[1].text, 'You are an interactive agent that helps users with software engineering tasks.')
  assert.equal(out.system[2].text, 'Harness prompt.')
  assert.deepEqual(out.system[2].cache_control, { type: 'ephemeral' })
  assert.equal(out.system[0].cache_control, undefined)
  assert.deepEqual(out.tools.map((tool) => tool.name), ['Bash', 'Read', 'mcp__dsh__todo_write', 'mcp__other__tool'])
  assert.equal(out.messages[0].content[0].name, 'Read')
  assert.equal(out.messages[1].content[0].tool_use_id, 'toolu_1')
  const userId = JSON.parse(out.metadata.user_id)
  assert.deepEqual(userId, { device_id: 'device-1', account_uuid: '', session_id: 'session-1' })
  // Input is not mutated.
  assert.equal(input.system.length, 1)
  assert.equal(input.tools[0].name, 'bash')
})

test('applyPayload is idempotent', () => {
  const context = { model: 'claude-haiku-5-5', sessionId: 's', deviceId: 'd', compat }
  const once = applyPayload(payload(), context)
  const twice = applyPayload(once, context)
  assert.deepEqual(twice, once)
})

test('applyPayload leaves non-matching requests untouched', () => {
  const context = { model: 'claude-haiku-5-5', compat }
  assert.equal(applyPayload(payload(), { ...context, model: 'gpt-x' }), undefined)
  assert.equal(applyPayload(payload({ model: 'claude-opus-5-5' }), context), undefined)
  assert.equal(applyPayload(payload(), { ...context, compat: { ...compat, mode: 'off' } }), undefined)
})

test('configured identity/metadata switches are honoured', () => {
  const out = applyPayload(payload(), {
    model: 'claude-haiku-5-5',
    sessionId: 's',
    deviceId: 'd',
    compat: { ...compat, identityBlocks: false, metadataUserId: false },
  })
  assert.equal(out.system.length, 1)
  assert.equal(out.system[0].text, 'Harness prompt.')
  assert.equal(out.metadata, undefined)
})

test('names-only mode keeps the harness tool schemas', () => {
  const out = applyPayload(payload(), { model: 'claude-haiku-5-5', compat })
  const bash = out.tools.find((tool) => tool.name === 'Bash')
  assert.equal(bash.input_schema.properties.timeoutMs.type, 'number')
  assert.equal(bash.input_schema.properties.workdir.type, 'string')
})

test('claude-code tool schema mode narrows Edit/Bash/Grep', () => {
  const input = payload({
    tools: [
      {
        name: 'edit',
        description: 'Edit a file',
        input_schema: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            old_string: { type: 'string' },
            new_string: { type: 'string' },
            replace_all: { type: 'boolean' },
          },
          required: ['file_path', 'old_string', 'new_string'],
        },
      },
      {
        name: 'bash',
        description: 'Run a command',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' }, timeoutMs: { type: 'number' }, workdir: { type: 'string' } },
          required: ['command'],
        },
      },
      { name: 'grep', description: 'Search.', input_schema: { type: 'object', properties: {} } },
    ],
  })
  const out = applyPayload(input, {
    model: 'claude-haiku-5-5',
    compat: { ...compat, toolSchema: 'claude-code' },
  })
  const edit = out.tools.find((tool) => tool.name === 'Edit')
  assert.deepEqual(Object.keys(edit.input_schema.properties), ['file_path', 'old_string', 'new_string'])
  assert.equal(edit.input_schema.properties.replace_all, undefined)
  const bash = out.tools.find((tool) => tool.name === 'Bash')
  assert.equal(bash.input_schema.properties.timeoutMs, undefined)
  assert.equal(bash.input_schema.properties.timeout.type, 'number')
  assert.equal(bash.input_schema.properties.workdir, undefined)
  assert.ok(bash.input_schema.properties.command)
  const grep = out.tools.find((tool) => tool.name === 'Grep')
  assert.match(grep.description, /matching lines/)
})

test('Bash timeout uses milliseconds on both sides of the wire', () => {
  const out = applyPayload(
    payload({
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't', name: 'bash', input: { command: 'ls', timeoutMs: 2500 } }],
        },
      ],
    }),
    { model: 'claude-haiku-5-5', compat },
  )
  assert.deepEqual(out.messages[0].content[0].input, { command: 'ls', timeout: 2500 })
  assert.deepEqual(toHarnessArguments('bash', { command: 'ls', timeout: 2500 }), {
    command: 'ls',
    timeoutMs: 2500,
  })
})
