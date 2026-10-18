// @vitest-environment node
/**
 * A recording the model is marked for has to reach the model, or the mark is a lie.
 *
 * The reader ticks `audio` in the model editor, drops a `.mp3` on the composer, and pays for a turn.
 * What that turn owes them is the one thing the tick promised: the bytes in front of a model. A tick that
 * names a file the wire never carries is the same defect class as a chip saying a document was read when
 * it was not, so both halves of the promise are proved here against the shapes the code actually writes —
 * the block the worker composes, and the body the protocol builder puts on the wire.
 *
 * The three refusals are tested alongside the delivery, because the mark being honest depends on each of
 * them naming its own reason: a model that was never ticked, a protocol line with no field for audio, a
 * container no provider decodes, a file above the ceiling that would be paid for in base64. One sentence
 * for four different answers is how a reader keeps re-uploading the same file.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ATTACHMENT_MARKER,
  expandChatAttachments,
} from '../src/worker/assistant/attachments'
import {
  ASSISTANT_MODEL_MODALITIES,
  // The ceiling the client also refuses against, so a worker that quietly moved its own number would fail
  // here rather than disagree with the sentence the composer printed.
  AUDIO_SEND_MAX_BYTES,
  audioFormatFor,
  parseModelModalities,
  protocolCarriesAudio,
  type AssistantProtocol,
  type ChatAttachment,
} from '../src/shared/assistant'
import { streamUpstream, type UpstreamRequest } from '../src/worker/assistant/upstream'
import type { AssistantStore } from '../src/worker/assistant/store'
import type { Env } from '../src/worker/env'

function row(id: string, filename: string, mime: string): ChatAttachment {
  return { id, kind: 'file', filename, mime, size: 1024, key: `chat/files/user/${id}`, createdAt: 1_700_000_000 }
}

/**
 * The rows, their bytes, and every object the expansion opened.
 *
 * The read list is the point of the harness: four of the six cases below are about bytes that must *not*
 * leave storage, and a block that says so while the code read them anyway would pass a text-only assert.
 */
function harness(rows: ChatAttachment[], bytes: Record<string, Uint8Array>) {
  const reads: string[] = []
  const store = {
    chatAttachments: async () => rows,
    chatAttachmentTexts: async () => new Map<string, string>(),
  } as unknown as AssistantStore
  const env = {
    FILES_KV: {
      async get(key: string): Promise<ArrayBuffer | null> {
        reads.push(key)
        const stored = bytes[key]
        // A fresh buffer per read: handing the same one back would let a builder that wrote into it make
        // the next case in this file pass on bytes nothing stored.
        const copy = new Uint8Array(stored?.byteLength ?? 0)
        if (stored) copy.set(stored)
        return copy.buffer
      },
    },
  } as unknown as Env
  return { store, env, reads }
}

const MP3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4, 5, 6, 7, 8])
const WAV = new Uint8Array([82, 73, 70, 70, 74, 77, 84, 32, 1, 2, 3, 4])

async function read(
  attachment: ChatAttachment,
  bytes: Record<string, Uint8Array>,
  marked: boolean,
  protocol: AssistantProtocol | null,
): Promise<{ block: string, audio: unknown[], reads: string[] }> {
  const bag = harness([attachment], bytes)
  const payload = await expandChatAttachments(
    bag.store,
    bag.env,
    [attachment.id],
    false,
    marked ? ['audio'] : [],
    true,
    protocol,
  )
  return { block: payload.block, audio: payload.audio, reads: bag.reads }
}

describe('what a model can be marked for', () => {
  it('has one value, and drops the one nobody honours', () => {
    // Nothing is migrated: a row that was saved with a clip ticked reads back with the tick gone, which is
    // what keeps the switch and the request builder from disagreeing about what the reader asked for.
    expect(ASSISTANT_MODEL_MODALITIES).toEqual(['audio'])
    expect(parseModelModalities(['audio', 'video'])).toEqual(['audio'])
    expect(parseModelModalities(['video'])).toEqual([])
    expect(parseModelModalities('audio')).toEqual([])
  })

  it('names the one wire with a field for it', () => {
    expect(protocolCarriesAudio('openai')).toBe(true)
    expect(protocolCarriesAudio('anthropic')).toBe(false)
    expect(protocolCarriesAudio('gemini')).toBe(false)
  })
})

describe('which container this app can put on the wire', () => {
  it('maps the two formats the field is documented to take', () => {
    expect(audioFormatFor('audio/mpeg', 'voice-note.mp3')).toBe('mp3')
    expect(audioFormatFor('audio/wav', 'clip.wav')).toBe('wav')
    expect(audioFormatFor('audio/x-wav', 'clip')).toBe('wav')
    // A browser hands a dragged file with no type at all, so the name has to answer on its own.
    expect(audioFormatFor('', 'standup.mp3')).toBe('mp3')
  })

  it('refuses the containers nothing decodes rather than guessing one', () => {
    // A `format` the far end does not know is a request it refuses, and a refused request costs the whole
    // turn — so an unmapped container is answered here, before the bytes are read, not by the provider.
    expect(audioFormatFor('audio/mp4', 'podcast.m4a')).toBeNull()
    expect(audioFormatFor('audio/flac', 'lossless.flac')).toBeNull()
    expect(audioFormatFor('audio/ogg', 'note.ogg')).toBeNull()
    expect(audioFormatFor('audio/aac', 'a.aac')).toBeNull()
    expect(audioFormatFor('', 'mystery')).toBeNull()
  })
})

describe('the turn a marked model is given', () => {
  it('carries the recording as an audio part when the model was ticked and the wire has the field', async () => {
    const clip = row('a1', 'voice-note.mp3', 'audio/mpeg')
    const turn = await read(clip, { [`chat/files/user/${clip.id}`]: MP3 }, true, 'openai')

    expect(turn.audio).toHaveLength(1)
    expect(turn.audio[0]).toMatchObject({ mime: 'audio/mpeg', format: 'mp3' })
    expect(turn.reads).toEqual([`chat/files/user/${clip.id}`])
    // The line the model reads says the bytes came, because this is the case where they did.
    expect(turn.block).toContain(`${ATTACHMENT_MARKER}: voice-note.mp3, audio/mpeg, 1 KB] (sent to the model with this turn)`)
  })

  it('does not name a recording as unread when it was in fact sent', async () => {
    const clip = row('a2', 'greeting.wav', 'audio/wav')
    const turn = await read(clip, { [`chat/files/user/${clip.id}`]: WAV }, true, 'openai')
    expect(turn.audio).toHaveLength(1)
    expect(turn.block).not.toContain('not text; contents not read')
  })

  it('reads not one byte when the model was never ticked, and says which tick is missing', async () => {
    const clip = row('a3', 'voice-note.mp3', 'audio/mpeg')
    const turn = await read(clip, { [`chat/files/user/${clip.id}`]: MP3 }, false, 'openai')
    expect(turn.reads, 'an unmarked model cost a storage read it was never going to be given').toEqual([])
    expect(turn.audio).toEqual([])
    expect(turn.block).toContain('not marked as able to take audio')
  })

  it('says the wire, not the tick, when the marked model speaks a protocol with no audio field', async () => {
    const clip = row('a4', 'voice-note.mp3', 'audio/mpeg')
    const turn = await read(clip, { [`chat/files/user/${clip.id}`]: MP3 }, true, 'anthropic')
    // Two different answers, and the reader has to be able to tell them apart: one is fixed by ticking the
    // model, the other by picking a different model.
    expect(turn.reads).toEqual([])
    expect(turn.audio).toEqual([])
    expect(turn.block).toContain('carries no audio')
    expect(turn.block).not.toContain('not marked')
  })

  it('says the container when the file is one nothing decodes', async () => {
    const clip = row('a5', 'podcast.m4a', 'audio/mp4')
    const turn = await read(clip, { [`chat/files/user/${clip.id}`]: MP3 }, true, 'openai')
    expect(turn.reads).toEqual([])
    expect(turn.audio).toEqual([])
    expect(turn.block).toContain('audio/mp4')
    expect(turn.block).toContain('not a container the request carries')
  })

  it('leaves a recording above the ceiling in storage and prints its number', async () => {
    const clip = { ...row('a6', 'huge.mp3', 'audio/mpeg'), size: AUDIO_SEND_MAX_BYTES + 1 }
    const turn = await read(clip, { [`chat/files/user/${clip.id}`]: MP3 }, true, 'openai')
    expect(turn.reads, 'a file already known to be too big was read anyway').toEqual([])
    expect(turn.audio).toEqual([])
    expect(turn.block).toContain('larger than')
  })
})

/** The body one protocol would be sent for a turn that carries an audio part. */
async function sentBody(protocol: AssistantProtocol, turn: UpstreamRequest['turns'][number]): Promise<string> {
  let captured = ''
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    captured = String(init?.body ?? '')
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }))
  const request = {
    baseUrl: 'https://api.example.com',
    apiKey: 'sk-test',
    model: 'm',
    signal: new AbortController().signal,
    system: 's',
    turns: [turn],
    tools: [],
    maxOutputTokens: 128,
    temperature: 0.2,
    reasoning: 'auto',
  } as unknown as UpstreamRequest
  for await (const _event of streamUpstream(protocol, request)) void _event
  vi.unstubAllGlobals()
  return captured
}

describe('the audio part on the wire', () => {
  it('puts input_audio beside the text on the OpenAI-compatible branch', async () => {
    const body = await sentBody('openai', {
      role: 'user',
      content: '这段录音里说了什么？',
      audio: [{ mime: 'audio/mpeg', format: 'mp3', base64: 'Zm9vYmFy' }],
    })
    expect(body).toContain('"type":"input_audio"')
    // The field takes bare base64, not a data URL: a `data:` prefix is a byte the decoder does not expect.
    expect(body).toContain('"data":"Zm9vYmFy"')
    expect(body).toContain('"format":"mp3"')
    expect(body).not.toContain('data:audio/mpeg;base64,')
    // And the reader's own words are still in the same part list.
    expect(body).toContain('"type":"text"')
  })

  it('sends no audio field on the two branches that have none', async () => {
    // A part a provider does not know is a 400 for the whole turn, so the expansion above is what decides
    // a recording travels, and a stray field reaching the other two builders would mean both are wrong.
    const anthropic = await sentBody('anthropic', {
      role: 'user',
      content: '这段录音里说了什么？',
      audio: [{ mime: 'audio/mpeg', format: 'mp3', base64: 'Zm9vYmFy' }],
    })
    expect(anthropic).not.toContain('input_audio')
    const gemini = await sentBody('gemini', {
      role: 'user',
      content: '这段录音里说了什么？',
      audio: [{ mime: 'audio/mpeg', format: 'mp3', base64: 'Zm9vYmFy' }],
    })
    expect(gemini).not.toContain('inputAudio')
    expect(gemini).not.toContain('input_audio')
  })
})
