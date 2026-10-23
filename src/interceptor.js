/**
 * Conditional interceptor over the harness LLM waterfall.
 *
 * It reuses the provider route DSH already configured: no route, credential,
 * model catalog, or gateway setting is duplicated here. A request is taken over
 * only when all of these hold:
 *   - `config.enabled` is true;
 *   - the model id starts with `claude-`;
 *   - the provider route is configured with `api: anthropic-messages`;
 *   - the route config describes its models and credential reference, and the
 *     credential resolves.
 *
 * Everything else — other protocols, other model ids, unconfigured routes,
 * routes without a reusable credential — falls through to the owning plugin's
 * stream unchanged.
 *
 * @module dsh-llm-claude/interceptor
 */

import { assertUsableApiKey } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { findProviderRoute } from './routes.js'
import { streamClaude } from './claude-stream.js'

/** Resolve one credential reference through the harness seam, then the launch env. */
async function resolveCredential(ctx, ref) {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined && credentials !== null) return credentials.resolve(credentialRef(ref))
  const value = process.env[ref]
  return value === undefined || value === '' ? undefined : { value }
}

/** The fixed opening of auto-review's REVIEW_POLICY system prompt. */
const REVIEW_MARKER = 'REVIEW_POLICY\n'

/**
 * Whether this request is auto-review's internal reviewer call. Auto-review
 * hard-codes the session route, so a Claude gateway that only accepts Claude
 * Code clients rejects its reviewer; detect it structurally (fixed policy prompt,
 * no tool declarations) and reroute it to a plain API model instead.
 */
function isReviewRequest(options) {
  return (
    typeof options.system === 'string' &&
    options.system.startsWith(REVIEW_MARKER) &&
    options.tools === undefined
  )
}

/** Whether this request is one the compat transform must take over. */
function shouldIntercept(options, config) {
  if (!config.enabled) return false
  if (typeof options.model !== 'string' || !options.model.startsWith('claude-')) return false
  if (config.excludeProviders.includes(options.provider)) return false
  if (config.includeProviders.length > 0 && !config.includeProviders.includes(options.provider)) return false
  return true
}

/**
 * Build the `llm/stream` waterfall listener.
 *
 * @param {object} ctx - plugin context (`loader`, `credentials`, `attachments`, logger).
 * @param {object} config - resolved interceptor options.
 * @returns {(options: object, next: () => AsyncIterable<object>) => AsyncIterable<object>}
 */
export function createInterceptor(ctx, config) {
  let warned = false
  function warnOnce(message) {
    if (warned) return
    warned = true
    ctx.logger?.warn?.(message)
  }

  /** Send one reviewer request to the configured plain-API model. */
  function reviewRoute(options, next) {
    const review = config.review
    if (!review.enabled) return next()
    if (options.provider === review.provider && options.model === review.model) return next()
    const providers = ctx.llm?.listProviders?.()
    if (Array.isArray(providers) && !providers.some((provider) => provider.id === review.provider)) {
      warnOnce(`llm-claude: review provider "${review.provider}" is not registered; reviewer stays on the session route`)
      return next()
    }
    if (config.debug) ctx.logger?.info?.(`llm-claude: review -> ${review.provider}/${review.model}`)
    return ctx.llm.stream({
      ...options,
      provider: review.provider,
      model: review.model,
      ...(review.reasoningEffort === undefined ? {} : { reasoningEffort: review.reasoningEffort }),
    })
  }

  return function intercept(options, next) {
    if (isReviewRequest(options)) return reviewRoute(options, next)
    if (!shouldIntercept(options, config)) return next()
    const route = findProviderRoute(ctx, options.provider)
    if (route === undefined) return next()
    const connection = route.connection
    if (connection.apiKeyEnv === undefined) {
      // The owning plugin may use its own ambient auth (login, OAuth). Do not
      // pretend to reproduce it: leave the request alone.
      warnOnce(`llm-claude: route "${options.provider}" declares no apiKeyEnv; requests stay on the owning plugin`)
      return next()
    }
    const entry = connection.models.find((model) => model.id === options.model)
    if (entry === undefined) return next()

    return (async function* () {
      const resolved = await resolveCredential(ctx, connection.apiKeyEnv)
      if (resolved === undefined) {
        // Let the owning plugin produce its own missing-credential diagnosis.
        yield* next()
        return
      }
      const apiKey = assertUsableApiKey(resolved.value, 'llm-claude', connection.apiKeyEnv)
      if (config.debug) ctx.logger?.info?.(`llm-claude: intercepting ${options.provider}/${options.model}`)
      yield* streamClaude(options, connection, entry, config.compat, { apiKey }, {
        attachments: ctx.get('attachments'),
        deviceId: config.deviceId,
        maxRequestImagesBytes: config.maxRequestImagesBytes,
        onReplayDegrade: (reason) =>
          ctx.logger?.warn?.(`llm-claude: replay state degraded (${options.provider}/${options.model}): ${reason}`),
      })
    })()
  }
}
