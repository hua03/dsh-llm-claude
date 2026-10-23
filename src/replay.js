/**
 * Adapter-private replay state for Claude thinking signatures.
 *
 * Anthropic requires a `thinking` block and its `signature` to travel back
 * unchanged on later turns of the same model. The harness stores adapter-owned
 * metadata beside durable content and hands it back only to the adapter that
 * produced it, so this module owns both directions:
 *   - `buildReplayState(message)` records one entry per emitted content block;
 *   - `toPiAssistant(message)` rebuilds pi-ai's assistant vocabulary from the
 *     durable content, restoring signatures when the state is still usable and
 *     degrading to provider-neutral history when it is not.
 *
 * A signature is only valid for the model that produced it; a provider/model
 * mismatch, another adapter's state, or a block-count mismatch discards the
 * whole envelope rather than sending a stale signature (Anthropic answers 400).
 *
 * @module dsh-llm-claude/replay
 */

const REPLAY_KIND = 'dsh-claude'
const REPLAY_VERSION = 1

const VALID_STOP_REASONS = new Set(['stop', 'length', 'toolUse', 'error', 'aborted'])

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

function parseArguments(raw) {
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Record one assistant response for later replay.
 * @param {object} message - pi-ai assistant message carried by the terminal event.
 * @param {string} requestedModel - harness model id this request named.
 * @returns {{response: object, blocks: object[]}} replay envelope.
 */
export function buildReplayState(message, requestedModel) {
  const blocks = message.content.map((block) => {
    if (block.type === 'text') return { type: 'text' }
    if (block.type === 'thinking') {
      return {
        type: 'reasoning',
        ...(block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature }),
        ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
      }
    }
    if (block.type === 'toolCall') {
      return {
        type: 'tool-call',
        ...(block.thoughtSignature === undefined ? {} : { thoughtSignature: block.thoughtSignature }),
      }
    }
    return null
  })
  return {
    response: {
      kind: REPLAY_KIND,
      version: REPLAY_VERSION,
      api: message.api,
      provider: message.provider,
      model: message.model,
      requestedModel,
      ...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
      ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
      stopReason: message.stopReason,
    },
    blocks,
  }
}

/**
 * Validate one stored envelope for this exact message. Any mismatch returns
 * undefined and the caller degrades to provider-neutral history.
 */
function readReplayState(value, source) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const response = value.response
  if (response === null || typeof response !== 'object' || Array.isArray(response)) return undefined
  if (response.kind !== REPLAY_KIND || response.version !== REPLAY_VERSION) return undefined
  if (response.provider !== source.provider || response.model !== source.model) return undefined
  if (typeof response.api !== 'string' || response.api.length === 0) return undefined
  if (!VALID_STOP_REASONS.has(response.stopReason)) return undefined
  if (!Array.isArray(value.blocks)) return undefined
  for (const block of value.blocks) {
    if (block === null) continue
    if (typeof block !== 'object' || Array.isArray(block)) return undefined
    if (!['text', 'reasoning', 'tool-call'].includes(block.type)) return undefined
    for (const key of ['thinkingSignature', 'thoughtSignature']) {
      if (block[key] !== undefined && typeof block[key] !== 'string') return undefined
    }
    if (block.redacted !== undefined && typeof block.redacted !== 'boolean') return undefined
  }
  return { response, blocks: value.blocks }
}

/** Provider-neutral history: durable content only, no native signatures. */
function foreignAssistant(message) {
  const content = []
  for (const block of message.content) {
    if (block.type === 'text') content.push({ type: 'text', text: block.text })
    else if (block.type === 'reasoning') content.push({ type: 'thinking', thinking: block.text })
    else if (block.type === 'tool-call') {
      content.push({
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: parseArguments(block.arguments),
      })
    }
  }
  return {
    role: 'assistant',
    content,
    api: 'dsh-foreign',
    provider: message.source.provider,
    model: message.source.model,
    usage: emptyUsage(),
    stopReason: content.some((piece) => piece.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: 0,
  }
}

/**
 * Convert one durable harness assistant message into pi-ai history.
 * @param {object} message - harness assistant message (with `source`).
 * @param {(reason: string) => void} onDegrade - diagnostic sink.
 * @returns {object} pi-ai assistant message.
 */
export function toPiAssistant(message, onDegrade) {
  const source = message.source
  if (source.replayState === undefined) return foreignAssistant(message)
  const state = readReplayState(source.replayState, source)
  if (state === undefined) {
    onDegrade?.('unusable replay state')
    return foreignAssistant(message)
  }
  if (state.blocks.length !== message.content.length) {
    onDegrade?.('replay block count does not match durable content')
    return foreignAssistant(message)
  }
  const content = []
  for (const [index, block] of message.content.entries()) {
    const replay = state.blocks[index]
    if (replay === null || replay === undefined || replay.type !== block.type) {
      onDegrade?.(`block ${index} does not match durable content`)
      return foreignAssistant(message)
    }
    if (block.type === 'text') content.push({ type: 'text', text: block.text })
    else if (block.type === 'reasoning') {
      content.push({
        type: 'thinking',
        thinking: block.text,
        ...(replay.thinkingSignature === undefined ? {} : { thinkingSignature: replay.thinkingSignature }),
        ...(replay.redacted === undefined ? {} : { redacted: replay.redacted }),
      })
    } else if (block.type === 'tool-call') {
      content.push({
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: parseArguments(block.arguments),
        ...(replay.thoughtSignature === undefined ? {} : { thoughtSignature: replay.thoughtSignature }),
      })
    }
  }
  return {
    role: 'assistant',
    content,
    api: state.response.api,
    provider: state.response.provider,
    model: state.response.model,
    ...(state.response.responseModel === undefined ? {} : { responseModel: state.response.responseModel }),
    ...(state.response.responseId === undefined ? {} : { responseId: state.response.responseId }),
    usage: emptyUsage(),
    stopReason: state.response.stopReason,
    timestamp: 0,
  }
}
