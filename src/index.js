/**
 * Cordis entry point: a conditional Claude Code interceptor for the provider
 * routes DSH already has.
 *
 * The plugin registers no provider route and owns no credential. It listens on
 * the `llm/stream` waterfall and takes over only requests that are Claude
 * (`claude-*`) on an `anthropic-messages` route with a reusable credential;
 * every other request, model, and route continues to the owning plugin.
 *
 * @module dsh-llm-claude
 */

import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { Config, plainOptions, resolveInterceptOptions } from './config.js'
import { createInterceptor } from './interceptor.js'

export const name = 'llm-claude'
/** `llm` for the waterfall, `loader` to read the owning route's configuration. */
export const inject = ['llm', 'loader']
export { Config }

export function apply(ctx, config) {
  const resolved = resolveInterceptOptions(plainOptions(config))
  const handler = createInterceptor(ctx, {
    ...resolved,
    deviceId: () => String(getOrCreateAnonymousUserId()),
  })
  // Waterfall listener: returning an iterable replaces the owning plugin's stream.
  ctx.on('llm/stream', handler)
}
