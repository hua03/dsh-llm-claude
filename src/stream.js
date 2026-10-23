/**
 * pi-ai assistant events -> harness `StreamChunk` stream.
 *
 * pi-ai reports failures as terminal `error` events instead of throwing, and
 * carries parsed tool-call arguments where the harness keeps the raw JSON
 * string. This module is the only place those two vocabularies meet, and it is
 * also where Claude Code tool names/arguments are converted back to the
 * harness spelling before the agent loop executes a tool.
 *
 * Contract: emit `usage` before the single terminal `finish`, and nothing
 * after it.
 *
 * @module dsh-llm-claude/stream
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  LlmError,
  isContextWindowExceededError,
} from '@deepseek-ai/dsh-llm'
import { classifyProviderError } from './errors.js'
import { buildReplayState } from './replay.js'
import { responseToolName, toHarnessArguments } from './compat.js'

/** Map pi-ai usage; harness counts are disjoint, pi-ai already separates cache. */
function mapUsage(usage) {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    ...(usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {}),
    ...(usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}),
    ...(usage.reasoning === undefined ? {} : { reasoningTokens: usage.reasoning }),
  }
}

/** Map one terminal pi-ai message to the harness finish reason. */
function mapStopReason(message) {
  if (message.stopReason === 'error' && message.errorMessage !== undefined) {
    if (isContextWindowExceededError(message.errorMessage)) {
      return {
        kind: 'error',
        failure: { message: message.errorMessage, code: CONTEXT_WINDOW_EXCEEDED_CODE },
      }
    }
  }
  switch (message.stopReason) {
    case 'stop':
      if (message.content.length === 0) {
        return {
          kind: 'error',
          failure: {
            message: `model "${message.model}" returned a completed response with no content`,
            code: EMPTY_RESPONSE_CODE,
          },
        }
      }
      return { kind: 'stop' }
    case 'length':
      return { kind: 'max-tokens' }
    case 'toolUse':
      return { kind: 'tool-calls' }
    case 'aborted':
      return { kind: 'aborted', failure: { message: message.errorMessage ?? 'request aborted', code: 'ABORTED' } }
    case 'pending':
    case 'deferred':
      return {
        kind: 'error',
        failure: {
          message: `pi-ai stream ended ${message.stopReason} for model "${message.model}"`,
          code: 'PROVIDER_ERROR',
        },
      }
    default: {
      const text = message.errorMessage ?? 'provider stream error'
      return { kind: 'error', failure: { message: text, code: classifyProviderError(text) } }
    }
  }
}

/**
 * Translate one pi-ai assistant event stream into harness chunks.
 * @param {AsyncIterable<object>} events - pi-ai `AssistantMessageEvent` stream.
 * @param {{
 *   callerSignal?: AbortSignal,
 *   requestedModel: string,
 *   compat: object,
 * }} options - translation inputs.
 * @returns {AsyncGenerator<object>} harness chunks.
 */
export async function* toStreamChunks(events, options) {
  const { callerSignal, requestedModel, compat } = options
  const toolState = new Map()

  for await (const event of events) {
    switch (event.type) {
      case 'start':
        break
      case 'text_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
        break
      case 'text_delta':
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
        break
      case 'text_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
        break
      case 'thinking_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
        break
      case 'thinking_delta':
        yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
        break
      case 'thinking_end':
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: { type: 'reasoning', text: event.content },
        }
        break
      case 'toolcall_start': {
        const partial = event.partial.content[event.contentIndex]
        const id = partial?.type === 'toolCall' ? partial.id : ''
        const wireName = partial?.type === 'toolCall' ? partial.name : ''
        toolState.set(event.contentIndex, { id, name: responseToolName(wireName, compat) })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
        break
      }
      case 'toolcall_delta': {
        const known = toolState.get(event.contentIndex)
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          id: known?.id ?? '',
          ...(known?.name === undefined || known.name.length === 0 ? {} : { name: known.name }),
          argumentsDelta: event.delta,
        }
        break
      }
      case 'toolcall_end': {
        const harnessName = responseToolName(event.toolCall.name, compat)
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: {
            type: 'tool-call',
            id: event.toolCall.id,
            name: harnessName,
            arguments: JSON.stringify(toHarnessArguments(harnessName, event.toolCall.arguments)),
          },
        }
        break
      }
      case 'done':
        yield { type: 'usage', usage: mapUsage(event.message.usage) }
        yield {
          type: 'finish',
          reason: mapStopReason(event.message),
          replayState: buildReplayState(event.message, requestedModel),
        }
        return
      case 'error': {
        const message = callerSignal?.aborted
          ? { ...event.error, stopReason: 'aborted' }
          : event.error
        yield { type: 'usage', usage: mapUsage(message.usage) }
        yield { type: 'finish', reason: mapStopReason(message) }
        return
      }
      default:
        // Unknown pi-ai events are additive; ignoring them keeps a pi-ai minor
        // upgrade from breaking an otherwise usable stream.
        break
    }
  }
  throw new LlmError('pi-ai event stream ended without done/error', 'STREAM_CLOSED')
}
