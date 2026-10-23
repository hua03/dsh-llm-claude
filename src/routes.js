/**
 * Discover the provider route facts DSH already has configured.
 *
 * The interceptor deliberately owns no route and no credentials: it reads the
 * `providers` dict another provider plugin (in practice `dsh-llm-pi-ai`) was
 * configured with, so mounting this plugin changes no route, model, or secret.
 * Support is reported honestly: a route that cannot be described from that
 * config is not intercepted.
 *
 * @module dsh-llm-claude/routes
 */

const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
const DEFAULT_CONTEXT_WINDOW = 262144
const DEFAULT_MAX_TOKENS = 64000

/** True when the profile speaks the Anthropic Messages protocol. */
function isAnthropicMessages(profile) {
  return profile?.api === 'anthropic-messages'
}

/** Normalize one pi-ai model profile entry into the facts this adapter needs. */
function normalizeModel(provider, entry, routeProfile) {
  const compat = { ...(routeProfile.compat ?? {}), ...(entry.compat ?? {}) }
  return {
    id: entry.id,
    name: entry.name ?? entry.id,
    contextWindow: entry.contextWindow ?? routeProfile.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: entry.maxTokens ?? routeProfile.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
    inputModalities: entry.input ?? routeProfile.defaultInput ?? ['text', 'image'],
    reasoning:
      entry.reasoningEfforts === false
        ? false
        : compat.forceAdaptiveThinking === true
          ? 'adaptive'
          : true,
    supportsTemperature: compat.supportsTemperature !== false,
    supportsStrictTools: compat.supportsStrictTools === true,
  }
}

/**
 * Describe one existing provider route, or return undefined when DSH has no
 * configuration this interceptor could reuse faithfully.
 *
 * @param {object} ctx - plugin context; only `loader` is used.
 * @param {string} provider - provider route key from the request.
 * @returns {{entryId: string, profile: object, connection: object} | undefined}
 */
export function findProviderRoute(ctx, provider) {
  const loader = ctx.loader
  if (loader === undefined || typeof loader.entries !== 'function') return undefined
  for (const entry of loader.entries()) {
    const config = entry.options?.config
    const providers = config?.providers
    if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) continue
    const profile = providers[provider]
    if (profile === null || typeof profile !== 'object') continue
    if (!isAnthropicMessages(profile)) return undefined
    const models = Array.isArray(profile.models) ? profile.models : undefined
    // Without an explicit catalog there is no honest way to size or gate the
    // route, so leave it entirely to the plugin that owns it.
    if (models === undefined || models.length === 0) return undefined
    return {
      entryId: entry.options.id,
      profile,
      connection: {
        provider,
        baseURL: profile.baseURL ?? DEFAULT_ANTHROPIC_BASE_URL,
        apiKeyEnv: profile.apiKeyEnv,
        headers: { ...(profile.headers ?? {}) },
        cacheRetention: profile.cacheRetention ?? 'short',
        streamIdleTimeoutMs: profile.streamIdleTimeoutMs ?? 300000,
        // Reuse the route's own default effort; the harness default otherwise.
        reasoningEffort: profile.reasoning ?? 'high',
        models: models.map((model) => normalizeModel(provider, model, profile)),
      },
    }
  }
  return undefined
}
