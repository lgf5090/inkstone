// @vitest-environment jsdom
/**
 * The rail and the panel that stand beside a thread.
 *
 * Both of them are read off the thread's own DOM — which turn has passed the reading line, and how far
 * down to land when one is chosen — so these cases lay out the boxes a browser would and then scroll:
 * a test that only counted buttons would pass over an outline that marks the wrong turn.
 */
import { act, createElement, createRef, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { titleFromMessage, type AssistantMessage } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { ChatOutline } from './ChatOutline'
import { MessageRow } from './ChatView'

const FIRST = 'Where do I put the config file?'
const SECOND = 'And what about the key file?'
const THIRD = 'Does any of this work offline?'

let root: Root
let host: HTMLElement

beforeEach(async () => {
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
})

/** jsdom measures every box as nothing, so the layout the outline reads is stated here. */
function rect(top: number): DOMRect {
  return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
}

/**
 * A thread of three turns, with the vertical positions a laid-out page would report.
 *
 * `tops` is keyed by the id the row carries, and the scroller itself sits at zero — the numbers the
 * outline compares against are therefore the ones written down here.
 */
function thread(tops: Record<string, number>, anchors: { id: string, text: string }[]) {
  const scrollerRef = createRef<HTMLDivElement>()
  act(() => {
    root.render(
      createElement(
        'div',
        null,
        createElement(
          'div',
          { ref: scrollerRef },
          ...Object.keys(tops).map((id) => createElement('div', { key: id, 'data-chat-anchor': id }, id)),
        ),
        createElement(ChatOutline, { anchors, scrollerRef }),
      ) as ReactNode,
    )
  })
  const scroller = scrollerRef.current!
  scroller.getBoundingClientRect = () => rect(0)
  for (const [id, top] of Object.entries(tops)) {
    scroller.querySelector(`[data-chat-anchor="${id}"]`)!.getBoundingClientRect = () => rect(top)
  }
  // The first measurement ran against jsdom's zeroes, so the positions just stated are handed over the
  // way a browser hands over a moved page: as the scroll the outline listens for.
  act(() => { scroller.dispatchEvent(new Event('scroll')) })
  return scroller
}

/**
 * A pointer arriving on a node, as React reads it.
 *
 * `onMouseEnter` is synthesized from a delegated `mouseover` whose `relatedTarget` sits outside the React
 * root, so the movement is always stated as coming from the page rather than from a sibling node.
 */
const pointer = (node: Element, type: 'mouseover' | 'mouseout') => act(() => {
  node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget: document.body }))
})

const three = [
  { id: 'm1', text: FIRST },
  { id: 'm2', text: SECOND },
  { id: 'm3', text: THIRD },
]

const scroll = (scroller: HTMLElement) => act(() => { scroller.dispatchEvent(new Event('scroll')) })
const toggle = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
  .find((node) => node.getAttribute('aria-label') === t('assistant.chat.outline'))
const rows = () => [...document.body.querySelectorAll<HTMLButtonElement>('nav button')]
const marked = () => document.body.querySelector('nav button[aria-current="true"]')?.textContent

describe('the conversation outline', () => {
  it('stays out of the way until a thread has turns worth navigating', () => {
    thread({ m1: 0 }, three.slice(0, 1))
    expect(toggle(), 'a rail was drawn for a single turn').toBeUndefined()
  })

  it('appears with the second turn, which is the first pair a jump can choose between', () => {
    thread({ m1: 0, m2: 400 }, three.slice(0, 2))
    expect(toggle()).toBeTruthy()
  })

  it('opens from its own button and lists the reader\'s turns in the order they were asked', () => {
    thread({ m1: 0, m2: 400, m3: 900 }, three)
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
    act(() => { toggle()!.click() })
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true')
    expect(rows().map((row) => row.textContent)).toEqual([FIRST, SECOND, THIRD].map(titleFromMessage))
  })

  it('opens while the pointer is over the rail, and folds again when it leaves', () => {
    thread({ m1: 0, m2: 400, m3: 900 }, three)
    const cluster = toggle()!.parentElement!.parentElement!
    pointer(cluster, 'mouseover')
    expect(rows()).toHaveLength(3)
    pointer(cluster, 'mouseout')
    expect(rows()).toHaveLength(0)
  })

  it('keeps the panel where a press put it, after the pointer has left the rail', () => {
    thread({ m1: 0, m2: 400, m3: 900 }, three)
    const cluster = toggle()!.parentElement!.parentElement!
    // A press on a hovered rail has to hold, not fold: the reader pressed it to keep it.
    pointer(cluster, 'mouseover')
    act(() => { toggle()!.click() })
    pointer(cluster, 'mouseout')
    expect(rows()).toHaveLength(3)
    act(() => { toggle()!.click() })
    expect(rows()).toHaveLength(0)
  })

  it('marks the turn the thread is showing, and follows it as the reader scrolls', () => {
    const scroller = thread({ m1: 0, m2: 400, m3: 900 }, three)
    act(() => { toggle()!.click() })
    expect(marked()).toBe(titleFromMessage(FIRST))
    // The second turn is now just under the top of the page: the reader has moved past the first answer.
    scroller.querySelector<HTMLElement>('[data-chat-anchor="m2"]')!.getBoundingClientRect = () => rect(10)
    scroll(scroller)
    expect(marked()).toBe(titleFromMessage(SECOND))
  })

  it('lands a chosen turn just below the top of the thread', () => {
    const scroller = thread({ m1: 0, m2: 400, m3: 900 }, three)
    const scrollTo = vi.fn()
    scroller.scrollTo = scrollTo
    act(() => { toggle()!.click() })
    act(() => { rows()[2].click() })
    expect(scrollTo).toHaveBeenCalledWith({ top: 876, behavior: 'smooth' })
  })

  it('folds on Escape without letting the key through to the surface behind it', () => {
    thread({ m1: 0, m2: 400, m3: 900 }, three)
    act(() => { toggle()!.click() })
    act(() => { toggle()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(rows()).toHaveLength(0)
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('a stored turn', () => {
  function message(): AssistantMessage {
    return {
      id: 'm1',
      conversationId: 'c1',
      role: 'user',
      content: FIRST,
      tools: [],
      status: 'complete',
      error: null,
      createdAt: 1_700_000_000_000,
      source: 'chat',
    }
  }

  it('carries the anchor the outline finds it by', () => {
    act(() => { root.render(createElement(MessageRow, { message: message() })) })
    expect(document.body.querySelector('[data-chat-anchor]')?.getAttribute('data-chat-anchor')).toBe('m1')
  })
})
