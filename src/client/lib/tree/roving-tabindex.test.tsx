import { act, createElement, useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderElement, type RenderedElement } from '../test-render'
import { syncTreeTabIndex, useTreeKeyboard, useTreeRovingTabIndex } from './index'

function TreeProbe({ showLast = true }: { showLast?: boolean }) {
  const treeRef = useTreeRovingTabIndex()
  const onKeyDown = useTreeKeyboard()
  const [expanded, setExpanded] = useState(true)
  const row = (label: string) => createElement('button', { key: label, type: 'button', 'data-tree-row': true, tabIndex: -1, onKeyDown }, label)
  return createElement('div', null,
    createElement('div', { ref: treeRef, role: 'tree' },
      createElement('div', { role: 'treeitem', 'aria-level': 1, 'aria-expanded': expanded },
        createElement('div', null,
          createElement('button', { type: 'button', 'data-tree-toggle': true, 'aria-expanded': expanded, onClick: () => setExpanded((value) => !value) }, 'toggle A'),
          row('A'),
          createElement('button', { type: 'button' }, 'A action'),
        ),
        createElement('div', { role: 'group', inert: !expanded, 'aria-hidden': !expanded },
          createElement('div', { role: 'treeitem', 'aria-level': 2 }, row('A1')),
        ),
      ),
      showLast && createElement('div', { role: 'treeitem', 'aria-level': 1 }, row('B')),
    ),
    createElement('button', { type: 'button' }, 'after tree'),
  )
}

function ConditionalProbe({ show }: { show: boolean }) {
  const treeRef = useTreeRovingTabIndex()
  return show ? createElement('div', { ref: treeRef, role: 'tree' },
    createElement('button', { key: 'a', type: 'button', 'data-tree-row': true, tabIndex: -1 }, 'A'),
    createElement('button', { key: 'b', type: 'button', 'data-tree-row': true, tabIndex: -1 }, 'B'),
  ) : null
}

const row = (label: string) => [...document.querySelectorAll<HTMLElement>('[data-tree-row]')].find((element) => element.textContent === label)!
const tree = () => document.querySelector<HTMLElement>('[role="tree"]')!
const rowStops = () => [...tree().querySelectorAll<HTMLButtonElement>('[data-tree-row]')].filter((element) => element.tabIndex >= 0)

function sequentialStops(): HTMLElement[] {
  return [...tree().parentElement!.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')]
    .filter((element) => element.tabIndex >= 0 && !element.hasAttribute('disabled') && !element.closest('[inert], [aria-hidden="true"]'))
}

function press(element: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  act(() => { element.dispatchEvent(event) })
  return event
}

async function mutations(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

describe('roving tree tabindex', () => {
  let rendered: RenderedElement | undefined

  afterEach(() => {
    rendered?.unmount()
    rendered = undefined
  })

  it('keeps one row tabbable without making treeitem wrappers focusable', () => {
    rendered = renderElement(createElement(TreeProbe))
    expect(rowStops()).toEqual([row('A')])
    for (const item of tree().querySelectorAll<HTMLElement>('[role="treeitem"]'))
      expect(item.hasAttribute('tabindex')).toBe(false)
  })

  it('leaves Tab to native order while keeping row actions reachable', () => {
    rendered = renderElement(createElement(TreeProbe))
    expect(sequentialStops().map((element) => element.textContent)).toEqual(['toggle A', 'A', 'A action', 'after tree'])
    expect(press(row('A'), 'Tab').defaultPrevented).toBe(false)
    const stops = sequentialStops()
    expect(stops[stops.indexOf(row('A')) + 1]?.textContent).toBe('A action')
    act(() => row('B').focus())
    expect(sequentialStops().map((element) => element.textContent)).toEqual(['toggle A', 'A action', 'B', 'after tree'])
  })

  it('moves the only tab stop with arrow focus', () => {
    rendered = renderElement(createElement(TreeProbe))
    act(() => row('A').focus())
    expect(press(row('A'), 'ArrowDown').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(row('A1'))
    expect(rowStops()).toEqual([row('A1')])
    press(row('A1'), 'ArrowUp')
    expect(document.activeElement).toBe(row('A'))
    expect(rowStops()).toEqual([row('A')])
  })

  it('restores a visible stop when the focused row is collapsed', async () => {
    rendered = renderElement(createElement(TreeProbe))
    act(() => row('A1').focus())
    await act(async () => { tree().querySelector<HTMLButtonElement>('[data-tree-toggle]')!.click() })
    await mutations()
    expect(row('A1').tabIndex).toBe(-1)
    expect(rowStops()).toEqual([row('A')])
  })

  it('restores a visible stop when the focused row is removed', async () => {
    rendered = renderElement(createElement(TreeProbe))
    act(() => row('B').focus())
    rendered.rerender(createElement(TreeProbe, { showLast: false }))
    await mutations()
    expect(rowStops()).toEqual([row('A')])
  })

  it('attaches when a previously absent tree appears', () => {
    rendered = renderElement(createElement(ConditionalProbe, { show: false }))
    rendered.rerender(createElement(ConditionalProbe, { show: true }))
    expect(rowStops()).toEqual([row('A')])
  })

  it('returns no stop for an empty tree and ignores hidden preferred rows', () => {
    const host = document.createElement('div')
    host.innerHTML = '<div role="tree"><div inert><button data-tree-row>Hidden</button></div></div>'
    document.body.append(host)
    try {
      const scope = host.firstElementChild as HTMLElement
      expect(syncTreeTabIndex(scope)).toBeNull()
      expect(scope.querySelector<HTMLButtonElement>('[data-tree-row]')!.tabIndex).toBe(-1)
    }
    finally {
      host.remove()
    }
  })
})
