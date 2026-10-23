/**
 * One Claude stream at the provider boundary.
 *
 * This is the code path the interceptor runs instead of the owning provider
 * plugin's stream, so it must reproduce that route's facts exactly:
 *   - the endpoint and credential reference come from the route profile;
 *   - auth is resolved per request through the credentials seam;
 *   - the Claude Code transform runs in pi-ai's `onPayload`;
 *   - the response is translated back into harness chunks.
 *
 * Nothing here registers a provider route or reads plugin configuration that
 * belongs to another plugin.
 *
 * @module dsh-llm-claude/claude-stream
 */

import { LlmError, attributionHeaders, isContextWindowExceededError } from '@deepseek-ai/dsh-llm'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { getSupportedThinkingLevels, normalizeContext } from '@earendil-works/pi-ai'
import { applyPayload } from './compat.js'
import { toPiContext } from './context.js'
import { toStreamChunks } from './stream.js'

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** Build pi-ai's model descriptor from one route catalog entry. */
export function toPiModel(conn, entry, compat) {
  const reasoningMode = entry.reasoning === false ? 'off' : compat.thinkingMode === 'off' ? 'off' : entry.reasoning === true ? 'adaptive' : entry.reasoning
  return {
    id: entry.id,
    name: entry.name,
    api: 'anthropic-messages',
    provider: conn.provider,
    baseUrl: conn.baseURL,
    input: entry.inputModalities,
    cost: NO_COST,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    reasoning: reasoningMode !== 'off',
    compat: {
      forceAdaptiveThinking: reasoningMode === 'adaptive',
      supportsTemperature: entry.supportsTemperature,
      supportsStrictTools: entry.supportsStrictTools,
      supportsEagerToolInputStreaming: true,
      allowEmptySignature: false,
    },
  }
}

/** Resolve the wire-level reasoning level for one request. */
export function resolveEffort(requested, conn, piModel, compat, fallbackEffort) {
  const supported = getSupportedThinkingLevels(piModel)
  if (requested !== undefined) {
    if (requested === 'off') return { effort: undefined, disableThinking: true }
    if (!supported.includes(requested)) {
      throw new LlmError(
        `llm-claude: route "${conn.provider}" model "${piModel.id}" does not support reasoning effort "${requested}"`,
        'UNSUPPORTED_REASONING_EFFORT',
      )
    }
    return { effort: requested, disableThinking: false }
  }
  if (compat.thinkingMode === 'off') return { effort: undefined, disableThinking: true }
  const fallback = fallbackEffort
  return {
    effort: fallback !== undefined && supported.includes(fallback) ? fallback : undefined,
    disableThinking: false,
  }
}

/** The wire identity: the gateway's claude-cli form, or the harness attribution. */
export function buildIdentity(compat) {
  return {
    userAgent: { custom: compat.mode === 'auto' ? compat.userAgent : attributionHeaders()['user-agent'] },
    attribution: null,
  }
}

/** Merge route headers, compat headers, auth and the attribution marker. */
export function buildHeaders(conn, compat, auth) {
  const headers = { ...conn.headers, ...compat.headers, ...auth.headers }
  if (compat.mode === 'auto') {
    // Deliberate deviation from the harness attribution contract: the gateway
    // requires the claude-cli User-Agent, so the harness identity travels in a
    // separate header (see DESIGN.md §9.4).
    headers['x-dsh-attribution'] = attributionHeaders()['user-agent']
  }
  return headers
}

function abortPromise(signal) {
  if (signal === undefined) return { promise: new Promise(() => {}), dispose: () => {} }
  let onAbort
  const promise = new Promise((_, reject) => {
    onAbort = () => reject(new LlmError('llm-claude request aborted by caller', 'ABORTED'))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  promise.catch(() => {})
  return { promise, dispose: () => signal.removeEventListener('abort', onAbort) }
}

async function* withIdleTimeout(events, timeoutMs, signal) {
  if (signal?.aborted === true) throw new LlmError('llm-claude request aborted by caller', 'ABORTED')
  const iterator = events[Symbol.asyncIterator]()
  const aborted = abortPromise(signal)
  try {
    while (true) {
      let timer
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new LlmError(`llm-claude stream idle for more than ${timeoutMs}ms`, 'TIMEOUT')),
          timeoutMs,
        )
        timer.unref?.()
      })
      try {
        const next = await Promise.race([iterator.next(), timeout, aborted.promise])
        if (next.done === true) return
        yield next.value
      } finally {
        clearTimeout(timer)
      }
    }
  } finally {
    aborted.dispose()
    iterator.return?.().catch?.(() => {})
  }
}

/**
 * Stream one Claude request through pi-ai with the compat transform applied.
 *
 * @param {object} options - harness `GenerateOptions`.
 * @param {object} conn - resolved route facts from `routes.js`.
 * @param {object} entry - catalog entry for `options.model`.
 * @param {object} compat - resolved interceptor options.
 * @param {{apiKey?: string, headers?: Record<string, string>}} auth - resolved credential.
 * @param {{
 *   attachments?: object,
 *   deviceId?: () => string,
 *   maxRequestImagesBytes?: number,
 *   onReplayDegrade?: (reason: string) => void,
 * }} deps - request-scoped services.
 * @returns {AsyncGenerator<object>} harness chunks.
 */
export async function* streamClaude(options, conn, entry, compat, auth, deps) {
  const piModel = toPiModel(conn, entry, compat)
  // Auxiliary calls (session title, compaction) must not acquire thinking just
  // because the route has a default effort.
  const fallbackEffort = options.purpose === undefined ? conn.reasoningEffort : undefined
  const { effort, disableThinking } = resolveEffort(options.reasoningEffort, conn, piModel, compat, fallbackEffort)
  const { context } = await toPiContext(options, {
    attachments: deps.attachments,
    maxRequestImagesBytes: deps.maxRequestImagesBytes ?? 20971520,
    onReplayDegrade: deps.onReplayDegrade,
  })
  const temperature =
    options.temperature !== undefined && effort === undefined && entry.supportsTemperature
      ? options.temperature
      : undefined

  const consumer = new AbortController()
  const signal = options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal])
  const api = anthropicMessagesApi()
  const events = api.streamSimple(piModel, normalizeContext(context), {
    ...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
    headers: buildHeaders(conn, compat, auth),
    identity: buildIdentity(compat),
    ...(effort === undefined ? {} : { reasoning: effort }),
    ...(temperature === undefined ? {} : { temperature }),
    maxTokens: options.maxTokens ?? entry.maxTokens,
    cacheRetention: conn.cacheRetention ?? 'short',
    ...(options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) }),
    signal,
    timeoutMs: conn.streamIdleTimeoutMs,
    maxRetries: 0,
    onPayload: (payload) =>
      applyPayload(payload, {
        model: options.model,
        sessionId: options.sessionId === undefined ? undefined : String(options.sessionId),
        deviceId: deps.deviceId?.(),
        disableThinking,
        compat,
      }),
  })

  try {
    yield* toStreamChunks(withIdleTimeout(events, conn.streamIdleTimeoutMs, signal), {
      callerSignal: options.signal,
      requestedModel: options.model,
      compat,
    })
  } catch (error) {
    if (isContextWindowExceededError(error instanceof Error ? error.message : String(error))) {
      throw new LlmError('llm-claude context window exceeded', 'CONTEXT_WINDOW_EXCEEDED', { cause: error })
    }
    throw error
  } finally {
    consumer.abort('llm-claude stream consumer stopped')
  }
}
