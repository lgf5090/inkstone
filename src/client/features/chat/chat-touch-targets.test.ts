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
import chatViewSource from './ChatView?raw'
import { TurnPinRow } from './ComposerTriggers'
import { SelectionTick } from './SelectionBar'
import assistantBubbleSource from './MessageParts?raw'
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
    mount(createElement(TurnPinRow, { tools: ['search_notes'], scopes: [], onDropTool: () => {}, onDropScope: () => {}, onOpenScopes: () => {} }))
    expectPadded(byName(t('assistant.trigger.drop_tool', { name: 'search_notes' })), 'size-4')
  })
})

describe('the pinned scope chip', () => {
  it('pads its own cross, now that the chip body is a control too', () => {
    mount(createElement(TurnPinRow, {
      tools: [],
      scopes: [{ kind: 'folder', id: 'f1', name: '工作' }],
      onDropTool: () => {},
      onDropScope: () => {},
      onOpenScopes: () => {},
    }))
    expectPadded(byName(t('assistant.trigger.drop_scope', { name: '工作' })), 'size-4')
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

const FOOTER_CONTROLS = [
  'assistant.chat.copy',
  'assistant.chat.read_aloud',
  'assistant.chat.regenerate',
  'assistant.chat.continue',
  'assistant.chat.save_to_note',
  'assistant.chat.rate_up',
  'assistant.chat.rate_down',
  'assistant.chat.message_actions',
] as const

const DENSE_CHIP_PADDING = 'py-0.5'

function mountAnswer(): void {
  mount(createElement(AssistantBubble, {
    text: 'An answer the reader has settled with.',
    reasoning: '',
    tools: [],
    error: null,
    streaming: false,
    messageId: 'm1',
    onRetry: () => {},
    retryLabel: 'assistant.chat.regenerate',
    canContinue: true,
    onRate: () => {},
  }))
}

describe('the answer footer', () => {
  it('pads the five word controls and the three icon controls it draws under 24 pixels', () => {
    mountAnswer()
    for (const key of FOOTER_CONTROLS) {
      expectPadded(byName(t(key)), DENSE_CHIP_PADDING)
    }
  })

  it('pads every dense chip control in that row, so a new one cannot arrive unpadded', () => {
    mountAnswer()
    const copy = byName(t('assistant.chat.copy'))
    expect(copy, 'the answer footer is not drawn').toBeTruthy()
    const dense = [...copy!.parentElement!.querySelectorAll<HTMLButtonElement>('button')]
      .filter((node) => ` ${node.className} `.includes(` ${DENSE_CHIP_PADDING} `))
    expect(dense.map((node) => node.getAttribute('aria-label'))).toHaveLength(FOOTER_CONTROLS.length)
    for (const node of dense) {
      expect(node.className, `${node.getAttribute('aria-label')} is drawn dense but carries no tap pad`).toContain('ink-tap-pad')
      expect(`${node.className} `, `${node.getAttribute('aria-label')} cannot place a tap pad`).toMatch(/(?:^|\s)(?:relative|absolute)\s/)
    }
  })
})

function writtenButton(text: string, file: string, needle: string): string {
  const at = text.indexOf(needle)
  expect(at, `${file} no longer writes ${needle}`).toBeGreaterThan(-1)
  const open = text.lastIndexOf('<button', at)
  expect(open, `${needle} is not written on a <button>`).toBeGreaterThan(-1)
  const close = text.indexOf('>', at)
  expect(close, `${needle} is not inside an opening tag`).toBeGreaterThan(-1)
  return text.slice(open, close)
}

describe('the context chip drawn over the composer', () => {
  it('pads a cross no component here can mount, read from the source that writes it', () => {
    const cross = writtenButton(chatViewSource, 'ChatView.tsx', 'assistant.context.remove')
    expect(cross).toMatch(/className="[^"]*\bink-tap-pad\b/)
    expect(cross).toMatch(/className="[^"]*\b(?:relative|absolute)\b/)
    expect(cross).not.toMatch(/\bh-\d|\bw-\d|\bmin-h-\d|\bsize-\d/)
  })

  it('reads a padded control when one is written, so the check above cannot pass on a blind read', () => {
    expect(writtenButton(assistantBubbleSource, 'MessageParts.tsx', 'assistant.chat.previous')).toMatch(/\bink-tap-pad\b/)
  })
})
