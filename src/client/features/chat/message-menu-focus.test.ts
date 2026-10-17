// @vitest-environment jsdom
/**
 * Where the focus goes when a message's menu closes.
 *
 * The overflow button is a disclosure: it has to say the panel exists and whether it is down, and the
 * reader who closed it has to land back on it. `Menu` gives focus back to whatever was focused when it
 * mounted, but pressing a button is not the same as focusing one — Safari and Firefox leave the caret
 * where it was — so on those the answer after a close is `<body>`, and a keyboard reader starts the
 * thread over from the top. These cases open the panel the way a pointer does, without focusing first,
 * which is exactly the case that used to lose the reader.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { AssistantBubble } from './MessageParts'

const triggerName = () => t('assistant.chat.message_actions')

let root: Root
let host: HTMLElement

const trigger = () => document.body.querySelector<HTMLButtonElement>(`button[aria-label="${triggerName()}"]`)
const panel = () => document.body.querySelector<HTMLElement>('[role="menu"]')

function mount(): void {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => {
    root.render(createElement(AssistantBubble, {
      text: 'The answer, with a menu behind it.',
      reasoning: '',
      tools: [],
      error: null,
      streaming: false,
      messageId: 'm1',
    }))
  })
}

/** Escape, taken from the window the way the overlay layer listens for it. */
function pressEscape(): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  mount()
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  document.body.innerHTML = ''
})

describe('the overflow button', () => {
  it('says it holds a menu, and says whether that menu is down', () => {
    const button = trigger()
    expect(button, 'the message has no overflow button').toBeTruthy()
    expect(button!.getAttribute('aria-haspopup')).toBe('menu')
    expect(button!.getAttribute('aria-expanded')).toBe('false')
    act(() => { button!.click() })
    expect(trigger()!.getAttribute('aria-expanded')).toBe('true')
  })

  it('carries the focus back to the button when the panel goes away', () => {
    act(() => { trigger()!.click() })
    expect(panel(), 'the panel did not open').toBeTruthy()
    pressEscape()
    expect(panel()).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('gives the focus back when the reader picks a row too', () => {
    act(() => { trigger()!.click() })
    const row = panel()!.querySelector<HTMLButtonElement>('button[role="menuitem"]')
    expect(row, 'the panel drew no rows').toBeTruthy()
    // The row is where the keyboard would be, so a close that only knew focus history would strand the
    // reader on the body of the page.
    act(() => { row!.focus() })
    act(() => { row!.click() })
    expect(panel()).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })
})
