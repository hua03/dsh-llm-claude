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
 * Whether this request is auto-review's internal reviewer call. Choosing the
 * reviewer model belongs to a dedicated plugin (`@huahao/dsh-auto-review-model`);
 * this plugin only declines to disguise it, because the reviewer must emit one
 * strict JSON object and a coding-agent persona prompt breaks that protocol.
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

  return function intercept(options, next) {
    // The reviewer's JSON protocol is not a conversation; leave it to the
    // dedicated reviewer-model plugin (or the owning adapter).
    if (isReviewRequest(options)) return next()
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
