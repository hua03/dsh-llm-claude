/**
 * Interceptor configuration.
 *
 * There is deliberately no endpoint, credential, or model catalog here: those
 * belong to the provider route DSH already has. This file only describes *when*
 * to take a request over and *how* to disguise it.
 *
 * @module dsh-llm-claude/config
 */

import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'

/** Schemastery schema consumed by the cordis loader and the settings page. */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile().description('Take over matching Claude requests.'),
  includeProviders: z
    .array(z.string())
    .default([])
    .description('Provider route keys to intercept; empty means every reusable anthropic-messages route.'),
  excludeProviders: z.array(z.string()).default([]).description('Provider route keys to leave alone.'),
  claudeCodeCompat: z
    .object({
      identityBlocks: z.boolean().default(true),
      userAgent: z.string().default('claude-cli/2.1.293 (external, cli)'),
      headers: z.dict(z.string()).default({ 'x-app': 'cli' }),
      metadataUserId: z.boolean().default(true),
      toolSchema: z.union(['names-only', 'claude-code']).default('names-only'),
      unknownToolPrefix: z.string().default('mcp__dsh__'),
      thinking: z.union(['auto', 'off']).default('auto'),
    })
    .default({})
    .volatile(),
  // Auto-review hard-codes the session route. A Claude Code-only gateway rejects
  // that reviewer, so reroute the reviewer to a plain API model.
  review: z
    .object({
      enabled: z.boolean().default(true),
      provider: z.string().default('deepseek-account'),
      model: z.string().default('deepseek-flash'),
      reasoningEffort: z.union(['off', 'low', 'high', 'max']).default('off'),
    })
    .default({})
    .volatile(),
  maxRequestImagesBytes: z.number().step(1).min(1).default(20971520),
  debug: z.boolean().default(false).volatile(),
})

/** Unwrap volatile references for the resolver. */
export function plainOptions(config) {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [key, isVolatile(value) ? value.get() : value]),
  )
}

function assertHeaders(headers) {
  for (const [name, value] of Object.entries(headers ?? {})) {
    try {
      new Headers([[name, value]])
    } catch {
      throw new Error(`llm-claude: header "${name}" is not a single-line Fetch-compatible header`)
    }
  }
}

/**
 * Validate one interceptor configuration into request-time facts.
 * @param {object} options - plain plugin options.
 * @returns {object} resolved options.
 */
export function resolveInterceptOptions(options) {
  const compat = options.claudeCodeCompat ?? {}
  const userAgent = compat.userAgent ?? 'claude-cli/2.1.293 (external, cli)'
  if (userAgent.length === 0) throw new Error('llm-claude: claudeCodeCompat.userAgent must not be empty')
  const headers = { ...(compat.headers ?? { 'x-app': 'cli' }) }
  assertHeaders(headers)
  const toolSchema = compat.toolSchema ?? 'names-only'
  if (!['names-only', 'claude-code'].includes(toolSchema)) {
    throw new Error('llm-claude: claudeCodeCompat.toolSchema must be names-only or claude-code')
  }
  const thinking = compat.thinking ?? 'auto'
  if (!['auto', 'off'].includes(thinking)) throw new Error('llm-claude: claudeCodeCompat.thinking must be auto or off')

  const includeProviders = [...(options.includeProviders ?? [])]
  const excludeProviders = [...(options.excludeProviders ?? [])]
  for (const provider of [...includeProviders, ...excludeProviders]) {
    if (typeof provider !== 'string' || provider.length === 0) {
      throw new Error('llm-claude: provider filters must be non-empty route keys')
    }
  }
  const review = options.review ?? {}
  const reviewProvider = review.provider ?? 'deepseek-account'
  const reviewModel = review.model ?? 'deepseek-flash'
  if (typeof reviewProvider !== 'string' || reviewProvider.length === 0) {
    throw new Error('llm-claude: review.provider must be a non-empty provider route key')
  }
  if (typeof reviewModel !== 'string' || reviewModel.length === 0) {
    throw new Error('llm-claude: review.model must be a non-empty model id')
  }
  const reviewEffort = review.reasoningEffort ?? 'off'
  if (!['off', 'low', 'high', 'max'].includes(reviewEffort)) {
    throw new Error('llm-claude: review.reasoningEffort must be off, low, high or max')
  }

  const maxRequestImagesBytes = options.maxRequestImagesBytes ?? 20971520
  if (!Number.isInteger(maxRequestImagesBytes) || maxRequestImagesBytes <= 0) {
    throw new Error('llm-claude: maxRequestImagesBytes must be a positive integer')
  }

  return {
    enabled: options.enabled !== false,
    includeProviders,
    excludeProviders,
    review: {
      enabled: review.enabled !== false,
      provider: reviewProvider,
      model: reviewModel,
      reasoningEffort: reviewEffort,
    },
    maxRequestImagesBytes,
    debug: options.debug === true,
    compat: {
      mode: 'auto',
      identityBlocks: compat.identityBlocks !== false,
      userAgent,
      headers,
      metadataUserId: compat.metadataUserId !== false,
      toolSchema,
      unknownToolPrefix: compat.unknownToolPrefix ?? 'mcp__dsh__',
      thinkingMode: thinking,
    },
  }
}
