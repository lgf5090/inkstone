// @vitest-environment node
/**
 * Which attached file no model in this app can be handed — and the proof that the answer is the truth.
 *
 * A recording and a clip are the two kinds a reader can drop into the composer that a turn cannot use. The
 * composer's file and folder pickers already refuse them, so this is about the three doors that do not go
 * through a picker: a drag onto the box, a paste, and a web address. What decides those is one question —
 * can the bytes of this file ever reach a model? — and it has to have one answer in one place, or the
 * client refuses a file the worker is perfectly able to read, or the other way round.
 *
 * The answer here is proved rather than asserted. `attachments.ts` claims an audio file is only *named* in
 * a turn even when the model is marked as taking audio, and a reader who is told that at attach time has a
 * right to know it is actually so. So the case below hands the expansion a bucket that records every read
 * it is asked for, and shows the bucket was never opened: no bytes leave storage, no base64 joins the
 * request, and nothing marks a model as able to take audio changes that. The judgment the composer acts on
 * is the judgment the worker's own code can be shown to hold.
 */
import { describe, expect, it } from 'vitest'
import { ATTACHMENT_MARKER, expandChatAttachments } from '../src/worker/assistant/attachments'
import { attachmentModality } from '../src/shared/assistant'
import type { AssistantStore } from '../src/worker/assistant/store'
import type { ChatAttachment } from '../src/shared/assistant'
import type { Env } from '../src/worker/env'

function row(id: string, filename: string, mime = 'text/markdown', kind: ChatAttachment['kind'] = 'file'): ChatAttachment {
  return { id, kind, filename, mime, size: 1024, key: `chat/files/user/${id}`, createdAt: 1_700_000_000 }
}

/** The rows, their bytes, and the list of every object the expansion actually opened. */
function harness(rows: ChatAttachment[], bodies: Record<string, string>) {
  const reads: string[] = []
  const store = {
    chatAttachments: async () => rows,
    chatAttachmentTexts: async () => new Map<string, string>(),
  } as unknown as AssistantStore
  const env = {
    FILES_KV: {
      async get(key: string): Promise<ArrayBuffer | null> {
        reads.push(key)
        const bytes = new TextEncoder().encode(bodies[key] ?? '')
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      },
    },
  } as unknown as Env
  return { store, env, reads }
}

describe('the sense a file asks of a model', () => {
  it('names a recording and a clip, whatever the browser called their type', () => {
    expect(attachmentModality('audio/mpeg', 'voice-note.mp3')).toBe('audio')
    expect(attachmentModality('', 'podcast.m4a')).toBe('audio')
    expect(attachmentModality('video/mp4', 'demo.mp4')).toBe('video')
    expect(attachmentModality('', 'screen-recording.mov')).toBe('video')
  })

  it('leaves the kinds a turn really does read alone', () => {
    // The refusal is only for what a turn cannot use at all: sweeping a picture or a document in with it
    // would take away the two paths that work today.
    expect(attachmentModality('text/markdown', 'notes.md')).toBeNull()
    expect(attachmentModality('application/pdf', 'deck.pdf')).toBeNull()
    expect(attachmentModality('image/png', 'plot.png')).toBeNull()
    expect(attachmentModality('application/json', 'data.json')).toBeNull()
  })
})

describe('what the worker really hands a model for those files', () => {
  it('reads not one byte of a recording, even for a model marked as taking audio', async () => {
    const clip = row('a1', 'voice-note.mp3', 'audio/mpeg')
    const marked = harness([clip], { [`chat/files/user/${clip.id}`]: 'ID3\x00fake-mpeg-bytes' })
    const payload = await expandChatAttachments(marked.store, marked.env, [clip.id], true, ['audio'])

    // The premise of telling the reader at attach time: a marked model gets the file's *name*, and nothing
    // else. No read from storage, no part in the request, and `images` is the only binary channel there is.
    expect(marked.reads, 'a recording the worker never needed to open was read from storage').toEqual([])
    expect(payload.images).toEqual([])
    expect(payload.block).toContain('voice-note.mp3')
    expect(payload.block).not.toContain('fake-mpeg-bytes')
    expect(payload.block).toContain(`${ATTACHMENT_MARKER}: voice-note.mp3, audio/mpeg, 1 KB] (not text; contents not read)`)
  })

  it('says so in other words when the model is not even marked', async () => {
    const clip = row('a2', 'clip.mp4', 'video/mp4')
    const plain = harness([clip], {})
    const payload = await expandChatAttachments(plain.store, plain.env, [clip.id], true, [])

    expect(plain.reads).toEqual([])
    expect(payload.images).toEqual([])
    expect(payload.block).toContain('this model is not marked as able to take video')
  })

  it('still reads the text file it is able to read', async () => {
    // The other half of the judgment: a turn that can use the bytes still uses them, so the composer's new
    // refusal cannot be blamed for a rule that refuses everything.
    const doc = row('a3', 'plan.md')
    const store = harness([doc], { [`chat/files/user/${doc.id}`]: 'the plan, in words' })
    const payload = await expandChatAttachments(store.store, store.env, [doc.id], true, [])

    expect(store.reads).toEqual([`chat/files/user/${doc.id}`])
    expect(payload.block).toContain('the plan, in words')
  })
})
