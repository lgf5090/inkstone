/** One undo stack for the note: page content, page arrays, paper and page size. */
import type { InknoteNoteMeta, InknotePage, InknotePageContent, InknotePaper } from '@shared/inknote/types'
import { serializePageContent } from '@shared/inknote/parse'

export interface PageSnapshot {
  id: string
  position: number
  content: InknotePageContent
  rev: number
  updatedAt: number
}

export interface NoteSnapshot {
  noteId: string
  pages: PageSnapshot[]
  paper: InknotePaper
  pageWidth: number
  pageHeight: number
  contentWidth: number
  contentHeight: number
}

export type InknoteHistoryEntry =
  | { kind: 'content'; pageId: string; before: string; after: string; label: string }
  | { kind: 'note'; before: NoteSnapshot; after: NoteSnapshot; label: string }

export const HISTORY_DEPTH = 100
export const HISTORY_BYTES = 64 * 1024 * 1024

/** Deep-copied, because the live page object keeps being edited by the canvas. */
export function snapshotNote(note: InknoteNoteMeta, pages: readonly InknotePage[]): NoteSnapshot {
  return {
    noteId: note.id,
    paper: { ...note.paper },
    pageWidth: note.pageWidth,
    pageHeight: note.pageHeight,
    contentWidth: note.contentWidth,
    contentHeight: note.contentHeight,
    pages: pages.map((page) => ({
      id: page.id,
      position: page.position,
      rev: page.rev,
      updatedAt: page.updatedAt,
      content: JSON.parse(serializePageContent(page.content)) as InknotePageContent,
    })),
  }
}

export function samePageOrder(a: readonly { id: string }[], b: readonly { id: string }[]): boolean {
  return a.length === b.length && a.every((page, index) => page.id === b[index]?.id)
}

export function samePaper(a: InknotePaper, b: InknotePaper): boolean {
  return a.style === b.style && a.color === b.color && a.spacing === b.spacing
}

function entryBytes(entry: InknoteHistoryEntry): number {
  return entry.kind === 'content'
    ? (entry.before.length + entry.after.length) * 2
    : (JSON.stringify(entry.before).length + JSON.stringify(entry.after).length) * 2
}

export function trimHistory(entries: InknoteHistoryEntry[]): InknoteHistoryEntry[] {
  const kept = [...entries]
  let bytes = kept.reduce((sum, entry) => sum + entryBytes(entry), 0)
  while (kept.length > HISTORY_DEPTH || (bytes > HISTORY_BYTES && kept.length > 1)) {
    const dropped = kept.shift()
    if (!dropped) break
    bytes -= entryBytes(dropped)
  }
  return kept
}
