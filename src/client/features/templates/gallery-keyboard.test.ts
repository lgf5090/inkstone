import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteTemplate } from '@shared/types'
import { useGalleryKeyboard } from './gallery-keyboard'

function template(id: string): NoteTemplate {
  return {
    id,
    categoryId: null,
    name: id,
    description: '',
    content: 'body',
    builtin: false,
    isPinned: false,
    isStarred: false,
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  }
}

function card(id: string): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.setAttribute('data-template-id', id)
  const button = document.createElement('button')
  button.type = 'button'
  wrapper.append(button)
  return wrapper
}

interface Harness {
  deps: Parameters<typeof useGalleryKeyboard>[0]
  calls: { setQuery: unknown[]; setFocusedId: unknown[]; setIsHelpOpen: unknown[]; reorder: unknown[] }
  search: HTMLInputElement
  grid: HTMLDivElement
  buttonOf: (id: string) => HTMLElement
  scrolled: { ids: string[] }
}

function harness(ids: string[] = ['a', 'b', 'c']): Harness {
  const grid = document.createElement('div')
  grid.append(...ids.map(card))
  document.body.innerHTML = ''
  document.body.append(grid)
  const search = document.createElement('input')
  document.body.append(search)
  const calls = { setQuery: [] as unknown[], setFocusedId: [] as unknown[], setIsHelpOpen: [] as unknown[], reorder: [] as unknown[] }
  const deps = {
    editing: null,
    renaming: null,
    moving: null,
    categoryDialog: null,
    isImportOpen: false,
    isBatchMoving: false,
    publishing: null,
    isHelpOpen: false,
    isMoreOpen: false,
    setIsHelpOpen: (value: boolean) => { calls.setIsHelpOpen.push(value) },
    toggleSelectMode: () => {},
    searchRef: { current: search },
    query: 'daily',
    setQuery: (value: string) => { calls.setQuery.push(value) },
    selectMode: false,
    setSelectMode: () => {},
    visible: ids.map(template),
    setSelectedIds: () => {},
    toggleSelectAll: () => {},
    focusedId: null as string | null,
    gridRef: { current: grid },
    toggleSelect: () => {},
    reorder: (direction: string) => { calls.reorder.push(direction) },
    setFocusedId: (value: string | null) => {
      deps.focusedId = value
      calls.setFocusedId.push(value)
    },
  }
  return {
    deps: deps as unknown as Harness['deps'],
    calls,
    search,
    grid,
    scrolled,
    buttonOf: (id: string) => grid.querySelector<HTMLElement>(`[data-template-id="${id}"] button`)!,
  }
}

function press(target: EventTarget, keyName: string, shift = false) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: keyName, shiftKey: shift })
  Object.defineProperty(event, 'target', { value: target })
  const preventDefault = vi.spyOn(event, 'preventDefault')
  return { event: event as unknown as Parameters<ReturnType<typeof useGalleryKeyboard>>[0], preventDefault }
}

const scrolled = { ids: [] as string[] }

beforeEach(() => {
  vi.useFakeTimers()
  scrolled.ids = []
  Element.prototype.scrollIntoView = function () {
    const card = this.closest('[data-template-id]')
    if (card) scrolled.ids.push(card.getAttribute('data-template-id')!)
  }
})



afterEach(() => {
  vi.useRealTimers()
})

describe('gallery keyboard from inside the search box', () => {
  it('clears the query on the first Escape and keeps the dialog', () => {
    const { deps, calls, search } = harness()
    const { event, preventDefault } = press(search, 'Escape')
    useGalleryKeyboard(deps)(event)
    expect(preventDefault).toHaveBeenCalled()
    expect(calls.setQuery).toEqual([''])
  })

  it('leaves Escape alone once the query is empty, so the dialog can close', () => {
    const { deps, calls, search } = harness()
    deps.query = ''
    const { event, preventDefault } = press(search, 'Escape')
    useGalleryKeyboard(deps)(event)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(calls.setQuery).toEqual([])
  })

  it('walks the ring into the first card on ArrowDown', () => {
    const { deps, calls, search, scrolled } = harness()
    const { event, preventDefault } = press(search, 'ArrowDown')
    useGalleryKeyboard(deps)(event)
    expect(preventDefault).toHaveBeenCalled()
    expect(calls.setFocusedId).toEqual(['a'])
    vi.advanceTimersByTime(20)
    expect(scrolled.ids).toEqual(['a'])
  })

  it('keeps the caret in the field when there is nothing to walk into', () => {
    const { deps, calls, search } = harness([])
    const { event, preventDefault } = press(search, 'ArrowDown')
    useGalleryKeyboard(deps)(event)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(calls.setFocusedId).toEqual([])
  })

  it('still types a slash into the field instead of stealing the key', () => {
    const { deps, search } = harness()
    const { event, preventDefault } = press(search, '/')
    useGalleryKeyboard(deps)(event)
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('opens the help sheet from a card, where the printed hint is true', () => {
    const { deps, calls, buttonOf } = harness()
    const { event, preventDefault } = press(buttonOf('a'), '?')
    useGalleryKeyboard(deps)(event)
    expect(preventDefault).toHaveBeenCalled()
    expect(calls.setIsHelpOpen).toEqual([true])
  })

  it('moves the ring and brings the card into view with the arrows', () => {
    const { deps, buttonOf, scrolled } = harness()
    const handler = useGalleryKeyboard(deps)
    deps.focusedId = 'a'
    handler(press(buttonOf('a'), 'ArrowRight').event)
    expect(deps.focusedId).toBe('b')
    vi.advanceTimersByTime(20)
    handler(press(buttonOf('b'), 'ArrowDown').event)
    expect(deps.focusedId).toBe('c')
    vi.advanceTimersByTime(20)
    expect(scrolled.ids).toEqual(['b', 'c'])
  })

  it('gives Shift+Arrow the drag gesture', () => {
    const { deps, calls, buttonOf } = harness()
    const handler = useGalleryKeyboard(deps)
    deps.focusedId = 'b'
    handler(press(buttonOf('b'), 'ArrowRight', true).event)
    expect(calls.reorder).toEqual(['right'])
    handler(press(buttonOf('b'), 'ArrowUp', true).event)
    expect(calls.reorder).toEqual(['right', 'up'])
    expect(calls.setFocusedId).toEqual([])
  })

  it('leaves Shift+Arrow to the browser when a selection is being made', () => {
    const { deps, calls, buttonOf } = harness()
    deps.selectMode = true
    useGalleryKeyboard(deps)(press(buttonOf('b'), 'ArrowRight', true).event)
    expect(calls.reorder).toEqual([])
  })
})
