// @vitest-environment jsdom
/**
 * A recording or a clip is refused before its first byte leaves the browser.
 *
 * The strip has said for a while that no model can be handed these bytes — the three request builders in
 * `worker/assistant/upstream.ts` put text and pictures into a body and nothing else ever goes in. Saying it
 * after the upload only explains the waste: the file went to the reader's storage, the round trip was paid
 * for, and the answer is still going to be the same sentence. So the queue asks `attachmentModality` itself
 * and turns the file away at the door, and the row that appears carries the reason instead of the bytes.
 *
 * The door has to be the queue rather than the pickers' `accept` attribute, because a drag and a paste do
 * not pass through that attribute at all — `ChatView.tsx` hands `attachFiles` the clipboard's and the
 * dataTransfer's files as they come — so one gate there stops all three paths at once, which is what the
 * cases below assert: no upload call (the whole point, counted on a mock), the reason drawn as text an eye
 * reads, the cross that still takes the row out of the box, and the files a turn really does read still
 * uploaded exactly as they were.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '@shared/assistant'
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

function pick(name: string, type: string, bytes = 2_048): File {
  return new File([new Uint8Array(bytes)], name, { type })
}

const RECORDING = pick('voice-note.mp3', 'audio/mpeg')
const CLIP = pick('standup.mp4', 'video/mp4')
const NOTE = pick('notes.md', 'text/markdown')
const PICTURE = pick('plot.png', 'image/png')

/** What the row owes the reader, built from the keys rather than from the function under test. */
function refusalFor(kindKey: 'assistant.model.modality.audio' | 'assistant.model.modality.video', name: string): string {
  return t('assistant.attach.unreadable', { kind: t(kindKey), name })
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

const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const byAria = (name: string) => buttons().find((node) => node.getAttribute('aria-label') === name)
const refusalLines = () => [...document.body.querySelectorAll<HTMLElement>('[data-attachment-unreadable]')]
const rows = () => useAssistant.getState().pending

async function attach(...files: File[]): Promise<void> {
  await act(async () => { await useAssistant.getState().attachFiles(files) })
}

async function click(node: Element | undefined): Promise<void> {
  expect(node, 'the control the case is about is missing').toBeTruthy()
  await act(async () => { node!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}

function mountStrip(onRetry?: (localId: string) => void): void {
  // One strip at a time: a case that re-mounts after a second batch of files must not leave the first copy
  // mounted, or the rows it counts are two renders of the same queue.
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
  useAssistant.setState({ pending: [], fileIndex: {} })
  uploadChatFile.mockReset().mockImplementation(async (file: File) => storedFor(file, `up-${uploadChatFile.mock.calls.length}`))
  deleteChatFile.mockReset().mockResolvedValue({ deleted: true })
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
  useAssistant.setState({ pending: [], fileIndex: {} })
})

describe('a recording dropped or pasted into the composer', () => {
  it('never asks for the upload', async () => {
    await attach(RECORDING, CLIP)
    expect(uploadChatFile, 'the gate let a byte of audio leave the browser').not.toHaveBeenCalled()
    expect(deleteChatFile, 'a file that was never uploaded was still sent to the delete route').not.toHaveBeenCalled()
  })

  it('puts the row in the failure state with the same reason the strip draws', async () => {
    await attach(RECORDING)
    const [row] = rows()
    expect(row?.status, 'the refused row is not marked as a failure').toBe('error')
    expect(row?.id, 'a refused row claims a server id it never earned').toBe('')
    expect(row?.progress, 'a refused row reports progress on bytes it never sent').toBe(0)
    expect(row?.error, 'the row itself carries no reason').toBe(refusalFor('assistant.model.modality.audio', 'voice-note.mp3'))
  })

  it('names the reason as text a reader sees, beside every refused file', async () => {
    await attach(RECORDING, CLIP)
    mountStrip()
    expect(refusalLines(), 'the refused rows are drawn with no reason beside them').toHaveLength(2)
    expect(refusalLines()[0]!.textContent).toContain(refusalFor('assistant.model.modality.audio', 'voice-note.mp3'))
    expect(refusalLines()[1]!.textContent).toContain(refusalFor('assistant.model.modality.video', 'standup.mp4'))
    // A copy hidden under `sr-only` or parked in a `title` would answer nobody deciding whether to press send.
    expect(refusalLines()[0]!.className).not.toContain('sr-only')
  })

  it('keeps the cross that takes the row out of the box, and asks the server for nothing', async () => {
    await attach(RECORDING, NOTE)
    mountStrip()
    // A file the reader picked has to be removable even when the app will not have it: the other row is a real
    // upload, so removing the refused one must not be the thing that finally reaches for the delete route.
    const stored = rows().find((entry) => entry.filename === 'notes.md')!
    await click(byAria(t('assistant.attach.remove', { name: 'voice-note.mp3' })))
    expect(rows().map((entry) => entry.filename)).toEqual(['notes.md'])
    expect(deleteChatFile, 'removing a never-uploaded file went looking for a server copy').not.toHaveBeenCalled()

    await click(byAria(t('assistant.attach.remove', { name: 'notes.md' })))
    expect(rows()).toEqual([])
    expect(deleteChatFile).toHaveBeenCalledWith(stored.id)
  })

  it('offers no retry, and answers one from any other door with the same no', async () => {
    await attach(RECORDING)
    // The press would change nothing, so it is not drawn; the store still refuses it, because the queue is
    // not the only door into `retryAttachment`.
    mountStrip((localId) => void useAssistant.getState().retryAttachment(localId))
    expect(byAria(t('assistant.attach.retry', { name: 'voice-note.mp3' })), 'a retry was offered for what no retry can fix').toBeUndefined()

    const localId = rows()[0]!.localId
    await act(async () => { await useAssistant.getState().retryAttachment(localId) })
    expect(uploadChatFile, 'the retry path uploaded a recording it had refused').not.toHaveBeenCalled()
    const row = rows()[0]!
    expect(row.status).toBe('error')
    expect(row.error).toBe(refusalFor('assistant.model.modality.audio', 'voice-note.mp3'))
  })

  it('keeps such a row out of the turn, and says nothing about the files the turn reads', async () => {
    await attach(RECORDING, CLIP)
    mountStrip()
    expect(refusalLines()).toHaveLength(2)
    // `send()` carries only `ready` attachments that have a server id, which is what a refused row has
    // neither of — so a gate that stops the row from ever becoming ready stops it from being paid for too.
    expect(rows().some((entry) => entry.status === 'ready' && entry.id !== ''), 'a refused row reached the state a turn carries').toBe(false)

    uploadChatFile.mockClear()
    await attach(NOTE, PICTURE)
    expect(uploadChatFile, 'a note or a picture was caught by the gate').toHaveBeenCalledTimes(2)
    expect(rows().filter((entry) => entry.status === 'ready')).toHaveLength(2)
    mountStrip()
    // The two refused rows still say their one thing each; the two that landed say nothing.
    expect(refusalLines()).toHaveLength(2)
    expect(rows().slice(2).every((entry) => !entry.error && entry.id !== ''), 'the readable files came back short').toBe(true)
  })
})

describe('a failed upload that is not about the file being unreadable', () => {
  it('still offers the retry the refused row does not get', async () => {
    uploadChatFile.mockRejectedValueOnce(new Error('the shelf refused it'))
    await attach(NOTE)
    expect(rows()[0]?.status).toBe('error')
    mountStrip(() => {})
    expect(byAria(t('assistant.attach.retry', { name: 'notes.md' })), 'a flaky upload lost its retry').toBeTruthy()
    expect(refusalLines(), 'an upload failure was told as an unreadable file').toHaveLength(0)
  })
})
