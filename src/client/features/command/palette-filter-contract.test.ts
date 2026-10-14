import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { CommandPalette } from './CommandPalette'

/**
 * The palette took {@link useFilterInput}'s keyboard and ARIA contract instead of writing it again, and
 * it kept its own chrome and its own rows. These cases pin the two things that had to survive that:
 * Escape still belongs to the panel — it closes the palette with the text left in the box, because
 * `useEscape` answers it on window in the capture phase, before the field's handler is reached — and
 * the keys the contract does answer are answered inside the box only.
 */

let root: Root
let container: HTMLDivElement
const originalUi = useUi.getState()
const originalNotes = useNotes.getState()

function input(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('[role="combobox"]')!
}

/** The native setter, because React's own value tracker swallows a plain assignment. */
function type(value: string): void {
  const field = input()
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setValue.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(target: Element, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

function optionText(): string {
  return [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')]
    .map((row) => row.textContent ?? '')
    .join('|')
}

async function openPalette(onClose: () => void, initialQuery = ''): Promise<void> {
  await act(async () => {
    root.render(createElement(CommandPalette, { onClose, initialQuery }))
    await Promise.resolve()
  })
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  vi.spyOn(api, 'search').mockResolvedValue({
    results: [],
    mode: 'fts',
    took: 0,
    query: { text: '', tags: [], excludedTags: [], folder: null, starred: null, archived: null },
  } as never)
  useNotes.setState({ notes: {}, tags: [], folders: [], contents: {}, hydrated: true, loading: false })
  useUi.setState({ activeNoteId: null, selectedIds: [], recentNoteIds: [], panel: null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { await root.unmount() })
  container.remove()
  useUi.setState(originalUi, true)
  useNotes.setState(originalNotes, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('command palette filter contract', () => {
  it('closes on escape and leaves the typed text in the box', async () => {
    const onClose = vi.fn()
    await openPalette(onClose)
    type('rename')
    const event = press(input(), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    // The contract would have taken the text back out; the panel answered the key first, so it stays.
    expect(input().value).toBe('rename')
    expect(event.defaultPrevented).toBe(true)
  })

  it('still walks its own rows on the arrows', async () => {
    await openPalette(() => {}, '> ')
    const before = document.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.textContent ?? ''
    press(input(), { key: 'ArrowDown' })
    const after = document.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.textContent ?? ''
    expect(optionText()).not.toBe('')
    expect(after).not.toBe(before)
  })

  it('keeps a keystroke typed in the box out of the window-level listeners behind it', async () => {
    const seen: string[] = []
    const watch = (event: Event): void => { seen.push((event as KeyboardEvent).key) }
    window.addEventListener('keydown', watch)
    try {
      await openPalette(() => {})
      type('a')
      press(input(), { key: 'b' })
      expect(seen).not.toContain('b')
    }
    finally {
      window.removeEventListener('keydown', watch)
    }
  })
})
