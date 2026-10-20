// @vitest-environment jsdom
/**
 * A recording too big to be sent is turned away before a byte of it is uploaded.
 *
 * The worker already refuses one over `AUDIO_SEND_MAX_BYTES`: it names the file to the model, says it is
 * larger than the ceiling, and hands back no bytes. That answer is honest, but it arrives after the reader
 * waited for a five-megabyte upload to finish and paid to store a file that was never going to be read —
 * the one cost the existing pre-upload gate was built to avoid, and the one this ceiling was missing.
 *
 * So the number lives in `@shared/assistant` and the queue asks it the same way it asks the four model
 * reasons, from the *same* imported constant rather than a client-side copy: a second 2 MB written down in
 * the browser is the drift this case exists to prevent, and the limit named in the refusal is what an
 * unmodified worker would actually enforce. The cases below pin the ceiling from both sides — one byte over
 * is refused, the ceiling itself is uploaded — because `>` and `>=` are indistinguishable in a message.
 *
 * What is *not* refused here matters as much: a big text file still goes in, since this ceiling is about
 * base64 bytes riding inside a request and the worker reads text out of storage into the prompt instead. The
 * refusal says the size and the ceiling in words a reader sees, and the row keeps its cross but loses the
 * retry, because no press makes a recording smaller.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUDIO_SEND_MAX_BYTES,
  DEFAULT_ASSISTANT_SETTINGS,
  type AssistantModel,
  type AssistantProvider,
  type ChatAttachment,
} from '@shared/assistant'
import { formatBytes } from '@shared/byte-format'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../../lib/test-render'
import { useAssistant } from './assistant-store'
import { AttachmentStrip } from './ChatAttachments'

const { uploadChatFile, deleteChatFile } = vi.hoisted(() => ({
  uploadChatFile: vi.fn(),
  deleteChatFile: vi.fn(),
}))

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    assistant: {
      uploadChatFile: (...args: unknown[]) => uploadChatFile(...args),
      deleteChatFile: (id: string) => deleteChatFile(id),
      chatFileUrl: (id: string) => `/api/assistant/files/${id}`,
    },
  },
}))

function model(over: Partial<AssistantModel> = {}): AssistantModel {
  return {
    id: 'm1', providerId: 'p1', model: 'deepseek-chat', label: 'DeepSeek Chat', temperature: 0.4,
    maxOutputTokens: 8192, enabled: true, reasoning: 'auto', contextTokens: null, vision: true, purpose: 'chat',
    kind: 'text', supportsTools: true, maxInputTokens: null, modalities: ['audio'], topP: null, customParams: [],
    protocol: null, fallbackModelId: null, inputPrice: null, outputPrice: null, priceCurrency: '', pricePeriods: [], icon: '', ...over,
  }
}

const GATEWAY: AssistantProvider = {
  id: 'p1', label: 'Gateway', protocol: 'openai', baseUrl: 'https://gateway.example.org/v1', endpoints: {},
  hasKey: true, icon: '', keyHint: 'abcd', reasoningDialect: null, createdAt: 1, updatedAt: 1,
}

function pick(name: string, type: string, bytes: number): File {
  return new File([new Uint8Array(bytes)], name, { type })
}

/** One byte past the ceiling the worker would enforce, and the ceiling itself. */
const OVER = pick('long-meeting.mp3', 'audio/mpeg', AUDIO_SEND_MAX_BYTES + 1)
const AT_LIMIT = pick('exactly-two-mb.wav', 'audio/x-wav', AUDIO_SEND_MAX_BYTES)
const SMALL = pick('voice-note.mp3', 'audio/mpeg', 2_048)
const BIG_NOTE = pick('huge-log.txt', 'text/plain', AUDIO_SEND_MAX_BYTES + 4096)

/** The sentence, built from the keys and the shared ceiling rather than from the function under test. */
function oversizeLine(name: string, bytes: number): string {
  return t('assistant.attach.audio_too_large', {
    name,
    size: formatBytes(bytes),
    max: formatBytes(AUDIO_SEND_MAX_BYTES),
  })
}

function storedFor(file: File, id: string): ChatAttachment {
  return {
    id,
    kind: file.type.startsWith('image/') ? 'image' : 'file',
    filename: file.name,
    mime: file.type,
    size: file.size,
    key: `chat/files/u/${id}`,
    createdAt: 1,
  }
}

let rendered: RenderedElement | null = null

const refusalLines = () => [...document.body.querySelectorAll<HTMLElement>('[data-attachment-unreadable]')]
const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const byAria = (name: string) => buttons().find((node) => node.getAttribute('aria-label') === name)
const rows = () => useAssistant.getState().pending

async function attach(...files: File[]): Promise<void> {
  await act(async () => { await useAssistant.getState().attachFiles(files) })
}

function mountStrip(onRetry?: (localId: string) => void): void {
  rendered?.unmount()
  rendered = renderElement(createElement(AttachmentStrip, {
    items: rows(),
    onRemove: (localId: string) => void useAssistant.getState().dropAttachment(localId),
    onRetry,
  }))
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  // The model that says yes to everything else: audio ticked, on the wire that carries it, so the only
  // thing left to refuse these files is their size.
  useAssistant.setState({
    pending: [],
    fileIndex: {},
    models: [model()],
    providers: [GATEWAY],
    settings: { ...DEFAULT_ASSISTANT_SETTINGS, activeModelId: 'm1' },
  })
  uploadChatFile.mockReset().mockImplementation(async (file: File) => storedFor(file, `up-${uploadChatFile.mock.calls.length}`))
  deleteChatFile.mockReset().mockResolvedValue({ deleted: true })
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
  useAssistant.setState({ pending: [], fileIndex: {} })
})

describe('a recording past the inline ceiling', () => {
  it('never asks for the upload', async () => {
    await attach(OVER)
    expect(uploadChatFile, 'the size gate let five megabytes leave the browser').not.toHaveBeenCalled()
    expect(deleteChatFile, 'a file that was never uploaded was sent to the delete route').not.toHaveBeenCalled()
  })

  it('names the ceiling it refused against, in the row', async () => {
    await attach(OVER)
    const [row] = rows()
    expect(row?.status, 'the refused row is not marked as a failure').toBe('error')
    expect(row?.id, 'a refused row claims a server id it never earned').toBe('')
    expect(row?.progress, 'a refused row reports progress on bytes it never sent').toBe(0)
    expect(row?.error, 'the row does not say why it was refused').toBe(oversizeLine('long-meeting.mp3', OVER.size))
    // The number the reader reads is the number the worker enforces, not a client-side rounding of it.
    expect(row?.error, 'the refusal never names the ceiling').toContain(formatBytes(AUDIO_SEND_MAX_BYTES))
  })

  it('draws the reason as text beside the row, not as a tooltip', async () => {
    await attach(OVER)
    mountStrip()
    expect(refusalLines(), 'the refused row is drawn with no reason beside it').toHaveLength(1)
    expect(refusalLines()[0]!.textContent).toContain(oversizeLine('long-meeting.mp3', OVER.size))
    expect(refusalLines()[0]!.className).not.toContain('sr-only')
  })

  it('offers no retry, and answers one from any other door with the same no', async () => {
    await attach(OVER)
    mountStrip((localId) => void useAssistant.getState().retryAttachment(localId))
    expect(byAria(t('assistant.attach.retry', { name: 'long-meeting.mp3' })), 'a retry was offered for a file no retry can shrink').toBeUndefined()

    const localId = rows()[0]!.localId
    await act(async () => { await useAssistant.getState().retryAttachment(localId) })
    expect(uploadChatFile, 'the retry path uploaded a recording it had refused for size').not.toHaveBeenCalled()
    expect(rows()[0]!.error).toBe(oversizeLine('long-meeting.mp3', OVER.size))
  })

  it('uploads a recording that is exactly at the ceiling', async () => {
    // The worker compares with `>`, so the boundary file is the one this case has to keep out of the refusal:
    // moving the check to `>=` would silently cost the reader a recording the turn could have answered.
    await attach(AT_LIMIT)
    expect(rows()[0]!.status).toBe('ready')
    expect(uploadChatFile).toHaveBeenCalledTimes(1)
  })

  it('still uploads a recording below it', async () => {
    await attach(SMALL)
    expect(rows()[0]!.status).toBe('ready')
    expect(uploadChatFile).toHaveBeenCalledTimes(1)
  })

  it('leaves a big text file alone, because this ceiling is about audio bytes', async () => {
    await attach(BIG_NOTE)
    expect(uploadChatFile, 'the audio ceiling was pointed at a text file').toHaveBeenCalledTimes(1)
    expect(rows()[0]!.status).toBe('ready')
  })
})
