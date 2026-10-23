/**
 * pi-ai-backed Claude adapter for the harness LLM seam.
 *
 * Layering: the harness runtime owns routing, retry, timeout normalisation,
 * chunk assembly, session persistence, tool projection and replay isolation.
 * This adapter owns the provider boundary only:
 *   - harness vocabulary -> pi-ai context (`context.js`),
 *   - auth headers / UA / beta headers,
 *   - the Claude Code payload transform (`compat.js`) via pi-ai's `onPayload`,
 *   - pi-ai events -> harness chunks (`stream.js`).
 *
 * Pi-ai itself performs the HTTP request, SSE parsing, thinking/effort encoding
 * and prompt-cache markers, which is the same implementation the pi coding
 * agent uses.
 *
 * @module dsh-llm-claude/adapter
 */

import { LlmAdapter, LlmError, attributionHeaders, isContextWindowExceededError } from '@deepseek-ai/dsh-llm'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { getSupportedThinkingLevels, normalizeContext } from '@earendil-works/pi-ai'
import { applyPayload } from './compat.js'
import { toPiContext } from './context.js'
import { toStreamChunks } from './stream.js'

/** Zero-cost metadata: the harness never reads spend from this adapter. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

function unlistedModel(conn, model) {
  return {
    id: model,
    name: model,
    contextWindow: conn.defaultContextWindow,
    maxTokens: conn.maxTokens,
    inputModalities: ['text'],
    reasoning: false,
    supportsTemperature: true,
    supportsStrictTools: false,
  }
}

function modelEntry(conn, model) {
  return conn.modelsById.get(model) ?? unlistedModel(conn, model)
}

/**
 * Build pi-ai's model descriptor for one route/model pair. pi-ai reads the
 * endpoint, modalities, thinking ability and Anthropic compatibility switches
 * from this object; nothing here performs I/O.
 */
function toPiModel(conn, entry) {
  const reasoningMode =
    conn.thinkingMode === 'off' || entry.reasoning === false
      ? 'off'
      : conn.thinkingMode === 'auto'
        ? entry.reasoning
        : conn.thinkingMode
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
function resolveEffort(requested, conn, piModel) {
  const supported = getSupportedThinkingLevels(piModel)
  if (requested !== undefined) {
    if (requested === 'off') return { effort: undefined, disableThinking: true }
    if (!supported.includes(requested)) {
      throw new LlmError(
        `llm-claude provider "${conn.provider}" model "${piModel.id}" does not support reasoning effort "${requested}"`,
        'UNSUPPORTED_REASONING_EFFORT',
      )
    }
    return { effort: requested, disableThinking: false }
  }
  if (conn.thinkingMode === 'off' || conn.reasoningEffort === 'off') {
    return { effort: undefined, disableThinking: true }
  }
  return {
    effort: supported.includes(conn.reasoningEffort) ? conn.reasoningEffort : undefined,
    disableThinking: false,
  }
}

/** Pick the wire identity: the gateway's claude-cli form or the harness attribution. */
function buildIdentity(conn) {
  const harnessUserAgent = attributionHeaders()['user-agent']
  return {
    userAgent: { custom: conn.compat.mode === 'auto' ? conn.compat.userAgent : harnessUserAgent },
    attribution: null,
  }
}

/** Merge provider headers with the Claude Code identity and route beta list. */
function buildHeaders(conn, auth) {
  const headers = {
    ...conn.compat.headers,
    ...auth.headers,
  }
  if (conn.compat.mode === 'auto') {
    // Deliberate deviation from the harness attribution contract: the gateway
    // requires the claude-cli User-Agent, so the harness identity travels in a
    // separate header instead of replacing it (see DESIGN.md §9.4).
    headers['x-dsh-attribution'] = attributionHeaders()['user-agent']
  }
  if (conn.anthropicBeta.length > 0) headers['anthropic-beta'] = conn.anthropicBeta.join(',')
  return headers
}

/** One terminal idle timeout and cancellation promise around a pi-ai event iterator. */
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

export class ClaudeAdapter extends LlmAdapter {
  /**
   * @param {{
   *   options: () => object,
   *   resolveAuth: (conn: object) => Promise<{apiKey?: string, headers?: Record<string, string>}>,
   *   resolveAttachments?: () => object | undefined,
   *   deviceId?: () => string,
   *   onReplayDegrade?: (detail: {provider: string, model: string, reason: string}) => void,
   * }} dependencies - operation-local resolution hooks owned by the plugin.
   */
  constructor(dependencies) {
    super()
    this.dependencies = dependencies
    this.api = anthropicMessagesApi()
  }

  providerInfo(provider) {
    return { id: provider, name: this.dependencies.options().displayName }
  }

  providerRetryPolicy() {
    return this.dependencies.options().retryPolicy
  }

  async listModels(provider) {
    const conn = this.dependencies.options()
    return conn.models.map((entry) => ({
      provider,
      id: entry.id,
      name: entry.name,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      inputModalities: entry.inputModalities,
    }))
  }

  async resolveModel(provider, model) {
    const conn = this.dependencies.options()
    const entry = modelEntry(conn, model)
    const piModel = toPiModel(conn, entry)
    const supported = getSupportedThinkingLevels(piModel)
    const efforts = supported
      .filter((level) => level !== 'off')
      .map((level) => ({ id: level, name: `${level.charAt(0).toUpperCase()}${level.slice(1)}` }))
    const defaultEffort = efforts.some((effort) => effort.id === conn.reasoningEffort)
      ? conn.reasoningEffort
      : undefined
    return {
      provider,
      id: entry.id,
      name: entry.name,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      inputModalities: entry.inputModalities,
      context: { contextWindow: entry.contextWindow },
      defaultMaxTokens: entry.maxTokens,
      ...(efforts.length === 0
        ? {}
        : { reasoning: { efforts, ...(defaultEffort === undefined ? {} : { defaultEffort }) } }),
    }
  }

  async prepareCall(provider, model) {
    // Capture this generation's connection facts and model metadata together so
    // a settings change between preparation and dispatch cannot mix generations.
    const conn = this.dependencies.options()
    const info = await this.resolveModel(provider, model)
    return { model: info, stream: (options) => this.streamWith(conn, provider, model, options) }
  }

  async *stream(options) {
    yield* this.streamWith(this.dependencies.options(), options.provider, options.model, options)
  }

  async *streamWith(conn, provider, model, options) {
    const entry = modelEntry(conn, model)
    const piModel = toPiModel(conn, entry)
    const { effort, disableThinking } = resolveEffort(options.reasoningEffort, conn, piModel)
    const auth = await this.dependencies.resolveAuth(conn)
    const { context } = await toPiContext(options, {
      attachments: this.dependencies.resolveAttachments?.(),
      maxRequestImagesBytes: conn.maxRequestImagesBytes,
      onReplayDegrade: (reason) =>
        this.dependencies.onReplayDegrade?.({ provider, model, reason }),
    })

    const maxTokens = options.maxTokens ?? entry.maxTokens ?? conn.maxTokens
    const temperature =
      options.temperature !== undefined && effort === undefined && entry.supportsTemperature
        ? options.temperature
        : undefined

    const events = this.api.streamSimple(piModel, normalizeContext(context), {
      ...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
      headers: buildHeaders(conn, auth),
      identity: buildIdentity(conn),
      ...(effort === undefined ? {} : { reasoning: effort }),
      ...(temperature === undefined ? {} : { temperature }),
      maxTokens,
      ...(conn.cacheRetention === undefined ? {} : { cacheRetention: conn.cacheRetention }),
      ...(options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) }),
      signal: options.signal,
      timeoutMs: conn.streamIdleTimeoutMs,
      maxRetries: 0,
      onPayload: (payload) =>
        applyPayload(payload, {
          model,
          sessionId: options.sessionId === undefined ? undefined : String(options.sessionId),
          deviceId: this.dependencies.deviceId?.(),
          disableThinking,
          compat: conn.compat,
        }),
    })

    try {
      yield* toStreamChunks(withIdleTimeout(events, conn.streamIdleTimeoutMs, options.signal), {
        callerSignal: options.signal,
        requestedModel: model,
        compat: conn.compat,
      })
    } catch (error) {
      if (isContextWindowExceededError(error instanceof Error ? error.message : String(error))) {
        throw new LlmError('llm-claude context window exceeded', 'CONTEXT_WINDOW_EXCEEDED', { cause: error })
      }
      throw error
    }
  }
}
