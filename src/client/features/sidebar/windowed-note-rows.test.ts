import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteSummary } from '@shared/types'
import { WindowedNoteRows } from './windowed-note-rows'

vi.mock('../../lib/hooks', () => ({ useBreakpoint: () => 'desktop' }))

function note(index: number): NoteSummary {
  return {
    id: `note-${index}`,
    title: `Note ${index}`,
    excerpt: '',
    folderId: null,
    tags: [],
    isPinned: false,
    isStarred: false,
    isArchived: false,
    wordCount: 0,
    charCount: 0,
    rev: 1,
    position: index,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  }
}

let root: Root
let scroller: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  scroller = document.createElement('div')
  scroller.style.overflowY = 'auto'
  document.body.appendChild(scroller)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === scroller) return { top: 0, bottom: 300, left: 0, right: 200, width: 200, height: 300, x: 0, y: 0, toJSON() {} }
    if (this.hasAttribute('data-sidebar-window')) {
      const top = -scroller.scrollTop
      return { top, bottom: top + 3100, left: 0, right: 200, width: 200, height: 3100, x: 0, y: top, toJSON() {} }
    }
    return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} }
  })
  root = createRoot(scroller)
})

afterEach(async () => {
  await act(async () => root.unmount())
  scroller.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('windowed sidebar notes', () => {
  it('keeps rows bounded and moves keyboard focus across the window edge', async () => {
    const notes = Array.from({ length: 100 }, (_, index) => note(index))
    await act(async () => root.render(createElement(WindowedNoteRows, {
      notes,
      resetKey: 'notes',
      renderNote: (item) => createElement('button', { key: item.id, type: 'button', 'data-tree-row': true }, item.title),
    })))
    expect(scroller.querySelectorAll('[data-tree-row]').length).toBeLessThan(100)

    const edge = scroller.querySelector<HTMLButtonElement>('[data-sidebar-note-index="13"] [data-tree-row]')!
    await act(async () => edge.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
    expect(scroller.scrollTop).toBeGreaterThan(0)
    expect(document.activeElement?.textContent).toBe('Note 14')
    expect(scroller.querySelectorAll('[data-tree-row]').length).toBeLessThan(100)
  })
})
