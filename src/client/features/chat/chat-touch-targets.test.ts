// @vitest-environment jsdom
/**
 * The small controls a thumb is expected to hit.
 *
 * A remove cross, a detach chip, a tick and a pager arrow are drawn at 14 to 20 pixels, which is under the
 * 24 by 24 that WCAG 2.5.8 asks of a pointer target. The fix keeps the drawn box — the rows are dense on
 * purpose — and lays the missing area over it as an invisible child of the same control, so the press, the
 * hover and the focus ring all stay where the reader looks.
 *
 * jsdom has no layout engine, so nothing here measures a box: these assertions read the class list and the
 * element that carries it. The stylesheet rule itself is `.ink-tap-pad` in `chat.css`, and the floor it
 * aims at is `--tap-min` in `tokens.css`, both read here as structure rather than as painted pixels.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { AttachmentStrip } from './ChatAttachments'
import { TurnPinRow } from './ComposerTriggers'
import { SelectionTick } from './SelectionBar'
import { AssistantBubble } from './MessageParts'
import type { PendingAttachment } from './assistant-store'

let root: Root
let host: HTMLElement

const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
/** The control the reader aims at, found by the name a screen reader already announces. */
const byName = (name: string) => buttons().find((node) => node.getAttribute('aria-label') === name)

function mount(node: Parameters<Root['render']>[0]): void {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => { root.render(node) })
}

/** The overlay has to be positioned against the control itself, which is why the site spells it out. */
function expectPadded(control: HTMLButtonElement | HTMLElement | undefined, drawn: string): void {
  expect(control, 'the control is not drawn').toBeTruthy()
  const classes = control!.className
  expect(classes).toContain('ink-tap-pad')
  expect(classes).toContain(drawn)
  expect(`${classes} `).toMatch(/(?:^|\s)(?:relative|absolute)\s/)
}

function failedUpload(): PendingAttachment {
  return {
    localId: 'l1',
    id: '',
    filename: 'plot.png',
    mime: 'image/png',
    size: 2048,
    kind: 'image',
    progress: 0.4,
    status: 'error',
    error: 'the upload was refused',
  } as PendingAttachment
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

describe('the composer attachment chip', () => {
  it('pads the retry and the remove cross without redrawing them', () => {
    mount(createElement(AttachmentStrip, { items: [failedUpload()], onRemove: () => {}, onRetry: () => {} }))
    expectPadded(byName(t('assistant.attach.retry', { name: 'plot.png' })), 'size-4')
    expectPadded(byName(t('assistant.attach.remove', { name: 'plot.png' })), 'size-4')
  })
})

describe('the pinned tool chip', () => {
  it('pads the detach cross without redrawing it', () => {
    mount(createElement(TurnPinRow, { tools: ['search_notes'], scopes: [], onDropTool: () => {}, onDropScope: () => {} }))
    expectPadded(byName(t('assistant.trigger.drop_tool', { name: 'search_notes' })), 'size-4')
  })
})

describe('the selection tick', () => {
  it('pads the label a reader presses, and leaves the box the box', () => {
    mount(createElement(SelectionTick, { label: t('assistant.chat.select_messages'), checked: false, onToggle: () => {} }))
    const label = document.body.querySelector<HTMLLabelElement>('label')
    expectPadded(label ?? undefined, 'cursor-pointer')
    // The tick itself is the native control — keyboard focus and the ring belong to it, not to the label.
    const box = document.body.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(box, 'the tick is not a checkbox').toBeTruthy()
    expect(box!.className).toContain('size-3.5')
    expect(box!.getAttribute('aria-label')).toBe(t('assistant.chat.select_messages'))
  })
})

describe('the answer pager arrows', () => {
  it('pads both arrows without redrawing them', () => {
    mount(createElement(AssistantBubble, {
      text: 'An answer with history.',
      reasoning: '',
      tools: [],
      error: null,
      streaming: false,
      messageId: 'm1',
      versionCount: 2,
    }))
    expectPadded(byName(t('assistant.chat.previous')), 'size-5')
    expectPadded(byName(t('assistant.chat.next')), 'size-5')
  })
})
