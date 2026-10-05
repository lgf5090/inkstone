import { act, createElement, type ReactNode, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteSummary } from '@shared/types'
import { initI18n } from '../../lib/i18n'
import { api } from '../../lib/api'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { CommandPalette } from './CommandPalette'
import { useNow } from '../../lib/hooks'

const { fuzzyCalls, splitCalls } = vi.hoisted(() => ({ fuzzyCalls: { n: 0 }, splitCalls: { n: 0 } }))

vi.mock('../../lib/fuzzy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/fuzzy')>()
  return {
    ...actual,
    fuzzyFilter: (...args: Parameters<typeof actual.fuzzyFilter>) => {
      fuzzyCalls.n += 1
      return actual.fuzzyFilter(...args)
    },
    splitByRanges: (...args: Parameters<typeof actual.splitByRanges>) => {
      splitCalls.n += 1
      return actual.splitByRanges(...args)
    },
  }
})

const NOTE_COUNT = 200
/** 30s into a minute, so a test that nudges the clock never crosses a tick boundary. */
const CLOCK_START = 1_760_000_000_000 + 30_000
let clock = CLOCK_START
const notes: Record<string, NoteSummary> = {}
for (let i = 0; i < NOTE_COUNT; i += 1) {
  const id = `note-${i}`
  notes[id] = {
    id,
    title: `Note ${i}`,
    excerpt: 'body',
    folderId: null,
    tags: [],
    isPinned: false,
    isStarred: false,
    isArchived: false,
    wordCount: 1,
    charCount: 4,
    rev: 1,
    position: i,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  }
}

const originalNotes = useNotes.getState()
const originalUi = useUi.getState()
let root: Root
let container: HTMLDivElement

function render(node: ReactNode) {
  return act(async () => {
    root.render(node)
  })
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')]
}

function highlighted(): HTMLElement[] {
  return rows().filter((row) => row.className.includes('accent-soft'))
}

/** React synthesises onMouseEnter from native mouseover, so a raw mouseenter never reaches it. */
function enterRow(row: HTMLElement) {
  row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  await initI18n()
  fuzzyCalls.n = 0
  splitCalls.n = 0
  clock = CLOCK_START
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  vi.spyOn(api, 'search').mockResolvedValue({
    results: [],
    mode: 'fts',
    took: 0,
    query: { text: '', tags: [], folder: null, starred: null, archived: null },
  })
  useNotes.setState({ notes, folders: [], tags: [], contents: {}, hydrated: true, loading: false })
  useUi.setState({ activeNoteId: null, selectedIds: [], recentNoteIds: [], view: 'all', folderId: null, tag: null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  if (root) await act(() => root.unmount())
  container?.remove()
  useNotes.setState(originalNotes, true)
  useUi.setState(originalUi, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('command palette pointer hot path', () => {
  it('rebuilds the result list once per query, not once per pointer sample', async () => {
    await render(createElement(CommandPalette, { initialQuery: 'Note', onClose: vi.fn() }))
    const options = rows()
    expect(options.length).toBeGreaterThan(10)

    const afterBuild = fuzzyCalls.n
    await act(async () => {
      for (let step = 0; step < options.length; step += 1) {
        clock += 1
        options[step]!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
        clock += 1
        options[step]!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
      }
    })

    expect(fuzzyCalls.n - afterBuild).toBe(0)
  })

  it('keeps exactly one highlighted row and never mixes CSS hover into the selection', async () => {
    await render(createElement(CommandPalette, { initialQuery: 'Note', onClose: vi.fn() }))
    const options = rows()

    await act(async () => {
      enterRow(options[7]!)
    })

    expect(highlighted()).toHaveLength(1)
    expect(highlighted()[0]).toBe(options[7])
    for (const row of options) expect(row.className).not.toMatch(/hover:bg-/)
    const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!
    expect(input.getAttribute('aria-activedescendant')).toBe(options[7]!.id)
  })

  it('repaints only the rows the highlight moved between', async () => {
    await render(createElement(CommandPalette, { initialQuery: 'Note', onClose: vi.fn() }))
    const options = rows()
    expect(options.length).toBeGreaterThan(10)

    const before = splitCalls.n
    await act(async () => {
      enterRow(options[7]!)
    })
    expect(splitCalls.n - before).toBeLessThanOrEqual(2)
  })

  it('does not scroll the list for a cursor the pointer itself moved', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    await render(createElement(CommandPalette, { initialQuery: 'Note', onClose: vi.fn() }))
    scrollIntoView.mockClear()

    await act(async () => {
      enterRow(rows()[9]!)
    })
    expect(scrollIntoView).not.toHaveBeenCalled()

    const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowDown' }))
    })
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })
})

describe('useNow', () => {
  it('holds one value between ticks so it can stay in a dependency list', async () => {
    const seen: number[] = []
    let bump: () => void = () => {}
    function Probe() {
      const [, setTick] = useState(0)
      bump = () => setTick((value) => value + 1)
      seen.push(useNow())
      return null
    }
    await render(createElement(Probe))
    await act(async () => {
      clock += 700
      bump()
    })
    await act(async () => {
      clock += 700
      bump()
    })

    expect(seen.length).toBeGreaterThanOrEqual(3)
    expect(new Set(seen).size).toBe(1)
  })
})
