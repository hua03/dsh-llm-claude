/**
 * Claude Code client compatibility for Anthropic-compatible gateways.
 *
 * The transform runs inside pi-ai's `onPayload` hook, i.e. on the request body
 * pi-ai assembled and is about to send. It is a pure function of the payload
 * plus the request identity: no I/O, no credentials, and nothing here touches
 * the durable session log. That is the DSH-side equivalent of the pi extension
 * `claude-compat` rewriting `before_provider_request` payloads.
 *
 * @module dsh-llm-claude/compat
 */

/** Identity system blocks pi's extension sends before the harness prompt. */
export const IDENTITY_TEXTS = [
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  'You are an interactive agent that helps users with software engineering tasks.',
]

/** Harness tool name -> Claude Code wire name. DSH already uses Claude-Code-style schemas. */
const WIRE_NAME_BY_HARNESS = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  bash: 'Bash',
  grep: 'Grep',
  glob: 'Glob',
}

const HARNESS_NAME_BY_WIRE = Object.fromEntries(
  Object.entries(WIRE_NAME_BY_HARNESS).map(([harness, wire]) => [wire, harness]),
)

const WIRE_NAMES = new Set(Object.values(WIRE_NAME_BY_HARNESS))

const GREP_BEHAVIOR =
  'This tool returns matching lines, not files-only or counts; output_mode and multiline are unavailable.'

/** Claude Code Edit declaration: one exact unique replacement, no replace_all. */
const CLAUDE_CODE_EDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    file_path: { type: 'string', description: 'Path to the existing file to edit.' },
    old_string: { type: 'string', description: 'Exact, unique text to replace.' },
    new_string: { type: 'string', description: 'Replacement text.' },
  },
  required: ['file_path', 'old_string', 'new_string'],
}

/**
 * Wire name for one harness tool. Unknown tools are namespaced so a gateway that
 * expects Claude Code's built-in names still sees a client-declared MCP tool.
 * @param {string} name - harness tool name.
 * @param {{unknownToolPrefix?: string}} compat - resolved compat options.
 * @returns {string} wire tool name (idempotent).
 */
export function requestToolName(name, compat) {
  if (WIRE_NAMES.has(name)) return name
  const mapped = WIRE_NAME_BY_HARNESS[name]
  if (mapped !== undefined) return mapped
  if (name.startsWith('mcp__')) return name
  return `${compat.unknownToolPrefix ?? 'mcp__dsh__'}${name}`
}

/**
 * Harness name for one wire tool name. Names outside the mapping pass through
 * unchanged rather than being guessed.
 * @param {string} name - wire tool name.
 * @param {{unknownToolPrefix?: string}} compat - resolved compat options.
 * @returns {string} harness tool name.
 */
export function responseToolName(name, compat) {
  const mapped = HARNESS_NAME_BY_WIRE[name]
  if (mapped !== undefined) return mapped
  const prefix = compat.unknownToolPrefix ?? 'mcp__dsh__'
  if (name.startsWith(prefix)) return name.slice(prefix.length)
  return name
}

/**
 * Rewrite one tool declaration for the wire. `names-only` keeps the harness
 * schema (and therefore workdir/sandbox escalation); `claude-code` narrows the
 * declaration to Claude Code's documented shape for the three tools that differ.
 * @param {object} tool - Anthropic tool declaration.
 * @param {string} wireName - already-mapped wire name.
 * @param {{toolSchema?: string}} compat - resolved compat options.
 * @returns {object} transformed tool declaration.
 */
function toolForProvider(tool, wireName, compat) {
  if (compat.toolSchema !== 'claude-code') return { ...tool, name: wireName }
  if (wireName === 'Edit') {
    return {
      ...tool,
      name: wireName,
      description:
        'Edit an existing file with one exact, unique replacement. Use file_path, old_string and new_string. For multiple replacements, call Edit again.',
      input_schema: CLAUDE_CODE_EDIT_SCHEMA,
    }
  }
  if (wireName === 'Bash') {
    const schema = tool.input_schema ?? {}
    const properties = schema.properties ?? {}
    const { timeoutMs, workdir, sandbox_permissions, justification, ...kept } = properties
    return {
      ...tool,
      name: wireName,
      input_schema: {
        ...schema,
        additionalProperties: false,
        properties: {
          ...kept,
          ...(timeoutMs === undefined
            ? {}
            : { timeout: { type: 'number', description: 'Timeout in milliseconds.' } }),
        },
      },
    }
  }
  if (wireName === 'Grep') {
    const description = tool.description ?? 'Search file contents.'
    return {
      ...tool,
      name: wireName,
      description: description.includes(GREP_BEHAVIOR) ? description : `${description} ${GREP_BEHAVIOR}`,
    }
  }
  return { ...tool, name: wireName }
}

/** Tool-call arguments as the gateway expects them (harness -> wire). */
function toWireArguments(wireName, input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input
  if (wireName === 'Bash' && typeof input.timeoutMs === 'number') {
    const { timeoutMs, ...rest } = input
    return { ...rest, timeout: timeoutMs }
  }
  return input
}

/**
 * Tool-call arguments as the harness expects them (wire -> harness). Only the
 * keys whose spelling differs are rewritten; everything else is preserved so a
 * newer harness parameter still reaches its tool.
 * @param {string} harnessName - harness tool name.
 * @param {object} input - parsed wire arguments.
 * @returns {object} harness arguments.
 */
export function toHarnessArguments(harnessName, input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input
  if (harnessName === 'bash' && typeof input.timeout === 'number') {
    const { timeout, ...rest } = input
    return { ...rest, timeoutMs: timeout }
  }
  return input
}

/** Rewrite `tool_use` history so declarations and history always agree. */
function mapHistoryMessage(message, compat) {
  if (!message || typeof message !== 'object') return message
  if (typeof message.content === 'string') return message
  if (!Array.isArray(message.content)) return message
  let changed = false
  const content = message.content.map((block) => {
    if (!block || block.type !== 'tool_use' || typeof block.name !== 'string') return block
    const wireName = requestToolName(block.name, compat)
    changed = true
    return {
      ...block,
      name: wireName,
      ...(block.input === undefined ? {} : { input: toWireArguments(wireName, block.input) }),
    }
  })
  return changed ? { ...message, content } : message
}

/**
 * Apply the Claude Code compatibility transform to one assembled request body.
 *
 * Enablement mirrors pi: only an `anthropic-messages` Claude request whose wire
 * model equals the selected model is transformed. The body is treated as
 * immutable: a changed body is returned, an untouched one returns `undefined`
 * so pi-ai keeps its original payload.
 *
 * @param {unknown} payload - request body assembled by pi-ai.
 * @param {{
 *   model: string,
 *   sessionId?: string,
 *   deviceId?: string,
 *   disableThinking?: boolean,
 *   compat: {
 *     mode: string,
 *     identityBlocks?: boolean,
 *     metadataUserId?: boolean,
 *     toolSchema?: string,
 *     unknownToolPrefix?: string,
 *   },
 * }} context - transform inputs resolved for this one request.
 * @returns {object | undefined} transformed payload, or undefined to leave it unchanged.
 */
export function applyPayload(payload, context) {
  const { compat, model } = context
  if (compat.mode !== 'auto') return undefined
  if (!model.startsWith('claude-')) return undefined
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  if (payload.model !== model) return undefined

  const next = { ...payload }

  if (compat.identityBlocks !== false) {
    const system =
      typeof payload.system === 'string'
        ? [{ type: 'text', text: payload.system }]
        : Array.isArray(payload.system)
          ? payload.system
          : []
    // Drop earlier identity blocks so a retry or a second pass cannot stack them.
    const kept = system.filter(
      (block) => !(block && block.type === 'text' && IDENTITY_TEXTS.includes(block.text)),
    )
    next.system = [...IDENTITY_TEXTS.map((text) => ({ type: 'text', text })), ...kept]
  }

  if (Array.isArray(payload.tools)) {
    next.tools = payload.tools.map((tool) => {
      const wireName = requestToolName(tool.name, compat)
      return toolForProvider(tool, wireName, compat)
    })
  }

  if (Array.isArray(payload.messages)) {
    next.messages = payload.messages.map((message) => mapHistoryMessage(message, compat))
  }

  if (compat.metadataUserId !== false) {
    const userId = JSON.stringify({
      device_id: context.deviceId ?? '',
      account_uuid: '',
      session_id: context.sessionId ?? '',
    })
    next.metadata = { ...(payload.metadata ?? {}), user_id: userId }
  }

  if (context.disableThinking) next.thinking = { type: 'disabled' }

  return next
}
