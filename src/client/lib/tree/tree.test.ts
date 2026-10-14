import { act, createElement, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderElement, type RenderedElement } from '../test-render'
import { stepIndex, treeIndent, treeItemProps, useExpandedSet, useTreeKeyboard } from './index'
import type { ExpandedSet } from './index'

describe('treeIndent', () => {
  it('steps in by a fixed amount per depth from a shared base', () => {
    expect(treeIndent(0)).toBe(6)
    expect(treeIndent(1)).toBe(19)
    expect(treeIndent(3)).toBe(45)
  })
})

describe('stepIndex', () => {
  it('wraps forward and backward and stays put on an empty list', () => {
    expect(stepIndex(0, 1, 3)).toBe(1)
    expect(stepIndex(2, 1, 3)).toBe(0)
    expect(stepIndex(0, -1, 3)).toBe(2)
    expect(stepIndex(0, 1, 0)).toBe(0)
  })
})

describe('treeItemProps', () => {
  it('always states the role and level, and drops fields the row cannot answer', () => {
    expect(treeItemProps({ level: 2 })).toEqual({ role: 'treeitem', 'aria-level': 2 })
  })

  it('passes through the state a branch or a selection carries', () => {
    expect(treeItemProps({ level: 1, expanded: false, selected: true, setSize: 4, posInSet: 2 })).toEqual({
      role: 'treeitem',
      'aria-level': 1,
      'aria-expanded': false,
      'aria-selected': true,
      'aria-setsize': 4,
      'aria-posinset': 2,
    })
  })
})

function ExpandedProbe({ onReady }: { onReady: (api: ExpandedSet) => void }) {
  onReady(useExpandedSet())
  return null
}

describe('useExpandedSet', () => {
  let rendered: RenderedElement | undefined
  let api: ExpandedSet | undefined

  afterEach(() => {
    rendered?.unmount()
    rendered = undefined
    api = undefined
  })

  function mount() {
    rendered = renderElement(createElement(ExpandedProbe, { onReady: (next) => { api = next } }))
  }

  it('toggles one id at a time', () => {
    mount()
    act(() => api!.toggle('a'))
    expect([...api!.expanded]).toEqual(['a'])
    act(() => api!.toggle('b'))
    expect([...api!.expanded].sort()).toEqual(['a', 'b'])
    act(() => api!.toggle('a'))
    expect([...api!.expanded]).toEqual(['b'])
  })

  it('opens or closes a whole level at once', () => {
    mount()
    act(() => api!.setMany(['a', 'b', 'c'], true))
    expect([...api!.expanded].sort()).toEqual(['a', 'b', 'c'])
    act(() => api!.setMany(['a', 'c'], false))
    expect([...api!.expanded]).toEqual(['b'])
  })

  it('replays a whole set through the raw setter', () => {
    mount()
    act(() => api!.setMany(['a/b'], true))
    act(() => api!.setExpanded((current) => new Set([...current, 'a/c'])))
    expect([...api!.expanded].sort()).toEqual(['a/b', 'a/c'])
  })
})

function TreeProbe({ onKey, initiallyExpanded = true }: {
  onKey?: (event: ReactKeyboardEvent<HTMLElement>) => boolean
  initiallyExpanded?: boolean
}) {
  const onKeyDown = useTreeKeyboard({ onKey })
  const [expanded, setExpanded] = useState(initiallyExpanded)
  const row = (label: string) => createElement('button', { 'data-tree-row': true, onKeyDown }, label)
  return createElement('div', { role: 'tree' },
    createElement('div', { role: 'treeitem', 'aria-level': 1, 'aria-expanded': expanded },
      createElement('div', null,
        createElement('button', { 'data-tree-toggle': true, 'aria-expanded': expanded, onClick: () => setExpanded((value) => !value) }, 'toggle'),
        row('A'),
      ),
      expanded
        ? createElement('div', { role: 'group' },
            createElement('div', { role: 'treeitem', 'aria-level': 2 },
              createElement('div', null, row('A1')),
            ),
          )
        : null,
    ),
    createElement('div', { role: 'treeitem', 'aria-level': 1 },
      createElement('div', null, row('B')),
    ),
  )
}

describe('useTreeKeyboard', () => {
  let rendered: RenderedElement | undefined

  afterEach(() => {
    rendered?.unmount()
    rendered = undefined
  })

  const row = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('[data-tree-row]')].find((element) => element.textContent === label)!

  function press(element: HTMLElement, key: string, init: KeyboardEventInit = {}) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
    act(() => { element.dispatchEvent(event) })
    return event
  }

  it('walks the visible rows with the arrow keys and wraps at the ends', () => {
    rendered = renderElement(createElement(TreeProbe, {}))
    act(() => row('A').focus())
    expect(press(row('A'), 'ArrowDown').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(row('A1'))
    press(row('A1'), 'ArrowUp')
    expect(document.activeElement).toBe(row('A'))
    press(row('A'), 'ArrowUp')
    expect(document.activeElement).toBe(row('B'))
  })

  it('jumps to the first and last rows with Home and End', () => {
    rendered = renderElement(createElement(TreeProbe, {}))
    act(() => row('A').focus())
    press(row('A'), 'End')
    expect(document.activeElement).toBe(row('B'))
    press(row('B'), 'Home')
    expect(document.activeElement).toBe(row('A'))
  })

  it('walks back to the parent from a leaf, then collapses the branch in place', () => {
    rendered = renderElement(createElement(TreeProbe, {}))
    const item = () => document.querySelector<HTMLElement>('[role="treeitem"][aria-level="1"]')!
    act(() => row('A1').focus())
    press(row('A1'), 'ArrowLeft')
    expect(document.activeElement).toBe(row('A'))
    expect(item().getAttribute('aria-expanded')).toBe('true')
    press(row('A'), 'ArrowLeft')
    expect(item().getAttribute('aria-expanded')).toBe('false')
  })

  it('expands a collapsed branch with ArrowRight', () => {
    rendered = renderElement(createElement(TreeProbe, { initiallyExpanded: false }))
    const item = () => document.querySelector<HTMLElement>('[role="treeitem"][aria-level="1"]')!
    act(() => row('A').focus())
    press(row('A'), 'ArrowRight')
    expect(item().getAttribute('aria-expanded')).toBe('true')
  })

  it('leaves a modifier chord alone rather than moving focus', () => {
    rendered = renderElement(createElement(TreeProbe, {}))
    act(() => row('A').focus())
    const event = press(row('A'), 'ArrowDown', { ctrlKey: true })
    expect(event.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(row('A'))
  })

  it('ignores keys during IME composition', () => {
    rendered = renderElement(createElement(TreeProbe, {}))
    act(() => row('A').focus())
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    Object.defineProperty(event, 'isComposing', { value: true })
    act(() => { row('A').dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(row('A'))
  })

  it('hands keys it does not own to the host, and prevents the default only when claimed', () => {
    const onKey = vi.fn((event: ReactKeyboardEvent<HTMLElement>) => event.key === 'F2')
    rendered = renderElement(createElement(TreeProbe, { onKey }))
    act(() => row('A').focus())
    expect(press(row('A'), 'F2').defaultPrevented).toBe(true)
    expect(onKey).toHaveBeenCalledWith(expect.objectContaining({ key: 'F2' }))
    expect(press(row('A'), 'x').defaultPrevented).toBe(false)
  })
})
