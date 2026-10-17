// @vitest-environment jsdom
/**
 * The trace an attachment leaves when this app cannot show it.
 *
 * A transcript that once carried a picture is a record of what the reader sent, so the row has to keep
 * saying so even when the bytes are gone. Dropping the id out of the index used to drop the whole block
 * with it, and a turn that had an attachment rendered as though it never had one — a silent failure with
 * nothing for the reader to act on. The same row is the honest place for a thumbnail that will not load.
 *
 * The composer's own strip is here for the same reason told the other way: those bytes are still in the
 * browser, so a failed preview is a glyph rather than a torn image, and the remove cross stays reachable.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatAttachment } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import {
  AttachmentStrip,
  CHAT_ATTACHMENT_ACCEPT,
  CHAT_FOLDER_PICKER_ATTRS,
  MessageAttachments,
} from './ChatAttachments'
import type { PendingAttachment } from './assistant-store'

const PICTURE: ChatAttachment = {
  id: 'a1', kind: 'image', filename: 'plot.png', mime: 'image/png', size: 2048, key: 'chat/images/u/a1.png', createdAt: 1,
}
const DOCUMENT: ChatAttachment = {
  id: 'a2', kind: 'file', filename: 'notes.md', mime: 'text/markdown', size: 512, key: 'chat/files/u/a2.md', createdAt: 1,
}

let root: Root
let host: HTMLElement

const gaps = () => [...document.body.querySelectorAll<HTMLElement>('[data-attachment-unavailable]')]
const chips = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const images = () => [...document.body.querySelectorAll<HTMLImageElement>('img')]

function mount(node: Parameters<Root['render']>[0]): void {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => { root.render(node) })
}

function pending(over: Partial<PendingAttachment> = {}): PendingAttachment {
  return {
    localId: 'l1',
    id: 'a1',
    filename: 'plot.png',
    mime: 'image/png',
    size: 2048,
    kind: 'image',
    progress: 1,
    status: 'ready',
    ...over,
  } as PendingAttachment
}

/** The browser's own failure signal for an image, which is what `onError` answers. */
function failToLoad(image: HTMLImageElement | undefined): void {
  expect(image, 'the thumbnail is not drawn').toBeTruthy()
  act(() => { image!.dispatchEvent(new Event('error')) })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  document.body.innerHTML = ''
})

describe('a stored turn whose file cannot be read', () => {
  it('says the attachment is unavailable rather than drawing nothing at all', () => {
    mount(createElement(MessageAttachments, { ids: ['gone'], index: {} }))
    expect(gaps()).toHaveLength(1)
    expect(gaps()[0].textContent).toContain(t('assistant.attach.unavailable'))
    // Not a control: there is nothing behind it to open, and a button that answers a press with silence
    // is the same failure this row replaces.
    expect(gaps()[0].tagName).not.toBe('BUTTON')
    expect(chips()).toHaveLength(0)
  })

  it('keeps the row it can open beside the one it cannot', () => {
    mount(createElement(MessageAttachments, { ids: ['a1', 'gone', 'a2'], index: { a1: PICTURE, a2: DOCUMENT } }))
    expect(chips()).toHaveLength(2)
    expect(gaps()).toHaveLength(1)
    expect(chips().map((node) => node.getAttribute('aria-label'))).toEqual([
      t('assistant.attach.view', { name: 'plot.png' }),
      t('assistant.attach.view', { name: 'notes.md' }),
    ])
  })

  it('turns a picture whose bytes will not arrive into the same honest gap', () => {
    mount(createElement(MessageAttachments, { ids: ['a1'], index: { a1: PICTURE } }))
    failToLoad(images()[0])
    expect(gaps()).toHaveLength(1)
    // The name survives, because a reader with three chips needs to know which one is missing.
    expect(gaps()[0].textContent).toContain('plot.png')
    expect(gaps()[0].textContent).toContain(t('assistant.attach.unavailable'))
    expect(images()).toHaveLength(0)
  })

  it('draws the picture while it is still there', () => {
    mount(createElement(MessageAttachments, { ids: ['a1'], index: { a1: PICTURE } }))
    expect(images()[0].getAttribute('src')).toBe('/api/assistant/files/a1')
    expect(gaps()).toHaveLength(0)
  })
})

describe('the composer strip', () => {
  it('keeps the file and its controls when only the preview fails', () => {
    mount(createElement(AttachmentStrip, { items: [pending()], onRemove: () => {}, onRetry: () => {} }))
    failToLoad(images()[0])
    // The bytes are the browser's own, so the chip falls back to the picture glyph rather than claiming
    // the upload was lost: the reader can still take it back out of the box.
    expect(images()).toHaveLength(0)
    expect(document.body.querySelector('svg')).toBeTruthy()
    expect(chips().some((node) => node.getAttribute('aria-label') === t('assistant.attach.remove', { name: 'plot.png' }))).toBe(true)
  })

  it('names the retry and the remove cross on a failed upload', () => {
    mount(createElement(AttachmentStrip, {
      items: [pending({ status: 'error', progress: 0.4, error: 'the upload was refused' })],
      onRemove: () => {},
      onRetry: () => {},
    }))
    expect(chips().map((node) => node.getAttribute('aria-label'))).toEqual([
      t('assistant.attach.view', { name: 'plot.png' }),
      t('assistant.attach.retry', { name: 'plot.png' }),
      t('assistant.attach.remove', { name: 'plot.png' }),
    ])
  })
})

describe('what the pickers are willing to take', () => {
  it('offers the kinds a turn can actually read, not every file on disk', () => {
    const types = CHAT_ATTACHMENT_ACCEPT.split(',')
    expect(types).toContain('image/*')
    expect(types).toContain('application/pdf')
    expect(types).toContain('.md')
    // A bare `*` is the defect: it says the picker filters nothing.
    expect(types).not.toContain('*')
    expect(types.every((entry) => entry.trim().length > 0)).toBe(true)
  })

  it('types the folder attributes instead of casting the element', () => {
    // Spread from a typed object rather than `as Record<string, string>`, which stops the compiler reading
    // the element at all.
    expect(CHAT_FOLDER_PICKER_ATTRS).toEqual({ webkitdirectory: '', directory: '' })
  })
})
