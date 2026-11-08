// @vitest-environment jsdom
/** Saving must write only changed pages, and an edit made during a request must still reach the server. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InknoteNoteMeta, InknotePage } from '@shared/inknote/types'
import { emptyPageContent, serializePageContent } from '@shared/inknote/parse'
import { DEFAULT_INKNOTE_SETTINGS } from '@shared/inknote/constants'
import { ApiError } from '../../lib/api'

const mocks = vi.hoisted(() => ({
  savePage: vi.fn(),
  uploadAsset: vi.fn(),
  createSnapshot: vi.fn(),
  library: vi.fn(),
  settings: vi.fn(),
  templates: vi.fn(),
  saveSettings: vi.fn(),
}))

vi.mock('./api', () => ({
  inknoteApi: {
    savePage: mocks.savePage,
    uploadAsset: mocks.uploadAsset,
    createSnapshot: mocks.createSnapshot,
    library: mocks.library,
    settings: mocks.settings,
    templates: mocks.templates,
    saveSettings: mocks.saveSettings,
  },
}))

function note(): InknoteNoteMeta {
  return {
    id: 'n1', notebookId: 'b1', title: 'Note', pageCount: 2, contentBytes: 10,
    pageWidth: 816, pageHeight: 1056, contentWidth: 816, contentHeight: 1056,
    paper: { style: 'line', color: 'white', spacing: 'normal' }, colorTag: null, pinned: false,
    coverAssetId: null, coverUrl: null, rev: 1, createdAt: 1, updatedAt: 1, deletedAt: null,
  }
}

function page(id: string, position: number): InknotePage {
  return { id, position, rev: 1, updatedAt: 1, content: emptyPageContent() }
}

async function loaded() {
  const { useInknoteStore } = await import('./store')
  useInknoteStore.setState({
    note: note(),
    pages: [page('p1', 1), page('p2', 2)],
    activePageId: 'p1',
    activePageIndex: 0,
    library: {
      subjects: [], notebooks: [], notes: [note()], templates: [],
      settings: { ...DEFAULT_INKNOTE_SETTINGS },
    },
    initialized: true,
    loading: false,
    conflicts: {},
    drafts: {},
    undoStack: [],
    redoStack: [],
    saveState: 'saved',
  })
  return useInknoteStore
}

beforeEach(() => {
  mocks.savePage.mockReset()
  mocks.uploadAsset.mockReset()
  mocks.createSnapshot.mockReset()
  mocks.library.mockReset()
  mocks.savePage.mockImplementation(async (_noteId: string, _pageId: string, _content: string, baseRev: number) => ({
    rev: baseRev + 1,
    updatedAt: Date.now(),
    searchText: '',
  }))
})

describe('page saving', () => {
  it('writes only the pages that changed', async () => {
    const store = await loaded()
    await store.getState().saveAll()
    expect(mocks.savePage).not.toHaveBeenCalled()

    store.getState().touchPage()
    await store.getState().savePage('p1')
    expect(mocks.savePage).toHaveBeenCalledTimes(1)

    await store.getState().saveAll()
    expect(mocks.savePage).toHaveBeenCalledTimes(1)

    store.getState().replacePageContent('p2', emptyPageContent())
    await store.getState().saveAll()
    expect(mocks.savePage).toHaveBeenCalledTimes(2)
    expect(mocks.savePage.mock.calls[1]![1]).toBe('p2')
  })

  it('saves again when content changes while a request is in flight', async () => {
    const store = await loaded()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    mocks.savePage.mockImplementation(async (_noteId: string, _pageId: string, content: string, baseRev: number) => {
      await gate
      return { rev: baseRev + 1, updatedAt: Date.now(), searchText: content.length > 0 ? 'later' : '' }
    })
    store.getState().touchPage()
    const first = store.getState().savePage('p1')
    const page = store.getState().pages[0]!
    page.content.texts.push({
      id: 't1', x: 0, y: 0, w: 0.5, h: 0.1, text: 'later', fontSize: 26, color: '#1e293b',
      align: 'left', bold: false, italic: false, underline: false, hl: null, lh: 1.3, list: null,
    })
    store.getState().touchPage()
    release()
    await first
    expect(mocks.savePage).toHaveBeenCalledTimes(2)
    expect(mocks.savePage.mock.calls[1]![2]).toContain('later')
    await store.getState().saveAll()
  })

  it('keeps a local draft and reports offline when a save fails', async () => {
    const store = await loaded()
    mocks.savePage.mockRejectedValue(new ApiError(0, 'offline', 'No connection'))
    store.getState().touchPage()
    const saved = await store.getState().savePage('p1')
    expect(saved).toBe(false)
    expect(store.getState().saveState).toBe('offline')
    expect(store.getState().drafts.p1).toBeDefined()
    const raw = localStorage.getItem('inknote-draft:n1:p1')
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!)).toMatchObject({ offline: true })
    expect(serializePageContent(store.getState().pages[0]!.content)).toBe(JSON.parse(raw!).content)
  })
})
