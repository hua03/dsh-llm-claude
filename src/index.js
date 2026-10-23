/**
 * Cordis entry point for the Claude provider plugin.
 *
 * One plugin instance owns exactly one provider route. Mount it once per
 * gateway with a distinct entry id and `provider` value; route names must not
 * collide (`DUPLICATE_ADAPTER`) but may serve the same model ids as another
 * adapter.
 *
 * @module dsh-llm-claude
 */

import { LlmError, assertUsableApiKey } from '@deepseek-ai/dsh-llm'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { ClaudeAdapter } from './adapter.js'
import { Config, plainOptions, resolveAdapterOptions } from './config.js'

export const name = 'llm-claude'
/** `llm` is required; credentials/attachments are soft services resolved per operation. */
export const inject = ['llm']
export { Config }

function sameRetryPolicy(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Resolve one credential reference, falling back to the launch environment. */
async function resolveCredential(ctx, ref) {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined && credentials !== null) return credentials.resolve(ref)
  const value = process.env[ref]
  return value === undefined || value === '' ? undefined : { value, source: 'env' }
}

export function apply(ctx, config) {
  const provider = config.provider
  // Validate once at load: a bad endpoint, catalog, or compat mode fails here
  // instead of on the first user turn.
  const initial = resolveAdapterOptions(plainOptions(config))

  const adapter = new ClaudeAdapter({
    options: () => resolveAdapterOptions(plainOptions(config)),
    resolveAuth: async (conn) => {
      const resolved = await resolveCredential(ctx, conn.apiKeyEnv)
      if (resolved === undefined) {
        throw new LlmError(`llm-claude: credential ${conn.apiKeyEnv} is not set`, 'MISSING_CREDENTIAL')
      }
      const key = assertUsableApiKey(resolved.value, 'llm-claude', conn.apiKeyEnv)
      return conn.authHeader === 'authorization-bearer'
        ? { headers: { authorization: `Bearer ${key}` } }
        : { apiKey: key }
    },
    resolveAttachments: () => ctx.get('attachments'),
    deviceId: () => String(getOrCreateAnonymousUserId()),
    onReplayDegrade: (detail) => {
      ctx.logger?.warn?.('llm-claude degrade replay state', detail)
    },
  })

  const handle = ctx.llm.registerAdapter([provider], adapter)

  // The retry policy is captured at registration, so a volatile edit that
  // changes it must re-register the same adapter atomically.
  let lastRetryPolicy = initial.retryPolicy
  ctx.on?.('loader/volatile-update', () => {
    const next = resolveAdapterOptions(plainOptions(config)).retryPolicy
    if (sameRetryPolicy(lastRetryPolicy, next)) return
    lastRetryPolicy = next
    handle.replace([provider])
  })
}
