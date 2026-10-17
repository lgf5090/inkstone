// @vitest-environment jsdom
/**
 * The last accessibility and localisation floors on the composer and the transcript (UI2 final).
 *
 * Four claims are pinned here, all about what a non-pointer user is *handed*, not about where pixels land:
 *  - the note picker says when it is loading and when the search was refused, and can be driven with the
 *    arrow keys + Enter (item 1);
 *  - a disabled control's reason lives in the accessibility tree, not only in a hover tooltip (item 2);
 *  - a settled answer no longer spawns its own live region, so a conversation carries at most one
 *    announcement region instead of one per message (item 3);
 *  - no English assistant string reaches for the `model(s)` / `memor(y|ies)` plural hack (item 6).
 *
 * jsdom has no layout engine: this file asserts roles, names, structure and the class names the reduced-
 * motion styles hook (`.ink-chat-thinking`), and never a measured box or pixel.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EN_US_MESSAGES } from '@shared/locales/en-US'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { NotePicker, WebSearchMenu } from './ComposerControls'
import { AssistantBubble } from './MessageParts'

let root: Root
let host: HTMLElement

const buttons = () => [...document.body.querySelectorAll('button')]
const input = () => document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
const listbox = () => document.body.querySelector<HTMLElement>('[role="listbox"]')
const options = () => [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]

/** The chip's accessible name carries its value, so the label is a prefix of the name. */
const chipNamed = (label: string) => buttons().find((node) => (node.getAttribute('aria-label') ?? '').startsWith(label))

const type = async (text: string) => {
  const box = input()
  expect(box, 'the note picker drew no search box').toBeTruthy()
  await act(async () => {
    // React installs its own `value` setter to track edits on a controlled input, so assigning
    // `box.value` directly is invisible to it and `onChange` never fires. The native prototype setter is
    // what a real keystroke reaches, and it is what makes the search run.
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setValue?.call(box, text)
    box!.dispatchEvent(new Event('input', { bubbles: true }))
    // `run` hands the search off as a fire-and-forget promise chain, so drain a tick inside the same
    // act: a settled response lands before the list is read, a still-pending one correctly stays pending.
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const key = async (name: string) => {
  const box = input()
  await act(async () => {
    box!.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))
  })
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  installTestGlobals()
  await initI18n()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('the note picker (item 1)', () => {
  const ROWS = [{ id: 'n1', title: 'Note One' }, { id: 'n2', title: 'Note Two' }]

  it('marks the list busy while a search is in flight and shows a loading line', async () => {
    let release: (rows: { id: string, title: string }[]) => void = () => undefined
    const search = vi.fn(() => new Promise<{ id: string, title: string }[]>((resolve) => { release = resolve }))
    const onPick = vi.fn()
    await act(async () => {
      root.render(createElement(NotePicker, { open: true, onClose: () => undefined, onPick, search }))
    })
    await type('note')
    // Refused-and-empty was indistinguishable before; a real in-flight state is now its own third answer.
    expect(listbox()?.getAttribute('aria-busy')).toBe('true')
    expect(document.body.querySelector('[role="status"]')?.textContent).toContain(t('common.loading'))
    await act(async () => { release(ROWS) })
    expect(listbox()?.getAttribute('aria-busy')).toBe('false')
    expect(options().map((node) => node.textContent)).toEqual(['Note One', 'Note Two'])
  })

  it('separates a refused search from no match, and offers a retry', async () => {
    const search = vi.fn(async (query: string) => {
      if (query === 'note') throw new Error('boom')
      return ROWS
    })
    await act(async () => {
      root.render(createElement(NotePicker, { open: true, onClose: () => undefined, onPick: vi.fn(), search }))
    })
    await type('note')
    expect(search).toHaveBeenCalledTimes(1)
    const alert = document.body.querySelector('[role="alert"]')
    expect(alert, 'a failed search showed no error').toBeTruthy()
    expect(listbox()?.getAttribute('aria-busy')).toBe('false')
    const retry = buttons().find((node) => node.textContent?.includes(t('common.retry')))
    expect(retry, 'the error state offers no way to ask again').toBeTruthy()
    await act(async () => { retry!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(search).toHaveBeenCalledTimes(2)
  })

  it('walks the rows with the arrow keys and picks the highlighted one on Enter', async () => {
    const onPick = vi.fn()
    const onClose = vi.fn()
    await act(async () => {
      root.render(createElement(NotePicker, { open: true, onClose, onPick, search: async () => ROWS }))
    })
    await type('note')
    // Row one starts selected; the combobox's active row is told to the reader through the box, not focus.
    expect(input()?.getAttribute('aria-activedescendant')).toBe(options()[0]?.id)
    expect(options()[0]?.getAttribute('aria-selected')).toBe('true')
    await key('ArrowDown')
    expect(input()?.getAttribute('aria-activedescendant')).toBe(options()[1]?.id)
    expect(options()[1]?.getAttribute('aria-selected')).toBe('true')
    await key('Enter')
    expect(onPick).toHaveBeenCalledWith(ROWS[1])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape without picking anything', async () => {
    const onPick = vi.fn()
    const onClose = vi.fn()
    await act(async () => {
      root.render(createElement(NotePicker, { open: true, onClose, onPick, search: async () => ROWS }))
    })
    await type('note')
    await key('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onPick).not.toHaveBeenCalled()
  })
})

describe('a disabled control’s reason (item 2)', () => {
  it('lives in the accessibility tree, not only in a hover tooltip', () => {
    const searchLabel = t('assistant.composer.search')
    const reason = t('assistant.search.unavailable')
    act(() => { root.render(createElement(WebSearchMenu, { value: false, onChange: vi.fn(), available: false })) })
    const chip = chipNamed(searchLabel)
    expect(chip, 'the search chip is missing').toBeTruthy()
    expect(chip!.hasAttribute('disabled')).toBe(true)
    // The reason must be reachable without a pointer: an accessible description, wired by id to real text.
    const describedBy = chip!.getAttribute('aria-describedby')
    expect(describedBy, 'a disabled control carries no accessible description').toBeTruthy()
    const node = document.getElementById(describedBy!)
    expect(node, 'the description points at nothing').toBeTruthy()
    expect(node!.textContent).toBe(reason)
    // It is not smuggled in through `title`, which is hover-only and unreliable for assistive tech.
    expect(chip!.getAttribute('title')).toBe(null)
  })
})

describe('one live region per conversation (item 3)', () => {
  it('gives settled answers no live region of their own', () => {
    // Three saved replies, none streaming: before the fix each was its own `role="log"` + `aria-live`.
    act(() => {
      root.render(createElement('div', null, [0, 1, 2].map((index) => createElement(AssistantBubble, {
        key: index,
        text: `Answer number ${index}.`,
        reasoning: '',
        tools: [],
        error: null,
        streaming: false,
        messageId: `m${index}`,
      }))))
    })
    const live = [...document.body.querySelectorAll<HTMLElement>('[aria-live]:not([aria-live="off"]), [role="log"]')]
    // The announcement belongs at the conversation list level (ChatView), so a stack of messages adds none.
    expect(live.length, 'stored answers still open a live region each').toBeLessThanOrEqual(1)
  })

  it('hooks the typing dots to the reduced-motion class instead of an inline pulse', () => {
    act(() => {
      root.render(createElement(AssistantBubble, {
        text: '', reasoning: '', tools: [], error: null, streaming: true, stage: 'generating', messageId: 'live',
      }))
    })
    const dots = [...document.body.querySelectorAll('i.ink-chat-thinking')]
    expect(dots).toHaveLength(3)
    // The staggered delay that used to ride on the markup as `[animation-delay:…]` now comes from chat.css.
    expect(document.body.innerHTML).not.toContain('animation-delay:150ms')
  })
})

describe('English plurals (item 6)', () => {
  it('leaves no assistant string using a `(s)` / `(ies)` / `(y|ies)` plural hack', () => {
    const HACK = /\((?:s|ies|es|y\|ies)\)/
    const offenders = Object.entries(EN_US_MESSAGES)
      .filter(([key, value]) => key.startsWith('assistant.') && typeof value === 'string' && HACK.test(value))
      .map(([key]) => key)
    expect(offenders, `plural hacks remain: ${offenders.join(', ')}`).toEqual([])
  })

  it('counts the rephrased strings the audit named, and they read for one', () => {
    // The templates are checked against the English catalog directly, so the active locale cannot move
    // the assertion: a fixed plural label with a trailing count reads the same for one and for many.
    expect(EN_US_MESSAGES['assistant.settings.import_messages']).toBe('Messages: {count}')
    expect(EN_US_MESSAGES['assistant.schedule.every_hours']).toBe('Every {hours} h')
    expect(EN_US_MESSAGES['assistant.settings.semantic_vectors']).toBe('Memories embedded: {count}')
    expect(EN_US_MESSAGES['assistant.automations.runs_count']).toBe('Runs: {count}')
  })
})
