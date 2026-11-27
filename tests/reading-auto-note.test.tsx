// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReaderView } from '../src/client/features/reading/reader/ReaderView'
import type { EpubStageHandle, StageSelection } from '../src/client/features/reading/reader/EpubStage'
import { installTestGlobals } from '../src/client/lib/test-render'
import type { BookRecord, Highlight } from '../src/client/features/reading/types'

const mocks = vi.hoisted(() => ({
  scheduleRefresh: vi.fn(),
  ensureReadingNote: vi.fn(),
  toast: vi.fn(),
  prompt: vi.fn(),
  library: {
    highlights: {} as Record<string, Highlight[]>,
    marks: {},
    progress: {},
    stats: {},
    notes: { byBook: {} as Record<string, string> },
    sync: { phase: 'idle' },
    setProgress: vi.fn(),
    addHighlight: vi.fn(),
    updateHighlight: vi.fn(),
    removeHighlight: vi.fn(),
    addMark: vi.fn(),
    removeMark: vi.fn(),
    linkNote: vi.fn(),
  },
  settings: {
    theme: 'paper', immersive: false, tapZones: 'off', swipeTurns: false, estimateTimeLeft: false,
    showScrubber: false, timerEnabled: false, readMode: 'paged', pageButtons: 'always', selectionLabels: false,
    dimming: 0, dailyGoalMinutes: 15, autoBookNote: true, defaultHighlightColor: 'yellow',
    translateTo: 'zh-CN', translateEngine: 'google',
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
  useReaderSettings: () => mocks.settings,
}))
vi.mock('../src/client/features/reading/reader/use-auto-reading-note', () => ({
  useAutoReadingNote: () => mocks.scheduleRefresh,
}))
vi.mock('../src/client/features/reading/reading-note', () => ({
  ensureReadingNote: mocks.ensureReadingNote,
}))
vi.mock('../src/client/features/reading/themes', () => ({
  resolveReaderTheme: () => ({ background: '#fff', foreground: '#111', muted: '#666', accent: '#567' }),
  DEFAULT_HIGHLIGHT_PAINT: { yellow: '#ff0', green: '#0f0', blue: '#00f', pink: '#f0f', red: '#f00', purple: '#808' },
}))
vi.mock('../src/client/features/reading/page-context', () => ({
  useReadingPage: (selector: (state: { setOpenBook: () => void }) => unknown) => selector({ setOpenBook: vi.fn() }),
}))
vi.mock('../src/client/features/reading/reader/useEpubHandle', () => ({
  useEpubHandle: () => ({ handle: { pkg: { spine: [{ item: { href: 'chapter.xhtml' } }] } }, error: null }),
}))
vi.mock('../src/client/features/reading/reader/FixedStage', async () => {
  const { forwardRef, useImperativeHandle } = await import('react')
  return {
    FixedStage: forwardRef(function FixedStage(_props: unknown, ref) {
      useImperativeHandle(ref, () => ({
        next: vi.fn(), prev: vi.fn(), current: vi.fn(() => null), goTo: vi.fn(),
        indexBook: vi.fn(async () => ({ pages: 0, chunks: 0 })),
      }))
      return null
    }),
  }
})
vi.mock('../src/client/features/reading/reader/EpubStage', async () => {
  const { createElement, forwardRef, useImperativeHandle } = await import('react')
  type Props = {
    onSelection?: (selection: StageSelection) => void
    onMarkClick?: (ids: string[], rect: DOMRect) => void
  }
  return {
    EpubStage: forwardRef<EpubStageHandle, Props>(function EpubStage(props, ref) {
      useImperativeHandle(ref, () => ({
        next: vi.fn(), prev: vi.fn(), goTo: vi.fn(), goToFraction: vi.fn(),
        current: vi.fn(() => ({ kind: 'epub' as const, chapter: 0, offset: 0 })), chapterIndex: () => 0, relayout: vi.fn(),
      }))
      return createElement('div', null,
        createElement('button', {
          onClick: () => props.onSelection?.({ start: 0, end: 5, text: '第一句', rect: new DOMRect(0, 0, 10, 10) }),
        }, 'select'),
        createElement('button', {
          onClick: () => props.onMarkClick?.(['h1'], new DOMRect(0, 0, 10, 10)),
        }, 'open-comment'),
      )
    }),
  }
})
vi.mock('../src/client/components/primitives', async () => {
  const { createElement } = await import('react')
  const Button = ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => createElement('button', { onClick }, children)
  const IconButton = ({ children, label, onClick }: { children?: ReactNode; label: string; onClick?: () => void }) => createElement('button', { 'aria-label': label, onClick }, children)
  return { Button, IconButton }
})
vi.mock('../src/client/components/form', () => ({ Textarea: () => null }))
vi.mock('../src/client/components/overlay', () => ({
  Menu: () => null,
  Tooltip: ({ children }: { children?: ReactNode }) => children,
  prompt: mocks.prompt,
}))
vi.mock('../src/client/features/reading/reader/PageStatus', () => ({ PageStatus: () => null }))
vi.mock('../src/client/features/reading/reader/FootnotePopover', () => ({ FootnotePopover: () => null }))
vi.mock('../src/client/features/reading/reader/SelectionToolbar', async () => {
  const { createElement } = await import('react')
  return {
    SelectionToolbar: ({ onHighlight, onComment }: { onHighlight: (color: Highlight['color']) => void; onComment: () => void }) => createElement('div', null,
      createElement('button', { onClick: () => onHighlight('yellow') }, 'highlight'),
      createElement('button', { onClick: onComment }, 'comment'),
    ),
  }
})
vi.mock('../src/client/features/reading/reader/ReaderPanel', () => ({
  ReaderPanel: ({ children }: { children?: ReactNode }) => children,
}))
vi.mock('../src/client/features/reading/reader/TocPanel', () => ({ TocPanel: () => null }))
vi.mock('../src/client/features/reading/reader/AppearancePanel', () => ({ AppearancePanel: () => null }))
vi.mock('../src/client/features/reading/reader/HighlightsPanel', async () => {
  const { createElement } = await import('react')
  return {
    HighlightsPanel: ({ list, onComment, onRemove }: { list: Highlight[]; onComment: (id: string, comment: string) => void; onRemove: (id: string) => void }) => createElement('div', null,
      ...list.map((highlight) => createElement('div', { key: highlight.id },
        createElement('button', { onClick: () => onComment(highlight.id, 'edited') }, `edit:${highlight.id}`),
        createElement('button', { onClick: () => onRemove(highlight.id) }, `delete:${highlight.id}`),
      )),
    ),
  }
})
vi.mock('../src/client/features/reading/reader/MarksPanel', () => ({ MarksPanel: () => null }))
vi.mock('../src/client/features/reading/reader/SearchPanel', () => ({ SearchPanel: () => null }))
vi.mock('../src/client/features/reading/reader/CommentCard', async () => {
  const { createElement } = await import('react')
  return {
    CommentCard: ({ ids, onEdit, onRemove }: { ids: string[]; onEdit: (id: string, patch: { comment: string }) => void; onRemove: (id: string) => void }) => createElement('div', null,
      ...ids.map((id) => createElement('div', { key: id },
        createElement('button', { onClick: () => onEdit(id, { comment: 'card edit' }) }, `card-edit:${id}`),
        createElement('button', { onClick: () => onRemove(id) }, `card-remove:${id}`),
      )),
    ),
  }
})
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
  id: 'book-1', format: 'epub', title: '测试书', author: '', language: 'zh-CN', publisher: '',
  filename: 'book.epub', size: 1, addedAt: 1, unitCount: 1, coverPath: null,
  toc: [{ label: '第一章', position: { kind: 'epub', chapter: 0, offset: 0 }, level: 0 }],
}

function highlight(overrides: Partial<Highlight> = {}): Highlight {
  return {
    id: 'h1', bookId: book.id, chapter: 0, start: 0, end: 5, color: 'yellow', quote: '第一句',
    prefix: '', suffix: '', comment: '', createdAt: 1, updatedAt: 1, ...overrides,
  }
}

let root: Root | null = null
let host: HTMLDivElement
let useActualAutoReadingNote: typeof import('../src/client/features/reading/reader/use-auto-reading-note').useAutoReadingNote
let scheduled: (() => void) | null = null

beforeAll(async () => {
  const actual = await vi.importActual<typeof import('../src/client/features/reading/reader/use-auto-reading-note')>(
    '../src/client/features/reading/reader/use-auto-reading-note',
  )
  useActualAutoReadingNote = actual.useAutoReadingNote
})

beforeEach(() => {
  installTestGlobals()
  vi.clearAllMocks()
  mocks.settings.autoBookNote = true
  mocks.library.highlights = {}
  mocks.library.notes.byBook = {}
  mocks.library.addHighlight.mockReturnValue(highlight())
  mocks.ensureReadingNote.mockResolvedValue('note-1')
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(() => {
  unmount()
  host.remove()
  vi.useRealTimers()
})

function mount(node: ReactNode): void {
  if (!root) root = createRoot(host)
  act(() => { root!.render(node) })
}

function rerender(node: ReactNode): void {
  mount(node)
}

function unmount(): void {
  if (!root) return
  act(() => root!.unmount())
  root = null
}

function clickText(text: string): void {
  const button = [...host.querySelectorAll('button')].find((one) => one.textContent === text)
  if (!button) throw new Error(`Missing button: ${text}`)
  act(() => button.click())
}

function clickLabel(label: string): void {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!button) throw new Error(`Missing labelled button: ${label}`)
  act(() => button.click())
}

function AutoNoteHarness({ book: currentBook, enabled }: { book: BookRecord; enabled: boolean }) {
  scheduled = useActualAutoReadingNote(currentBook, enabled)
  return null
}

function schedule(): void {
  if (!scheduled) throw new Error('Auto note hook was not rendered')
  act(() => scheduled!())
}

async function advance(ms = 500): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

describe('useAutoReadingNote', () => {
  beforeEach(() => vi.useFakeTimers())

  it('creates and links the note on the first highlight', async () => {
    const first = highlight()
    mocks.library.highlights = { [book.id]: [first] }
    mount(<AutoNoteHarness book={book} enabled />)

    schedule()
    await advance()

    expect(mocks.ensureReadingNote).toHaveBeenCalledWith(book, [first], undefined)
    expect(mocks.library.linkNote).toHaveBeenCalledWith(book.id, 'note-1')
  })

  it('debounces a second highlight and refreshes the linked note with the latest marks', async () => {
    const first = highlight()
    const second = highlight({ id: 'h2', start: 10, end: 15, quote: '第二句' })
    mocks.library.notes.byBook = { [book.id]: 'note-1' }
    mocks.library.highlights = { [book.id]: [first] }
    mount(<AutoNoteHarness book={book} enabled />)

    schedule()
    mocks.library.highlights = { [book.id]: [first, second] }
    schedule()
    await advance(499)
    expect(mocks.ensureReadingNote).not.toHaveBeenCalled()
    await advance(1)

    expect(mocks.ensureReadingNote).toHaveBeenCalledTimes(1)
    expect(mocks.ensureReadingNote).toHaveBeenCalledWith(book, [first, second], 'note-1')
    expect(mocks.library.linkNote).not.toHaveBeenCalled()
  })

  it('refreshes the linked note after a comment edit', async () => {
    const edited = highlight({ comment: '改过的批注' })
    mocks.library.notes.byBook = { [book.id]: 'note-1' }
    mocks.library.highlights = { [book.id]: [edited] }
    mount(<AutoNoteHarness book={book} enabled />)

    schedule()
    await advance()

    expect(mocks.ensureReadingNote).toHaveBeenCalledWith(book, [edited], 'note-1')
  })

  it('refreshes the linked note after a highlight is deleted', async () => {
    const remaining = highlight({ id: 'h2', start: 10, end: 15, quote: '第二句' })
    mocks.library.notes.byBook = { [book.id]: 'note-1' }
    mocks.library.highlights = { [book.id]: [remaining] }
    mount(<AutoNoteHarness book={book} enabled />)

    schedule()
    await advance()

    expect(mocks.ensureReadingNote).toHaveBeenCalledWith(book, [remaining], 'note-1')
  })

  it('does not refresh while disabled and cancels a pending refresh when switched off', async () => {
    mount(<AutoNoteHarness book={book} enabled />)
    schedule()
    rerender(<AutoNoteHarness book={book} enabled={false} />)
    await advance(1_000)
    schedule()
    await advance(1_000)

    expect(mocks.ensureReadingNote).not.toHaveBeenCalled()
  })

  it('clears a pending refresh on unmount', async () => {
    mount(<AutoNoteHarness book={book} enabled />)
    schedule()
    unmount()
    await advance(1_000)

    expect(mocks.ensureReadingNote).not.toHaveBeenCalled()
  })

  it('clears a pending refresh when the book changes', async () => {
    mount(<AutoNoteHarness book={book} enabled />)
    schedule()
    rerender(<AutoNoteHarness book={{ ...book, id: 'book-2' }} enabled />)
    await advance(1_000)

    expect(mocks.ensureReadingNote).not.toHaveBeenCalled()
  })

  it('shows a visible failure when the note cannot be written', async () => {
    mocks.ensureReadingNote.mockRejectedValue(new Error('write failed'))
    mount(<AutoNoteHarness book={book} enabled />)

    schedule()
    await advance()

    expect(mocks.toast).toHaveBeenCalledWith({
      title: 'reading.note_failed',
      description: 'write failed',
      tone: 'danger',
    })
  })
})

describe('ReaderView auto-note wiring', () => {
  it('schedules a refresh after creating a highlight', () => {
    mocks.library.highlights = { [book.id]: [] }
    mount(<ReaderView book={book} />)

    clickText('select')
    clickText('highlight')

    expect(mocks.library.addHighlight).toHaveBeenCalledTimes(1)
    expect(mocks.scheduleRefresh).toHaveBeenCalledTimes(1)
  })

  it('schedules a refresh after creating a commented highlight', () => {
    mocks.library.highlights = { [book.id]: [] }
    mount(<ReaderView book={book} />)

    clickText('select')
    clickText('comment')

    expect(mocks.library.addHighlight).toHaveBeenCalledTimes(1)
    expect(mocks.scheduleRefresh).toHaveBeenCalledTimes(1)
  })

  it('schedules a refresh after editing or deleting from the highlights panel', () => {
    mocks.library.highlights = { [book.id]: [highlight()] }
    mount(<ReaderView book={book} />)

    clickLabel('reading.highlights')
    clickText('edit:h1')
    expect(mocks.library.updateHighlight).toHaveBeenCalledWith(book.id, 'h1', { comment: 'edited' })
    expect(mocks.scheduleRefresh).toHaveBeenCalledTimes(1)

    clickText('delete:h1')
    expect(mocks.library.removeHighlight).toHaveBeenCalledWith(book.id, 'h1')
    expect(mocks.scheduleRefresh).toHaveBeenCalledTimes(2)
  })

  it('schedules a refresh after editing or deleting from the comment card', () => {
    mocks.library.highlights = { [book.id]: [highlight()] }
    mount(<ReaderView book={book} />)

    clickText('open-comment')
    clickText('card-edit:h1')
    expect(mocks.library.updateHighlight).toHaveBeenCalledWith(book.id, 'h1', { comment: 'card edit' })
    expect(mocks.scheduleRefresh).toHaveBeenCalledTimes(1)

    clickText('card-remove:h1')
    expect(mocks.library.removeHighlight).toHaveBeenCalledWith(book.id, 'h1')
    expect(mocks.scheduleRefresh).toHaveBeenCalledTimes(2)
  })
})
