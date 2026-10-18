// @vitest-environment node
/**
 * Which attached file no turn can be given — and the proof that the answer is the truth.
 *
 * A clip is the kind a reader can drop into the composer that no turn here can use, and a recording is the
 * kind that depends on which wire the turn is written on. The composer's file and folder pickers already
 * refuse both, so this is about the three doors that do not go through a picker: a drag onto the box, a
 * paste, and a web address. What decides those is one question — can the bytes of this file ever reach a
 * model? — and it has to have one answer in one place, or the client refuses a file the worker is
 * perfectly able to read, or the other way round.
 *
 * The answer here is proved rather than asserted. Where no request format has been named for the turn,
 * `attachments.ts` hands an audio file's *name* and nothing else, and a reader told that at attach time has
 * a right to know it is actually so. So the case below hands the expansion a bucket that records every read
 * it is asked for, and shows the bucket was never opened: no bytes leave storage, no base64 joins the
 * request. What happens when a wire that does carry audio is named is `assistant-audio-attachment.test.ts`,
 * which reads this file as its other half: the same judgment, both ways round.
 */
import { describe, expect, it } from 'vitest'
import { expandChatAttachments } from '../src/worker/assistant/attachments'
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
  it('reads not one byte of a recording until a wire for it is named', async () => {
    const clip = row('a1', 'voice-note.mp3', 'audio/mpeg')
    const marked = harness([clip], { [`chat/files/user/${clip.id}`]: 'ID3\x00fake-mpeg-bytes' })
    const payload = await expandChatAttachments(marked.store, marked.env, [clip.id], true, ['audio'])

    // Ticked, and no request format has been named for the turn yet. The bytes stay in storage until a wire
    // with a field for them is known — which is what `assistant-audio-attachment.test.ts` shows being
    // honoured, and what the block says either way.
    expect(marked.reads, 'a recording with no wire named was read from storage anyway').toEqual([])
    expect(payload.images).toEqual([])
    expect(payload.audio).toEqual([])
    expect(payload.block).toContain('voice-note.mp3')
    expect(payload.block).not.toContain('fake-mpeg-bytes')
    expect(payload.block).toContain('carries no audio field')
  })

  it('says so in other words when the model is not even marked', async () => {
    const clip = row('a2', 'clip.mp4', 'video/mp4')
    const plain = harness([clip], {})
    const payload = await expandChatAttachments(plain.store, plain.env, [clip.id], true, [])

    expect(plain.reads).toEqual([])
    expect(payload.images).toEqual([])
    // No switch claims a clip any more, so the line does not blame a tick the reader never had.
    expect(payload.block).toContain('no request format in this app carries a clip')
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
