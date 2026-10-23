import assert from 'node:assert/strict'
import test from 'node:test'
import { call, mockServer, mount, routeProfile, textBody } from './helpers.mjs'

const IMAGE_BYTES = Buffer.from('fake-png-bytes')

function fakeAttachments() {
  return {
    async readImageRequest(ref) {
      return { data: IMAGE_BYTES, mediaType: ref.mediaType, bytes: IMAGE_BYTES.length, width: 4, height: 4 }
    },
  }
}

function imageMessages() {
  return [
    {
      role: 'system',
      id: 'm1',
      content: [{ type: 'text', text: 'prompt' }],
      source: { kind: 'system-prompt' },
    },
    {
      role: 'user',
      id: 'm2',
      content: [
        { type: 'text', text: 'what is this?' },
        {
          type: 'image',
          attachment: { attachmentId: 'img-1', mediaType: 'image/png', bytes: IMAGE_BYTES.length, width: 4, height: 4 },
        },
      ],
      source: { kind: 'user' },
    },
  ]
}

const request = (overrides = {}) => ({
  provider: 'gateway',
  model: 'claude-haiku-5-5',
  messages: imageMessages(),
  signal: AbortSignal.timeout(5000),
  ...overrides,
})

test('images are sent inline as base64 beside their durable handle text', async () => {
  const server = await mockServer([textBody()])
  try {
    const { handle } = mount({
      providers: { gateway: routeProfile(server.baseURL) },
      attachments: fakeAttachments(),
    })
    await call(handle, request())
    const content = server.captured[0].body.messages[0].content
    assert.ok(content.some((block) => block.type === 'text' && /what is this\?/.test(block.text)))
    assert.ok(content.some((block) => block.type === 'text' && /img-1/.test(block.text)))
    const image = content.find((block) => block.type === 'image')
    assert.equal(image.source.media_type, 'image/png')
    assert.equal(Buffer.from(image.source.data, 'base64').toString(), 'fake-png-bytes')
  } finally {
    await server.close()
  }
})

test('an over-budget image request fails with IMAGE_OFFLOAD_REQUIRED', async () => {
  const server = await mockServer([textBody()])
  try {
    const { handle } = mount({
      providers: { gateway: routeProfile(server.baseURL) },
      attachments: fakeAttachments(),
      config: { maxRequestImagesBytes: 4 },
    })
    await assert.rejects(
      call(handle, request()),
      (error) => error.code === 'IMAGE_OFFLOAD_REQUIRED' && error.failure.offloadImages > 0,
    )
  } finally {
    await server.close()
  }
})

test('offloaded images are represented as placeholder text', async () => {
  const server = await mockServer([textBody()])
  try {
    const { handle } = mount({
      providers: { gateway: routeProfile(server.baseURL) },
      attachments: fakeAttachments(),
    })
    const messages = imageMessages()
    messages[1].content[1].offloaded = true
    await call(handle, request({ messages }))
    const content = server.captured[0].body.messages[0].content
    assert.equal(content.filter((block) => block.type === 'image').length, 0)
    assert.ok(content.some((block) => block.type === 'text' && /img-1/.test(block.text)))
  } finally {
    await server.close()
  }
})
