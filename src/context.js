/**
 * Harness request history -> pi-ai request context.
 *
 * The harness vocabulary is the durable record; pi-ai's `Context` is the
 * provider-facing projection. Two facts drive this module:
 *   - loop-built requests carry the rendered system prompt as the leading
 *     `system` message, while `options.system` only serves one-shot callers;
 *   - images are durable attachment references that must be materialized into
 *     deterministic request bytes through the attachment seam.
 *
 * Tool changes (developer messages) never reach this adapter because the route
 * declares no `toolUpdate`, so the runtime has already projected them away.
 *
 * @module dsh-llm-claude/context
 */

import {
  IMAGE_OFFLOAD_REQUIRED_CODE,
  LlmError,
  contentHasImage,
  offloadedImageText,
  projectOffloadedImages,
  requestImageHandleText,
  requiredImageOffload,
} from '@deepseek-ai/dsh-llm'
import { toPiAssistant } from './replay.js'

/** Join the text blocks of one harness message. */
function flattenText(message) {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/** Split the injected prompt from conversation history. */
function splitSystemPrompt(options) {
  const parts = [options.system]
  let end = 0
  for (const message of options.messages) {
    if (message.role !== 'system') break
    parts.push(flattenText(message))
    end++
  }
  const systemPrompt = parts.filter(Boolean).join('\n\n')
  return { systemPrompt: systemPrompt.length > 0 ? systemPrompt : undefined, messages: options.messages.slice(end) }
}

/** Reject history this adapter cannot represent instead of silently dropping it. */
function assertSupportedHistory(messages) {
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'tool' && contentHasImage(message.content)) {
      throw new LlmError(
        `llm-claude cannot represent an image in an in-history ${message.role} message`,
        'UNSUPPORTED_CONTENT',
      )
    }
    if (message.role === 'system' && message.content.some((block) => block.type !== 'text')) {
      throw new LlmError('llm-claude cannot represent non-text system messages', 'UNSUPPORTED_CONTENT')
    }
  }
}

/** Resolve one normalized attachment into its exact request version. */
function requestImageTarget(ref) {
  // No provider-specific resizing: the attachment seam's normalized object is
  // the single request version, so serialization and pricing cannot diverge.
  return { width: ref.width, height: ref.height, maxBytes: 1048576 }
}

async function prepareRequestImages(messages, attachments, signal) {
  const refs = new Map()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'image' && block.offloaded !== true) refs.set(block.attachment.attachmentId, block.attachment)
    }
  }
  const ordered = [...refs.values()]
  const prepared = await Promise.all(
    ordered.map((ref) => attachments.readImageRequest(ref, requestImageTarget(ref), signal)),
  )
  return new Map(ordered.map((ref, index) => [ref.attachmentId, prepared[index]]))
}

/** Model-facing content for one user or tool message. */
function userContent(blocks, requestImages) {
  const content = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) content.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      const version = requestImages.get(block.attachment.attachmentId)
      if (version === undefined) continue
      content.push({ type: 'text', text: requestImageHandleText(block.attachment, version) })
      content.push({
        type: 'image',
        data: Buffer.from(version.data).toString('base64'),
        mimeType: version.mediaType,
      })
    } else if (block.type !== 'tool-call' && block.type !== 'reasoning') {
      throw new LlmError(`llm-claude cannot represent content block "${block.type}" in user history`, 'UNSUPPORTED_CONTENT')
    }
  }
  if (content.every((block) => block.type === 'text')) return content.map((block) => block.text).join('')
  return content
}

/** Harness tool result -> pi-ai toolResult message. */
function toolResultOf(message, toolNames, content) {
  return {
    role: 'toolResult',
    toolCallId: message.toolCallId,
    toolName: toolNames.get(message.toolCallId) ?? 'unknown',
    content: typeof content === 'string' ? [{ type: 'text', text: content || '(no output)' }] : content,
    isError: message.isError ?? false,
    timestamp: 0,
  }
}

/** Convert declarations, dropping the harness-only activation marker. */
function piTools(options) {
  if (options.tools === undefined) return undefined
  return options.tools
    .filter((tool) => tool.deferLoading !== true)
    .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
}

/**
 * Build the pi-ai context for one request.
 *
 * @param {object} options - harness `GenerateOptions`.
 * @param {{
 *   attachments?: import('@deepseek-ai/dsh-attachment').AttachmentStore,
 *   maxRequestImagesBytes: number,
 *   onReplayDegrade?: (reason: string) => void,
 * }} deps - resolved request dependencies.
 * @returns {Promise<{context: object, toolNames: Map<string, string>}>}
 */
export async function toPiContext(options, deps) {
  assertSupportedHistory(options.messages)
  const split = splitSystemPrompt(options)
  const hasImages = split.messages.some((message) => contentHasImage(message.content))
  if (hasImages && deps.attachments === undefined) {
    throw new LlmError('llm-claude image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
  }
  const requestImages = hasImages
    ? await prepareRequestImages(split.messages, deps.attachments, options.signal)
    : new Map()

  if (requestImages.size > 0 && deps.maxRequestImagesBytes !== undefined) {
    const offloadImages = requiredImageOffload(
      split.messages,
      { representation: 'base64', maxBytes: deps.maxRequestImagesBytes },
      (block) => requestImages.get(block.attachment.attachmentId).bytes,
    )
    if (offloadImages > 0) {
      throw new LlmError(
        `llm-claude request images exceed the ${deps.maxRequestImagesBytes}-byte base64 bound; ${offloadImages} more oldest occurrence(s) must be offloaded.`,
        IMAGE_OFFLOAD_REQUIRED_CODE,
        { offloadImages },
      )
    }
  }

  const exact = hasImages
    ? projectOffloadedImages(split.messages, (ref) => offloadedImageText(ref))
    : split.messages

  const toolNames = new Map()
  const messages = []
  for (const message of exact) {
    if (message.role === 'developer') continue
    if (message.role === 'system') {
      const content = flattenText(message)
      if (content.length > 0) messages.push({ role: 'system', content, timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = toPiAssistant(message, deps.onReplayDegrade)
      for (const block of assistant.content) {
        if (block.type === 'toolCall') toolNames.set(block.id, block.name)
      }
      messages.push(assistant)
      continue
    }
    if (message.role === 'tool') {
      messages.push(toolResultOf(message, toolNames, userContent(message.content, requestImages)))
      continue
    }
    messages.push({ role: 'user', content: userContent(message.content, requestImages), timestamp: 0 })
  }

  const tools = piTools(options)
  const context = {
    ...(split.systemPrompt === undefined ? {} : { systemPrompt: split.systemPrompt }),
    messages,
    ...(tools === undefined || tools.length === 0 ? {} : { tools }),
  }
  return { context, toolNames }
}
