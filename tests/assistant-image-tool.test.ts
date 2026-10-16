/**
 * The picture the assistant draws, as the turn sees it.
 *
 * Two things are pinned. First, that a call really goes out to the reader's own image model — the model
 * picked by its purpose, the key taken from the same ring a chat turn uses — and that what comes back is
 * stored as a chat attachment of kind `image` rather than handed to the model as text. Second, that the
 * attachment is announced to the turn: the reader sees the picture on the answer, so a tool that drew one
 * and said nothing would leave them with a chip and no image.
 *
 * The store is stood up rather than opened, because what is under test is the shape of the call; the
 * object store is the real double, because that is where the bytes actually go.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantModel, type AssistantProvider } from '../src/shared/assistant'
import { toBase64 } from '../src/worker/lib/encoding'
import { ToolExecutor, type ToolContext } from '../src/worker/assistant/tools'
import type { AssistantStore } from '../src/worker/assistant/store'
import type { Env } from '../src/worker/env'
import { testR2Bucket } from './doubles/bindings'

const USER = 'user-1'

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
])

const IMAGE_MODEL = {
  id: 'm-image', providerId: 'p1', model: 'gpt-image-1', label: 'Image', enabled: true, purpose: 'image_generate',
} as unknown as AssistantModel

const PROVIDER = {
  id: 'p1', label: 'Example', protocol: 'openai', base_url: 'https://api.example.com', endpoints: '{}',
  reasoning_dialect: null, key_ciphertext: 'cipher', key_last_used_at: 0, created_at: 1, updated_at: 1,
} as unknown as AssistantProvider

interface AttachmentInput {
  id: string, kind: 'image' | 'file', filename: string, mime: string, size: number, key: string
}

/**
 * A store whose image-side methods are spies.
 *
 * Returned separately from the cast: `AssistantStore` is what the tool sees, and the mocks are what a
 * case reads back, so keeping them in one object would mean casting away the very types being asserted.
 */
function makeStore(over: Record<string, unknown> = {}) {
  const listModels = vi.fn(async () => [IMAGE_MODEL])
  const providerRecord = vi.fn(async () => PROVIDER)
  const pickProviderKey = vi.fn(async () => ({ keyId: 'k1', key: 'sk-test-value', label: 'Example' }))
  const markProviderKeyUsed = vi.fn(async () => undefined)
  const createChatAttachment = vi.fn(async (input: AttachmentInput) => ({
    id: input.id, kind: input.kind, filename: input.filename, mime: input.mime, size: input.size, key: input.key, createdAt: 1,
  }))
  const store = {
    userId: USER, listModels, providerRecord, pickProviderKey, markProviderKeyUsed, createChatAttachment, ...over,
  } as unknown as AssistantStore
  return { store, listModels, providerRecord, pickProviderKey, markProviderKeyUsed, createChatAttachment }
}

const files = testR2Bucket()
const env = { FILES: files } as unknown as Env

function context(store: AssistantStore, over: Partial<ToolContext> = {}): ToolContext {
  return {
    store,
    env,
    ftsEnabled: false,
    origin: 'https://notes.test',
    settings: DEFAULT_ASSISTANT_SETTINGS,
    timezone: 'Asia/Shanghai',
    dayEnd: 1_700_000_000_000,
    mode: 'chat',
    conversationId: 'c1',
    memoryHistory: {} as ToolContext['memoryHistory'],
    memoryScope: { projectId: null },
    automations: {} as ToolContext['automations'],
    noteScope: async () => ({ restricted: false, folderIds: new Set(), tagIds: new Set(), noteIds: new Set() }),
    ...over,
  }
}

const draw = () => vi.stubGlobal('fetch', vi.fn(async () => new Response(
  JSON.stringify({ data: [{ b64_json: toBase64(PNG) }] }),
  { status: 200, headers: { 'content-type': 'application/json' } },
)))

afterEach(() => vi.unstubAllGlobals())

describe('image_generate', () => {
  it('draws with the reader\'s image model and stores the picture as an attachment', async () => {
    draw()
    const { store, createChatAttachment, markProviderKeyUsed } = makeStore()
    const generated: string[] = []
    const executor = new ToolExecutor(context(store, { generatedAttachments: generated }), { maxToolCalls: 8 })
    const result = await executor.execute('image_generate', { prompt: 'a cat asleep on a keyboard' }, 'call-1') as Record<string, unknown>

    // The picture is named back to the model only so it knows the call landed; the reader gets it as a row.
    expect(result.drawn).toMatchObject({ mime: 'image/png' })
    expect(createChatAttachment).toHaveBeenCalledTimes(1)
    expect(createChatAttachment).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'image',
      mime: 'image/png',
      size: PNG.length,
      filename: 'a cat asleep on a keyboard.png',
    }))
    // The bytes are in the reader's own storage, under a key built from the attachment's id.
    const stored = createChatAttachment.mock.calls[0]![0] as AttachmentInput
    expect(await files.get(stored.key)).toBeTruthy()
    // And the turn is told, so the answer it files carries the picture.
    expect(generated).toEqual([stored.id])
    // The ring a chat turn uses, so a key that is spent rotates here too.
    expect(markProviderKeyUsed).toHaveBeenCalledWith('p1', 'k1')
  })

  it('says which setting to fix when no image model is configured', async () => {
    draw()
    const { store, createChatAttachment } = makeStore({ listModels: vi.fn(async () => []) })
    const executor = new ToolExecutor(context(store), { maxToolCalls: 8 })
    await expect(executor.execute('image_generate', { prompt: 'a cat' }, 'call-1'))
      .rejects.toThrow('No image model is configured')
    expect(createChatAttachment).not.toHaveBeenCalled()
  })

  it('leaves a chat model out of it, however it is listed first', async () => {
    draw()
    const chatModel = { ...IMAGE_MODEL, id: 'm-chat', purpose: 'chat' } as AssistantModel
    const { store, providerRecord } = makeStore({ listModels: vi.fn(async () => [chatModel, IMAGE_MODEL]) })
    const executor = new ToolExecutor(context(store), { maxToolCalls: 8 })
    await executor.execute('image_generate', { prompt: 'a cat' }, 'call-1')
    // The purpose is what marks the image model; the order the rows come back in is not a preference.
    expect(providerRecord).toHaveBeenCalledWith('p1')
  })

  it('is a write, so a reader who closed writes has closed this too', () => {
    const { store } = makeStore()
    const executor = new ToolExecutor(context(store, {
      settings: { ...DEFAULT_ASSISTANT_SETTINGS, toolModes: { read: 'auto', write: 'off', destructive: 'ask' } },
    }), { maxToolCalls: 8 })
    expect(executor.available().map((definition) => definition.name)).not.toContain('image_generate')
  })

  it('is not offered to a routine nobody is watching', () => {
    // An unattended run has no business buying pictures with the reader's balance.
    const { store } = makeStore()
    const executor = new ToolExecutor(context(store, { mode: 'scheduled', conversationId: undefined }), { maxToolCalls: 8 })
    expect(executor.available().map((definition) => definition.name)).not.toContain('image_generate')
  })

  it('stops at two pictures in one turn', async () => {
    draw()
    const { store } = makeStore()
    const executor = new ToolExecutor(context(store), { maxToolCalls: 8 })
    await executor.execute('image_generate', { prompt: 'one' }, 'call-1')
    await executor.execute('image_generate', { prompt: 'two' }, 'call-2')
    // A picture costs real money at the vendor, and "try a few variations" is not the reader's decision.
    await expect(executor.execute('image_generate', { prompt: 'three' }, 'call-3')).rejects.toThrow('already used 2 times')
  })
})
