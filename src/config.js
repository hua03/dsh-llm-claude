/**
 * Plugin configuration: schema, defaults, and the one resolve step.
 *
 * `resolveAdapterOptions()` is the only path from raw configuration to
 * validated connection facts. It runs at plugin load (fail loud) and again for
 * every operation / volatile update, so a settings edit reaches the next
 * request without re-registration.
 *
 * @module dsh-llm-claude/config
 */

import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { RetryPolicySchema, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'

const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const MODALITIES = ['text', 'image']

/** Default catalog for Claude Code gateways; override with `models` when a route differs. */
export const DEFAULT_MODELS = [
  {
    id: 'claude-haiku-5-5',
    name: 'Claude Haiku 5.5',
    contextWindow: 200000,
    maxTokens: 64000,
    inputModalities: ['text', 'image'],
    reasoning: false,
  },
  {
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    contextWindow: 1000000,
    maxTokens: 128000,
    inputModalities: ['text', 'image'],
    reasoning: 'adaptive',
    supportsTemperature: false,
  },
  {
    id: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    contextWindow: 1000000,
    maxTokens: 128000,
    inputModalities: ['text', 'image'],
    reasoning: 'adaptive',
  },
]

const modelEntry = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(MODALITIES)).min(1).default(['text']),
  /** `false` = no thinking; `adaptive`/`budget` = which wire shape the gateway expects. */
  reasoning: z.union([z.const(false), 'adaptive', 'budget']).default(false),
  supportsTemperature: z.boolean().default(true),
  supportsStrictTools: z.boolean().default(false),
})

const compatConfig = z.object({
  mode: z.union(['auto', 'off']).default('auto'),
  identityBlocks: z.boolean().default(true),
  userAgent: z.string().default('claude-cli/2.1.293 (external, cli)'),
  headers: z.dict(z.string()).default({ 'x-app': 'cli' }),
  metadataUserId: z.boolean().default(true),
  toolSchema: z.union(['names-only', 'claude-code']).default('names-only'),
  unknownToolPrefix: z.string().default('mcp__dsh__'),
})

/** Schemastery schema consumed by the cordis loader and the settings page. */
export const Config = z.object({
  provider: z.string().required().description('Provider route key registered with the harness.'),
  displayName: z.string().description('Selector label; defaults to the provider route key.'),
  baseURL: z.string().default('https://api.anthropic.com').volatile(),
  apiKeyEnv: z.string().default('ANTHROPIC_API_KEY').role('credential-ref').volatile(),
  auth: z
    .object({ header: z.union(['x-api-key', 'authorization-bearer']).default('x-api-key') })
    .default({ header: 'x-api-key' }),
  claudeCodeCompat: compatConfig.default({}).volatile(),
  thinking: z.object({ mode: z.union(['auto', 'off', 'adaptive', 'budget']).default('auto') }).default({ mode: 'auto' }),
  reasoningEffort: z.union(EFFORTS).default('high').volatile(),
  cacheRetention: z.union(['none', 'short', 'long']).default('short'),
  anthropicBeta: z.array(z.string()).default([]),
  maxTokens: z.number().step(1).min(1).default(64000),
  defaultContextWindow: z.number().step(1).min(1).default(262144),
  models: z.array(modelEntry).default(DEFAULT_MODELS).volatile(),
  maxRequestImagesBytes: z.number().step(1).min(1).default(20971520),
  streamIdleTimeoutMs: z.number().step(1).min(1).default(300000),
  retryPolicy: RetryPolicySchema,
})

/** Unwrap volatile references for the resolver. */
export function plainOptions(config) {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [key, isVolatile(value) ? value.get() : value]),
  )
}

function assertBaseURL(provider, raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`llm-claude: provider "${provider}" baseURL is not a valid URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`llm-claude: provider "${provider}" baseURL must be http(s)`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`llm-claude: provider "${provider}" baseURL must not embed credentials`)
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error(`llm-claude: provider "${provider}" baseURL must not carry a query or fragment`)
  }
}

function assertHeaders(provider, headers) {
  for (const [name, value] of Object.entries(headers ?? {})) {
    try {
      new Headers([[name, value]])
    } catch {
      throw new Error(
        `llm-claude: provider "${provider}" header "${name}" is not a single-line Fetch-compatible header`,
      )
    }
  }
}

function resolveModel(provider, entry) {
  if (typeof entry.id !== 'string' || entry.id.length === 0) {
    throw new Error(`llm-claude: provider "${provider}" has a model entry without an id`)
  }
  const reasoning = entry.reasoning ?? false
  return {
    id: entry.id,
    name: entry.name ?? entry.id,
    description: entry.description,
    contextWindow: entry.contextWindow ?? 262144,
    maxTokens: entry.maxTokens ?? 64000,
    inputModalities: entry.inputModalities ?? ['text'],
    reasoning,
    supportsTemperature: entry.supportsTemperature !== false,
    supportsStrictTools: entry.supportsStrictTools === true,
  }
}

/**
 * Validate one configuration candidate into per-operation connection facts.
 * @param {object} options - plain plugin options.
 * @returns {object} resolved connection options.
 */
export function resolveAdapterOptions(options) {
  const provider = options.provider
  if (typeof provider !== 'string' || provider.length === 0) {
    throw new Error('llm-claude: provider must be a non-empty route key')
  }
  const baseURL = options.baseURL ?? 'https://api.anthropic.com'
  assertBaseURL(provider, baseURL)
  const apiKeyEnv = credentialRef(options.apiKeyEnv ?? 'ANTHROPIC_API_KEY')

  const compat = {
    mode: options.claudeCodeCompat?.mode ?? 'auto',
    identityBlocks: options.claudeCodeCompat?.identityBlocks !== false,
    userAgent: options.claudeCodeCompat?.userAgent ?? 'claude-cli/2.1.293 (external, cli)',
    headers: { ...(options.claudeCodeCompat?.headers ?? { 'x-app': 'cli' }) },
    metadataUserId: options.claudeCodeCompat?.metadataUserId !== false,
    toolSchema: options.claudeCodeCompat?.toolSchema ?? 'names-only',
    unknownToolPrefix: options.claudeCodeCompat?.unknownToolPrefix ?? 'mcp__dsh__',
  }
  if (!['auto', 'off'].includes(compat.mode)) {
    throw new Error(`llm-claude: provider "${provider}" claudeCodeCompat.mode must be auto or off`)
  }
  if (!['names-only', 'claude-code'].includes(compat.toolSchema)) {
    throw new Error(`llm-claude: provider "${provider}" claudeCodeCompat.toolSchema must be names-only or claude-code`)
  }
  assertHeaders(provider, compat.headers)

  const reasoningEffort = options.reasoningEffort ?? 'high'
  if (!EFFORTS.includes(reasoningEffort)) {
    throw new Error(`llm-claude: provider "${provider}" reasoningEffort must be one of ${EFFORTS.join(', ')}`)
  }
  const thinkingMode = options.thinking?.mode ?? 'auto'
  if (!['auto', 'off', 'adaptive', 'budget'].includes(thinkingMode)) {
    throw new Error(`llm-claude: provider "${provider}" thinking.mode must be auto, off, adaptive or budget`)
  }

  const rawModels = options.models === undefined || options.models.length === 0 ? DEFAULT_MODELS : options.models
  const seen = new Set()
  const models = rawModels.map((entry) => {
    const model = resolveModel(provider, entry)
    if (seen.has(model.id)) throw new Error(`llm-claude: provider "${provider}" lists model "${model.id}" twice`)
    seen.add(model.id)
    return model
  })
  if (compat.mode === 'auto' && !models.some((model) => model.id.startsWith('claude-'))) {
    throw new Error(
      `llm-claude: provider "${provider}" enables claudeCodeCompat.mode=auto but no model id starts with "claude-"`,
    )
  }

  const streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? 300000
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) {
    throw new Error(`llm-claude: provider "${provider}" streamIdleTimeoutMs must be a positive finite number`)
  }
  const maxRequestImagesBytes = options.maxRequestImagesBytes ?? 20971520
  if (!Number.isInteger(maxRequestImagesBytes) || maxRequestImagesBytes <= 0) {
    throw new Error(`llm-claude: provider "${provider}" maxRequestImagesBytes must be a positive integer`)
  }

  return {
    provider,
    displayName: options.displayName ?? provider,
    baseURL,
    apiKeyEnv,
    authHeader: options.auth?.header ?? 'x-api-key',
    compat,
    reasoningEffort,
    thinkingMode,
    cacheRetention: options.cacheRetention ?? 'short',
    anthropicBeta: [...(options.anthropicBeta ?? [])],
    maxTokens: options.maxTokens ?? 64000,
    defaultContextWindow: options.defaultContextWindow ?? 262144,
    models,
    modelsById: new Map(models.map((model) => [model.id, model])),
    maxRequestImagesBytes,
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(options.retryPolicy, `llm-claude: provider "${provider}" retryPolicy`),
  }
}
