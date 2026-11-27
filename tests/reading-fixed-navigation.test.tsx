// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReaderView } from '../src/client/features/reading/reader/ReaderView'
import { installTestGlobals } from '../src/client/lib/test-render'
import type { BookPosition } from '../src/client/features/reading/position'
import type { BookFormat, BookRecord, Highlight, LocationMark } from '../src/client/features/reading/types'

const mocks = vi.hoisted(() => ({
  fixedCurrent: vi.fn<() => BookPosition | null>(),
  fixedGoTo: vi.fn<(position: BookPosition) => void>(),
  epubCurrent: vi.fn<() => BookPosition | null>(),
  epubGoTo: vi.fn<(position: BookPosition) => void>(),
  prompt: vi.fn(),
  toast: vi.fn(),
  library: {
    highlights: {} as Record<string, Highlight[]>,
    marks: {} as Record<string, LocationMark[]>,
    progress: {},
    stats: {},
    notes: { byBook: {} },
    sync: { phase: 'idle' },
    setProgress: vi.fn(),
    addHighlight: vi.fn(),
    updateHighlight: vi.fn(),
    removeHighlight: vi.fn(),
    addMark: vi.fn(),
    linkNote: vi.fn(),
  },
}))

vi.mock('../src/client/lib/i18n', () => ({
  t: (key: string, values?: Record<string, unknown>) => `${key}${values ? `:${JSON.stringify(values)}` : ''}`,
}))
vi.mock('../src/client/lib/api', () => ({ ApiError: class ApiError extends Error {} }))
vi.mock('../src/client/lib/app-history', () => ({ navigateToPath: vi.fn() }))
vi.mock('../src/client/store/notes', () => ({ useNotes: { getState: () => ({ openNote: vi.fn() }) } }))
vi.mock('../src/client/store/ui', () => ({
  useUi: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({
      theme: 'light', background: 'plain', toast: mocks.toast, assistantDockOpen: false, toggleAssistantDock: vi.fn(),
    }),
    { getState: () => ({ toast: mocks.toast, openExplorer: vi.fn() }) },
  ),
}))
vi.mock('../src/client/features/reading/store/library', () => ({
  useLibrary: Object.assign(
    (selector: (state: typeof mocks.library) => unknown) => selector(mocks.library),
    { getState: () => mocks.library },
  ),
}))
vi.mock('../src/client/features/reading/store/reader-settings', () => ({
  useReaderSettings: () => ({
    theme: 'paper', immersive: false, tapZones: 'off', swipeTurns: false, estimateTimeLeft: false,
    showScrubber: false, timerEnabled: false, readMode: 'paged', pageButtons: 'always', selectionLabels: false,
    dimming: 0, dailyGoalMinutes: 15, autoBookNote: false, defaultHighlightColor: 'yellow',
  }),
}))
vi.mock('../src/client/features/reading/themes', () => ({
  resolveReaderTheme: () => ({ background: '#fff', foreground: '#111', muted: '#666', accent: '#567' }),
  DEFAULT_HIGHLIGHT_PAINT: { yellow: '#ff0', green: '#0f0', blue: '#00f', pink: '#f0f', red: '#f00', purple: '#808' },
}))
vi.mock('../src/client/features/reading/page-context', () => ({
  useReadingPage: (selector: (state: { setOpenBook: () => void }) => unknown) => selector({ setOpenBook: vi.fn() }),
}))
vi.mock('../src/client/features/reading/reader/useEpubHandle', () => ({
  useEpubHandle: () => ({ handle: { pkg: { spine: [] } }, error: null }),
}))
vi.mock('../src/client/features/reading/reader/FixedStage', async () => {
  const { forwardRef, useImperativeHandle } = await import('react')
  return {
    FixedStage: forwardRef(function FixedStage(_props: unknown, ref) {
      useImperativeHandle(ref, () => ({
        next: vi.fn(), prev: vi.fn(), current: mocks.fixedCurrent, goTo: mocks.fixedGoTo,
        indexBook: vi.fn(async () => ({ pages: 0, chunks: 0 })),
      }))
      return null
    }),
  }
})
vi.mock('../src/client/features/reading/reader/EpubStage', async () => {
  const { forwardRef, useImperativeHandle } = await import('react')
  return {
    EpubStage: forwardRef(function EpubStage(_props: unknown, ref) {
      useImperativeHandle(ref, () => ({
        next: vi.fn(), prev: vi.fn(), current: mocks.epubCurrent, goTo: mocks.epubGoTo,
        goToFraction: vi.fn(), chapterIndex: () => 0, relayout: vi.fn(), readAloud: vi.fn(() => ({ text: '第一句', offset: 0, language: 'zh-CN' })), indexBook: vi.fn(async () => ({ pages: 0, chunks: 0 })),
      }))
      return null
    }),
  }
})
vi.mock('../src/client/components/primitives', async () => {
  const { createElement } = await import('react')
  const Button = ({ children, onClick }: { children?: React.ReactNode; onClick?: () => void }) => createElement('button', { onClick }, children)
  const IconButton = ({ children, label, onClick }: { children?: React.ReactNode; label: string; onClick?: () => void }) => createElement('button', { 'aria-label': label, onClick }, children)
  return { Button, IconButton }
})
vi.mock('../src/client/components/form', () => ({ Textarea: () => null }))
vi.mock('../src/client/components/overlay', () => ({
  Menu: () => null,
  Tooltip: ({ children }: { children?: React.ReactNode }) => children,
  prompt: mocks.prompt,
}))
vi.mock('../src/client/features/reading/reader/PageStatus', () => ({ PageStatus: () => null }))
vi.mock('../src/client/features/reading/reader/FootnotePopover', () => ({ FootnotePopover: () => null }))
vi.mock('../src/client/features/reading/reader/SelectionToolbar', () => ({ SelectionToolbar: () => null }))
vi.mock('../src/client/features/reading/reader/TocPanel', () => ({ TocPanel: () => null }))
vi.mock('../src/client/features/reading/reader/AppearancePanel', () => ({ AppearancePanel: () => null }))
vi.mock('../src/client/features/reading/reader/SearchPanel', () => ({ SearchPanel: () => null }))
vi.mock('../src/client/features/reading/reader/CommentCard', () => ({ CommentCard: () => null }))
vi.mock('../src/client/features/reading/reader/LookupCard', () => ({ LookupCard: () => null }))
vi.mock('../src/client/features/reading/reader/ShortcutsPanel', () => ({ ShortcutsPanel: () => null }))
vi.mock('../src/client/features/reading/reader/StatsPanel', () => ({ StatsPanel: () => null }))
vi.mock('../src/client/features/reading/reader/useReadingTimer', () => ({
  useReadingTimer: () => ({ todaySeconds: 0, sessionSeconds: 0 }),
}))
vi.mock('../src/client/features/reading/engine/book-search', () => ({ searchBook: vi.fn(async () => []) }))
vi.mock('../src/client/features/reading/lookup', () => ({
  lookupSelection: vi.fn(), vocabularyEntry: vi.fn(), hasLegacyLocalAiKey: () => false,
}))
vi.mock('../src/client/features/reading/vocabulary', () => ({ ensureVocabularyNote: vi.fn() }))

const book: BookRecord = {
  id: 'fixed-book', format: 'pdf', title: 'Fixed book', author: '', language: '', publisher: '',
  filename: 'book.pdf', size: 1, addedAt: 1, unitCount: 20, coverPath: null, toc: [],
}

function highlight(chapter = 4): Highlight {
  return {
    id: 'h1', bookId: book.id, chapter, start: 12, end: 20, color: 'yellow', quote: '被划线的句子',
    prefix: '', suffix: '', comment: '', createdAt: 1, updatedAt: 1,
  }
}

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  installTestGlobals()
  mocks.library.highlights = { [book.id]: [highlight()] }
  mocks.library.marks = { [book.id]: [{ id: 'm1', bookId: book.id, label: '第 9 页', position: { kind: 'fixed', page: 9 }, createdAt: 1 }] }
  mocks.fixedCurrent.mockReturnValue({ kind: 'fixed', page: 7 })
  mocks.epubCurrent.mockReturnValue({ kind: 'epub', chapter: 2, offset: 8 })
  mocks.prompt.mockResolvedValue('位置书签')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.clearAllMocks()
})

async function render(format: BookFormat): Promise<void> {
  await act(async () => { root.render(<ReaderView book={{ ...book, format }} />) })
}

function press(key: string): void {
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })
}

describe('fixed-layout reader navigation', () => {
  it.each(['pdf', 'cbz'] as const)('jumps a %s highlight through the fixed stage', async (format) => {
    await render(format)
    press('h')
    const quote = [...host.querySelectorAll('button')].find((button) => button.textContent === '被划线的句子')
    expect(quote).toBeTruthy()
    act(() => quote!.click())
    expect(mocks.fixedGoTo).toHaveBeenCalledWith({ kind: 'fixed', page: 5 })
    expect(mocks.epubGoTo).not.toHaveBeenCalled()
  })

  it.each(['pdf', 'cbz'] as const)('jumps a %s location mark through the fixed stage', async (format) => {
    await render(format)
    press('b')
    const mark = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('第 9 页'))
    expect(mark).toBeTruthy()
    act(() => mark!.click())
    expect(mocks.fixedGoTo).toHaveBeenCalledWith({ kind: 'fixed', page: 9 })
    expect(mocks.epubGoTo).not.toHaveBeenCalled()
  })

  it.each(['pdf', 'cbz'] as const)('adds a %s location mark from the fixed stage current position', async (format) => {
    await render(format)
    press('m')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(mocks.fixedCurrent).toHaveBeenCalled()
    expect(mocks.epubCurrent).not.toHaveBeenCalled()
    expect(mocks.library.addMark).toHaveBeenCalledWith({
      bookId: book.id, label: '位置书签', position: { kind: 'fixed', page: 7 },
    })
  })

  it('keeps EPUB jumps and marks on the EPUB stage', async () => {
    await render('epub')
    press('h')
    const quote = [...host.querySelectorAll('button')].find((button) => button.textContent === '被划线的句子')
    act(() => quote!.click())
    expect(mocks.epubGoTo).toHaveBeenCalledWith({ kind: 'epub', chapter: 4, offset: 12 }, undefined)
    press('Escape')
    press('m')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(mocks.epubCurrent).toHaveBeenCalled()
    expect(mocks.fixedCurrent).not.toHaveBeenCalled()
    expect(mocks.library.addMark).toHaveBeenCalledWith({
      bookId: book.id, label: '位置书签', position: { kind: 'epub', chapter: 2, offset: 8 },
    })
  })
})
