// @vitest-environment jsdom
/**
 * Which model the composer is standing on decides what a recording may be, and the refusal says which fact failed.
 *
 * The audio tick is one this app keeps: the OpenAI-compatible request builder puts `input_audio` in the same
 * part list that already carries a picture, and the worker prints a different line for each reason a
 * recording stays in storage. Until this file the composer answered all four reasons with one sentence and
 * refused every recording, so the promise the tick kept was broken on the way in — the bytes never reached
 * the worker that would have carried them.
 *
 * So the question is now asked of a target: the model `activeModelId` names, on the wire `modelWire` picks
 * for it, with the modalities the reader ticked. Four answers follow from that, and each is pinned below to
 * the one fact it names — no model to answer, a wire with no field, a model nobody ticked, a container no
 * provider decodes — together with the direction that used to be impossible: a recording that fits is
 * uploaded, and the row says nothing.
 *
 * The wire is asked before the tick on purpose. `ModelEditorDialog` draws the audio switch only where a
 * wire honours it, so telling a reader on an Anthropic line to "go tick it" sends them to a control that is
 * not there; the wire is the fact they can act on, whatever the stored tick says. `attachment-upload-gate
 * .test.ts` holds the no-byte-leaves-the-browser half, and `wired-surfaces.test.ts` is the shape these cases
 * follow: the press is followed to the next step, not merely asserted to exist.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantModel, type AssistantProvider, type ChatAttachment } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../../lib/test-render'
import { useAssistant, attachmentTargetOf, unreadableAttachmentReason } from './assistant-store'
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
    kind: 'text', supportsTools: true, maxInputTokens: null, modalities: [], topP: null, customParams: [],
    protocol: null, fallbackModelId: null, inputPrice: null, outputPrice: null, priceCurrency: '', pricePeriods: [], icon: '', ...over,
  }
}

function provider(protocol: AssistantProvider['protocol']): AssistantProvider {
  return {
    id: 'p1', label: 'Gateway', protocol, baseUrl: 'https://gateway.example.org/v1', endpoints: {},
    hasKey: true, icon: '', keyHint: 'abcd', reasoningDialect: null, createdAt: 1, updatedAt: 1,
  }
}

/** The store as the composer sees it: one model, its provider, and the row `activeModelId` points at. */
function standOn(models: AssistantModel[], wire: AssistantProvider['protocol'], activeModelId: string | null = 'm1'): void {
  useAssistant.setState({
    models,
    providers: [provider(wire)],
    settings: { ...DEFAULT_ASSISTANT_SETTINGS, activeModelId },
    pending: [],
    fileIndex: {},
  })
}

function pick(name: string, type: string, bytes = 2_048): File {
  return new File([new Uint8Array(bytes)], name, { type })
}

const MP3 = pick('voice-note.mp3', 'audio/mpeg')
const FLAC = pick('lossless.flac', 'audio/flac')
const CLIP = pick('standup.mp4', 'video/mp4')
const NOTE = pick('notes.md', 'text/markdown')

/** The four sentences, built from the catalog rather than from the function under test. */
const noTarget = (name: string) => t('assistant.attach.no_audio_target', { name })
const noWire = (model: string, name: string) => t('assistant.attach.no_audio_wire', { model, name })
const noSwitch = (model: string, name: string) => t('assistant.attach.no_audio_switch', { model, name })
const noFormat = (name: string) => t('assistant.attach.no_audio_format', { name })
const neverRead = (name: string) => t('assistant.attach.unreadable', { kind: t('assistant.model.modality.video'), name })

let rendered: RenderedElement | null = null

const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const byAria = (name: string) => buttons().find((node) => node.getAttribute('aria-label') === name)
const refusalLines = () => [...document.body.querySelectorAll<HTMLElement>('[data-attachment-unreadable]')]
const refusalText = () => refusalLines().map((node) => node.textContent ?? '')
const rows = () => useAssistant.getState().pending

async function attach(...files: File[]): Promise<void> {
  await act(async () => { await useAssistant.getState().attachFiles(files) })
}

async function click(node: Element | undefined, where: string): Promise<void> {
  expect(node, `${where} is not drawn`).toBeTruthy()
  await act(async () => { node!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}

/** The modal's body text, once a chip has been opened. */
function dialogText(): string {
  return document.body.querySelector('[role="dialog"]')?.textContent ?? ''
}

function mountStrip(): void {
  rendered?.unmount()
  rendered = renderElement(createElement(AttachmentStrip, {
    items: rows(),
    onRemove: (localId: string) => void useAssistant.getState().dropAttachment(localId),
    onRetry: (localId: string) => void useAssistant.getState().retryAttachment(localId),
  }))
}

/** The one sentence the strip draws, and the one the queue wrote into the row: the same words or nothing works. */
function expectOneReason(reason: string): void {
  expect(refusalText(), 'the strip draws the refusal in more than one place').toEqual([reason])
  expect(rows()[0]?.error, 'the row the queue left behind carries a different sentence').toBe(reason)
}

const original = useAssistant.getState()

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  uploadChatFile.mockReset().mockImplementation(async (file: File) => ({
    id: `up-${uploadChatFile.mock.calls.length}`,
    kind: file.type.startsWith('image/') ? 'image' : 'file',
    filename: file.name,
    mime: file.type,
    size: file.size,
    key: `chat/files/u/up-${uploadChatFile.mock.calls.length}`,
    createdAt: 1,
  } satisfies ChatAttachment))
  deleteChatFile.mockReset().mockResolvedValue({ deleted: true })
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
  useAssistant.setState(original, true)
})

describe('a model that was ticked for audio on the wire that carries it', () => {
  beforeEach(() => standOn([model({ modalities: ['audio'] })], 'openai'))

  it('uploads the recording instead of refusing it', async () => {
    await attach(MP3)
    expect(uploadChatFile, 'a recording the model can be handed was still turned away').toHaveBeenCalledTimes(1)
    expect(rows()[0]?.status).toBe('ready')
    expect(rows()[0]?.error, 'an accepted file carries a refusal').toBeUndefined()

    mountStrip()
    expect(refusalLines(), 'the strip still warns about a file this model reads').toHaveLength(0)
  })

  it('opens the uploaded recording as a panel that cannot draw it, not as a file this model refused', async () => {
    // The two sentences live in different places and mean different things, and the row must not blur them:
    // the queue let these bytes go, so nothing on the row may claim the model cannot take them, while the
    // panel still says what it cannot render and leaves the download as the door that works.
    await attach(MP3)
    mountStrip()
    expect(refusalLines()).toHaveLength(0)

    await click(byAria(t('assistant.attach.view', { name: 'voice-note.mp3' })), 'the chip')
    const said = dialogText()
    expect(said).toContain(t('assistant.attach.unreadable_view', { kind: t('assistant.model.modality.audio') }))
    for (const line of [
      noTarget('voice-note.mp3'),
      noWire('DeepSeek Chat', 'voice-note.mp3'),
      noSwitch('DeepSeek Chat', 'voice-note.mp3'),
      noFormat('voice-note.mp3'),
    ]) {
      expect(said, 'the viewer told the reader the model cannot be handed a file the queue just sent').not.toContain(line)
    }
    expect(document.body.querySelector('a[href="/api/assistant/files/up-1?download=1"]')).toBeTruthy()
  })

  it('still turns away a container nothing decodes, and names the file rather than the model', async () => {
    await attach(FLAC)
    expect(uploadChatFile, 'a FLAC reached the upload the provider would refuse').not.toHaveBeenCalled()
    mountStrip()
    expectOneReason(noFormat('lossless.flac'))
  })

  it('still turns away a clip, whatever the model says it takes', async () => {
    await attach(CLIP)
    expect(uploadChatFile, 'a clip was uploaded on the strength of an audio tick').not.toHaveBeenCalled()
    mountStrip()
    expectOneReason(neverRead('standup.mp4'))
  })

  it('says nothing about the files every model reads', async () => {
    await attach(NOTE)
    expect(uploadChatFile).toHaveBeenCalledTimes(1)
    mountStrip()
    expect(refusalLines()).toHaveLength(0)
  })
})

describe('a model on that wire with the tick left off', () => {
  beforeEach(() => standOn([model()], 'openai'))

  it('refuses the recording and names the model whose tick is missing', async () => {
    await attach(MP3)
    expect(uploadChatFile, 'an unmarked model was paid for bytes it cannot be given').not.toHaveBeenCalled()
    mountStrip()
    // The model is named because a catalogue with several rows has one that is ticked, and the reader has to
    // know which one to change.
    expectOneReason(noSwitch('DeepSeek Chat', 'voice-note.mp3'))
  })

  it('gives the reader the tick back, and the same row uploads on the press it now offers', async () => {
    await attach(MP3)
    mountStrip()
    expect(refusalText(), 'a press was offered while the refusal stands').toEqual([noSwitch('DeepSeek Chat', 'voice-note.mp3')])
    expect(byAria(t('assistant.attach.retry', { name: 'voice-note.mp3' }))).toBeUndefined()

    // What the reader does next is tick the model in the editor, and the row is mounted while they do it: no
    // re-picking, no reload. The refusal is read off the store on every render, so this is the seam that says
    // whether the row really follows the model or only the moment the file was dropped.
    await act(async () => { useAssistant.setState({ models: [model({ modalities: ['audio'] })] }) })

    expect(refusalLines(), 'the row still quotes a model the reader has just ticked').toHaveLength(0)
    const retry = byAria(t('assistant.attach.retry', { name: 'voice-note.mp3' }))
    expect(retry, 'no press appeared once the refusal went').toBeTruthy()
    expect(uploadChatFile).not.toHaveBeenCalled()
    await click(retry, 'the retry press')
    expect(uploadChatFile, 'the retry press never reached the upload').toHaveBeenCalledTimes(1)
    expect(rows()[0]?.status).toBe('ready')
  })
})

describe('a model called on a wire with no field for audio', () => {
  it('says the wire, not the tick, even when the tick is missing too', () => {
    // The dead end this order avoids: the editor offers no audio switch on this wire, so the second sentence
    // below would have sent the reader looking for a control that is not drawn.
    standOn([model()], 'anthropic')
    expect(unreadableFor('voice-note.mp3', 'audio/mpeg')).toBe(noWire('DeepSeek Chat', 'voice-note.mp3'))
  })

  it('says the wire for a model that was ticked, because a stale tick is not the reader’s mistake', () => {
    standOn([model({ modalities: ['audio'] })], 'anthropic')
    expect(unreadableFor('voice-note.mp3', 'audio/mpeg')).toBe(noWire('DeepSeek Chat', 'voice-note.mp3'))
  })

  it('refuses the recording at the door and draws the same sentence on the row', async () => {
    standOn([model({ modalities: ['audio'] })], 'gemini')
    await attach(MP3)
    expect(uploadChatFile).not.toHaveBeenCalled()
    mountStrip()
    expectOneReason(noWire('DeepSeek Chat', 'voice-note.mp3'))
  })

  it('leaves the files that need no audio field alone', async () => {
    standOn([model({ modalities: ['audio'] })], 'anthropic')
    await attach(NOTE)
    expect(uploadChatFile, 'a text file was caught by the audio rule').toHaveBeenCalledTimes(1)
  })
})

describe('no model to hand the bytes to', () => {
  it('says so when nothing is picked', () => {
    standOn([model({ modalities: ['audio'] })], 'openai', null)
    expect(unreadableFor('voice-note.mp3', 'audio/mpeg')).toBe(noTarget('voice-note.mp3'))
  })

  it('says so when the picked model is switched off, because a disabled row answers nothing', () => {
    standOn([model({ modalities: ['audio'], enabled: false })], 'openai')
    expect(unreadableFor('voice-note.mp3', 'audio/mpeg')).toBe(noTarget('voice-note.mp3'))
  })

  it('refuses the recording with that sentence before the store is loaded', async () => {
    standOn([], 'openai', null)
    await attach(MP3)
    expect(uploadChatFile, 'a recording was uploaded with no model to receive it').not.toHaveBeenCalled()
    mountStrip()
    expectOneReason(noTarget('voice-note.mp3'))
  })

  it('still uploads what needs no model to be marked for', async () => {
    standOn([], 'openai', null)
    await attach(NOTE)
    expect(uploadChatFile, 'a text file waited for a model that reads text anyway').toHaveBeenCalledTimes(1)
  })
})

/**
 * The composer's own question, asked of the store as it stands — the same two exported functions the queue
 * and the strip call, so a ladder pinned here cannot drift from the one the row is drawn from.
 */
function unreadableFor(name: string, mime: string): string | null {
  const state = useAssistant.getState()
  return unreadableAttachmentReason(mime, name, attachmentTargetOf(state.models, state.providers, state.settings?.activeModelId ?? null))
}
