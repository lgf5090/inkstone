// @vitest-environment jsdom
/**
 * The composer says, in words, that a recording or a clip will not be read by *this* model.
 *
 * A reader who drops a `.mp3` on the box is not picking it from a file dialog — the pickers' `accept` list
 * stops at the kinds every model takes — so the drag and the paste are the doors that let it through, and
 * `attachment-upload-gate.test.ts` is the case that turns it away there before a byte is sent. What both of
 * them owe the reader is the same sentence the pickers' silence hides, and the sentence is about the model
 * the composer is standing on: a clip reaches no model at all, a recording reaches only one that was ticked
 * for it on a wire that carries it. The strip is drawn from the store rather than from an argument, so the
 * model below is named in the text the case expects — a row that only ever said "not supported" would pass
 * with the wrong model on screen. It is owed by a row that arrived anyway — a file stored by an address, or
 * one queued before the reader switched models — which is why the strip is the surface that answers here.
 * Telling it in a `title` is telling it to nobody, because the reason is only useful before the turn is paid
 * for, and a tooltip is not read before a click. So the cases below read the strip's *rendered text*, which
 * is what an eye sees, and refuse to accept a visually-hidden node or an attribute in its place.
 *
 * The same sentence belongs on the panel that opens: it is the door to the file's download, which is the one
 * thing a clip can still be asked for — and it is asked for without pulling megabytes of audio over the wire
 * to print them as mojibake in a text box, which is what the viewer used to do.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantModel, type AssistantProvider, type ChatAttachment } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../../lib/test-render'
import { useAssistant } from './assistant-store'
import { AttachmentStrip, CHAT_ATTACHMENT_ACCEPT, MessageAttachments } from './ChatAttachments'
import type { PendingAttachment } from './assistant-store'

function model(over: Partial<AssistantModel> = {}): AssistantModel {
  return {
    id: 'm1', providerId: 'p1', model: 'deepseek-chat', label: 'DeepSeek Chat', temperature: 0.4,
    maxOutputTokens: 8192, enabled: true, reasoning: 'auto', contextTokens: null, vision: true, purpose: 'chat',
    kind: 'text', supportsTools: true, maxInputTokens: null, modalities: [], topP: null, customParams: [],
    protocol: null, fallbackModelId: null, inputPrice: null, outputPrice: null, priceCurrency: '', ...over,
  }
}

const GATEWAY: AssistantProvider = {
  id: 'p1', label: 'Gateway', protocol: 'openai', baseUrl: 'https://gateway.example.org/v1', endpoints: {},
  hasKey: true, keyHint: 'abcd', reasoningDialect: null, createdAt: 1, updatedAt: 1,
}

const CLIP: ChatAttachment = {
  id: 'v1', kind: 'file', filename: 'standup.mp4', mime: 'video/mp4', size: 40_000, key: 'chat/files/u/v1.mp4', createdAt: 1,
}
const RECORDING: ChatAttachment = {
  id: 'a1', kind: 'file', filename: 'voice-note.mp3', mime: 'audio/mpeg', size: 9_000, key: 'chat/files/u/a1.mp3', createdAt: 1,
}
const NOTE: ChatAttachment = {
  id: 'd1', kind: 'file', filename: 'notes.md', mime: 'text/markdown', size: 512, key: 'chat/files/u/d1.md', createdAt: 1,
}

let rendered: RenderedElement | null = null

function pending(over: Partial<PendingAttachment> = {}): PendingAttachment {
  return {
    localId: 'l1',
    id: 'a1',
    filename: 'voice-note.mp3',
    mime: 'audio/mpeg',
    size: 9_000,
    kind: 'file',
    progress: 1,
    status: 'ready',
    ...over,
  }
}

const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const byAria = (name: string) => buttons().find((node) => node.getAttribute('aria-label') === name)
/** The sentence the reader is owed, wherever it is drawn. */
const refusalLines = () => [...document.body.querySelectorAll<HTMLElement>('[data-attachment-unreadable]')]

async function click(node: Element | undefined): Promise<void> {
  expect(node, 'the control the case is about is missing').toBeTruthy()
  await act(async () => { node!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}

/** The modal's body text, once a chip has been opened. */
function dialogText(): string {
  return document.body.querySelector('[role="dialog"]')?.textContent ?? ''
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  // A model on the one wire that does carry a recording, with the audio tick left off: the sentence the
  // strip owes is the one about that tick, and it has to name the model it was read off.
  useAssistant.setState({
    models: [model()],
    providers: [GATEWAY],
    settings: { ...DEFAULT_ASSISTANT_SETTINGS, activeModelId: 'm1' },
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response('body', { status: 200, headers: { 'content-type': 'text/plain' } })))
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('a recording dropped into the composer', () => {
  it('says the reason as text a reader sees, not as a tooltip', () => {
    rendered = renderElement(createElement(AttachmentStrip, { items: [pending()], onRemove: () => {} }))
    const said = t('assistant.attach.no_audio_switch', { model: 'DeepSeek Chat', name: 'voice-note.mp3' })

    expect(refusalLines(), 'the strip draws no reason for a file this model cannot be handed').toHaveLength(1)
    const line = refusalLines()[0]!
    expect(line.textContent).toContain(said)
    // The same words inside a `title` or an `sr-only` node would pass for a tooltip and answer nothing for
    // the person deciding whether to press send.
    expect(line.className).not.toContain('sr-only')
    expect(document.body.textContent).toContain(said)
    expect(document.body.querySelector(`[title*="${said}"]`)).toBeNull()
  })

  it('names a clip as video rather than reusing the audio sentence', () => {
    // A clip is the one refusal that is not about the model: switching to the most capable row in the
    // catalogue changes nothing, so it keeps the old sentence and gets none of the four new ones.
    useAssistant.setState({ models: [model({ modalities: ['audio'] })] })
    rendered = renderElement(createElement(AttachmentStrip, {
      items: [pending({ id: 'v1', filename: 'standup.mp4', mime: 'video/mp4' })],
      onRemove: () => {},
    }))
    expect(refusalLines()[0]!.textContent).toContain(t('assistant.attach.unreadable', { kind: t('assistant.model.modality.video'), name: 'standup.mp4' }))
  })

  it('keeps the file and its remove cross on screen', () => {
    // Refusing to read it is not refusing to show it: the row is what the reader has to be able to take back.
    rendered = renderElement(createElement(AttachmentStrip, { items: [pending()], onRemove: () => {} }))
    expect(refusalLines()).toHaveLength(1)
    expect(byAria(t('assistant.attach.remove', { name: 'voice-note.mp3' }))).toBeTruthy()
  })

  it('says nothing about the files a turn really does read', () => {
    rendered = renderElement(createElement(AttachmentStrip, {
      items: [
        pending({ localId: 'l2', id: 'd1', filename: 'notes.md', mime: 'text/markdown' }),
        pending({ localId: 'l3', id: 'p1', filename: 'plot.png', mime: 'image/png', kind: 'image' }),
        pending({ localId: 'l4', id: 'pdf1', filename: 'deck.pdf', mime: 'application/pdf', size: 400_000 }),
      ],
      onRemove: () => {},
    }))
    expect(refusalLines()).toHaveLength(0)
    expect(byAria(t('assistant.attach.view', { name: 'notes.md' }))).toBeTruthy()
  })

  it('opens the file without pulling its bytes back to print them as text', async () => {
    rendered = renderElement(createElement(AttachmentStrip, { items: [pending()], onRemove: () => {} }))
    await click(byAria(t('assistant.attach.view', { name: 'voice-note.mp3' })))

    expect(vi.mocked(fetch), 'the viewer downloaded a recording it cannot show').not.toHaveBeenCalled()
    expect(dialogText()).toContain(t('assistant.attach.unreadable_view', { kind: t('assistant.model.modality.audio') }))
    expect(document.body.querySelector('a[href="/api/assistant/files/a1?download=1"]')).toBeTruthy()
  })
})

describe('the same file inside a stored turn', () => {
  it('keeps the chip of a turn that already carried one', () => {
    rendered = renderElement(createElement(MessageAttachments, { ids: [RECORDING.id, NOTE.id], index: { [RECORDING.id]: RECORDING, [NOTE.id]: NOTE } }))
    // A recording already filed in a past turn is a record of what was sent, so its chip stays a chip; the
    // strip's pre-send warning is the composer's business, not the transcript's.
    expect(byAria(t('assistant.attach.view', { name: 'voice-note.mp3' }))).toBeTruthy()
    expect(byAria(t('assistant.attach.view', { name: 'notes.md' }))).toBeTruthy()
    expect(refusalLines()).toHaveLength(0)
  })

  it('answers a press on a stored clip with the reason and the download', async () => {
    rendered = renderElement(createElement(MessageAttachments, { ids: [CLIP.id], index: { [CLIP.id]: CLIP } }))
    await click(byAria(t('assistant.attach.view', { name: 'standup.mp4' })))

    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
    expect(dialogText()).toContain(t('assistant.attach.unreadable_view', { kind: t('assistant.model.modality.video') }))
    expect(document.body.querySelector('a[href="/api/assistant/files/v1?download=1"]')).toBeTruthy()
  })
})

describe('what the pickers offer', () => {
  it('still stops at the kinds every model takes, which is not where the answer is given', () => {
    // The `accept` list is a convenience, not the gate: it offers no recording and no clip, so the doors a
    // recording comes through are the drag, the paste and an address — and those three are answered by the
    // queue and this strip, not by an attribute a folder picker also carries.
    const types = CHAT_ATTACHMENT_ACCEPT.split(',')
    expect(types.some((entry) => entry.startsWith('audio/') || entry.startsWith('video/'))).toBe(false)
    expect(types).not.toContain('.mp3')
    expect(types).not.toContain('.mp4')
  })
})
