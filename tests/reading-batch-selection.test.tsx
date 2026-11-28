// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShelfCard } from '../src/client/features/reading/ShelfCard'
import { ShelfRow } from '../src/client/features/reading/ShelfRow'
import type { BookRecord } from '../src/client/features/reading/types'
import { installTestGlobals } from '../src/client/lib/test-render'

const book: BookRecord = {
  id: 'book-1', format: 'epub', title: 'Book', author: 'Author', language: 'en', publisher: '',
  filename: 'book.epub', size: 10, addedAt: 1, unitCount: 1, coverPath: null, toc: [],
}

let root: Root | null = null
let host: HTMLDivElement
afterEach(() => { act(() => root?.unmount()); root = null; host?.remove() })

function render(component: ReturnType<typeof ShelfCard> | ReturnType<typeof ShelfRow>) {
  installTestGlobals()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(component))
}

describe('shelf selection', () => {
  it('selects a card without opening it', () => {
    const onOpen = vi.fn()
    const onSelect = vi.fn()
    render(createElement(ShelfCard, { book, fraction: 0, finished: false, highlightCount: 0, noteCount: 0, selectionMode: true, selected: false, onOpen, onOpenNote: vi.fn(), onMenu: vi.fn(), onSelect }))
    const checkbox = host.querySelector<HTMLButtonElement>('[role=checkbox]')!
    expect(checkbox.getAttribute('aria-checked')).toBe('false')
    act(() => checkbox.click())
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()
    act(() => host.querySelector<HTMLButtonElement>('button[aria-pressed]')!.click())
    expect(onSelect).toHaveBeenCalledTimes(2)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('keeps the list row open action outside selection mode', () => {
    const onOpen = vi.fn()
    render(createElement(ShelfRow, { book, fraction: 0, finished: false, highlightCount: 0, noteCount: 0, onOpen, onOpenNote: vi.fn(), onMenu: vi.fn() }))
    expect(host.querySelector('[role=checkbox]')).toBeNull()
    act(() => host.querySelector<HTMLButtonElement>('button')!.click())
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('reflects the controlled selected state on the row checkbox', () => {
    render(createElement(ShelfRow, { book, fraction: 0, finished: false, highlightCount: 0, noteCount: 0, selectionMode: true, selected: true, onOpen: vi.fn(), onOpenNote: vi.fn(), onMenu: vi.fn(), onSelect: vi.fn() }))
    expect(host.querySelector('[role=checkbox]')?.getAttribute('aria-checked')).toBe('true')
    expect(host.querySelector('button[aria-pressed]')?.getAttribute('aria-pressed')).toBe('true')
  })
})
