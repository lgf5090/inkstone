import { describe, expect, it } from 'vitest'
import type { InknoteNoteMeta, InknotePage, InknotePageContent } from '@shared/inknote/types'
import { samePageOrder, samePaper, snapshotNote, trimHistory, type InknoteHistoryEntry } from './history-entry'

function note(): InknoteNoteMeta {
  return {
    id: 'n1', notebookId: 'b1', title: 'Note', pageCount: 1, contentBytes: 0,
    pageWidth: 816, pageHeight: 1056, contentWidth: 816, contentHeight: 1056,
    paper: { style: 'line', color: 'white', spacing: 'normal' }, colorTag: null, pinned: false,
    coverAssetId: null, coverUrl: null, rev: 1, createdAt: 1, updatedAt: 1, deletedAt: null,
  }
}

function page(id: string): InknotePage {
  const content: InknotePageContent = { format: 'inknote-page', version: 1, strokes: [], texts: [], images: [], bg: null }
  return { id, position: 0, rev: 1, updatedAt: 1, content }
}

describe('snapshotNote', () => {
  it('deep-copies page content so later edits do not rewrite history', () => {
    const live = page('p1')
    const snapshot = snapshotNote(note(), [live])
    live.content.texts.push({ id: 't', x: 0, y: 0, w: 1, h: 1, text: 'later', fontSize: 20, color: '#000000', align: 'left', bold: false, italic: false, underline: false, hl: null, lh: 1.3, list: null })
    expect(snapshot.pages[0]!.content.texts).toEqual([])
  })
})

describe('comparisons', () => {
  it('compares page order by id', () => {
    expect(samePageOrder([{ id: 'a' }, { id: 'b' }], [{ id: 'a' }, { id: 'b' }])).toBe(true)
    expect(samePageOrder([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'a' }])).toBe(false)
  })

  it('compares paper fields', () => {
    expect(samePaper({ style: 'line', color: 'white', spacing: 'normal' }, { style: 'line', color: 'white', spacing: 'normal' })).toBe(true)
    expect(samePaper({ style: 'line', color: 'white', spacing: 'normal' }, { style: 'grid', color: 'white', spacing: 'normal' })).toBe(false)
  })
})

describe('trimHistory', () => {
  it('keeps the newest hundred entries', () => {
    const entries = Array.from({ length: 120 }, (_, index): InknoteHistoryEntry => ({ kind: 'content', pageId: 'p', before: String(index), after: String(index + 1), label: 'stroke' }))
    const trimmed = trimHistory(entries)
    expect(trimmed).toHaveLength(100)
    expect(trimmed[0]!.kind === 'content' && trimmed[0]!.before).toBe('20')
  })
})
