/**
 * The note a book writes.
 *
 * Every book gets one Markdown note that holds its highlights. That is what makes the marks more than a
 * database row: the reader can link to them, edit them, search them, and keep them after the file that
 * produced them is gone.
 *
 * The generated passage lives between two markers, and everything outside them belongs to the reader.
 * Rewriting the whole body on every new highlight would erase whatever they had typed under it — which
 * is the failure this design exists to prevent.
 */
import { createContextualNote, useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { t } from '../../lib/i18n'
import { folderPathLabel } from '../../lib/folders'
import { formatPercent, type BookPosition } from './position'
import { useLibrary } from './store/library'
import { useReaderSettings } from './store/reader-settings'
import type { BookRecord, Highlight } from './types'

export const NOTE_BEGIN = '<!-- inkstone:reading:begin -->'
export const NOTE_END = '<!-- inkstone:reading:end -->'

/** The address that opens this book, optionally at one position. */
export function bookLink(bookId: string, position?: BookPosition | null): string {
  const path = `/reading/${encodeURIComponent(bookId)}`
  if (!position) return path
  return `${path}?p=${encodeURIComponent(position.kind === 'epub' ? `e:${position.chapter}:${position.offset}` : `f:${position.page}`)}`
}

function frontmatter(book: BookRecord, highlights: Highlight[], fraction: number): string {
  const lines = [
    '---',
    `book: ${JSON.stringify(book.title)}`,
    book.author ? `author: ${JSON.stringify(book.author)}` : null,
    book.language ? `book-language: ${JSON.stringify(book.language)}` : null,
    `format: ${JSON.stringify(book.format)}`,
    `reading-progress: ${formatPercent(fraction)}`,
    `highlights: ${highlights.length}`,
    'type: reading-note',
    '---',
  ]
  return lines.filter((line): line is string => line !== null).join('\n')
}

function escapeQuote(value: string): string {
  // A blockquote that contains a blank line becomes a blockquote and a paragraph, and the paragraph
  // loses the mark's meaning when the note is read back.
  return value.replace(/\r\n?/g, '\n').replace(/\n{2,}/g, '\n').split('\n').join('\n> ')
}

export interface NoteOptions {
  backlinks: boolean
  chapterTitles?: Map<number, string>
}

/** The generated half of the note: the marks, in reading order, grouped by chapter. */
export function renderReadingSection(
  book: BookRecord,
  highlights: Highlight[],
  fraction: number,
  options: NoteOptions,
): string {
  const out: string[] = []
  out.push(`# ${book.title}`)
  out.push('')
  out.push(`> ${t('reading.note_summary_value0', { value0: highlights.length })} · ${formatPercent(fraction)}`)
  out.push('>')
  out.push(`> [${t('reading.note_open_book')}](${bookLink(book.id)})`)
  out.push('')
  if (!highlights.length) {
    out.push(t('reading.note_no_highlights'))
    out.push('')
    return out.join('\n')
  }
  const byChapter = new Map<number, Highlight[]>()
  for (const highlight of [...highlights].sort((a, b) => a.chapter - b.chapter || a.start - b.start)) {
    const list = byChapter.get(highlight.chapter) ?? []
    list.push(highlight)
    byChapter.set(highlight.chapter, list)
  }
  for (const [chapter, list] of byChapter) {
    const title = options.chapterTitles?.get(chapter)
    out.push(`## ${title || t('reading.chapter_value0', { value0: chapter + 1 })}`)
    out.push('')
    for (const highlight of list) {
      const link = options.backlinks ? ` [↩](${bookLink(book.id, { kind: 'epub', chapter: highlight.chapter, offset: highlight.start })})` : ''
      out.push(`> ${escapeQuote(highlight.quote)}${link}`)
      const comment = highlight.comment.trim()
      if (comment) out.push(`>\n> ${escapeQuote(comment)}`)
      out.push('')
    }
  }
  return out.join('\n')
}

/** Splice the generated section into a body, keeping anything the reader wrote outside the markers. */
export function spliceNote(existing: string, section: string): string {
  const begin = existing.indexOf(NOTE_BEGIN)
  const end = existing.indexOf(NOTE_END)
  if (begin >= 0 && end > begin) {
    return `${existing.slice(0, begin)}${NOTE_BEGIN}\n\n${section}\n${existing.slice(end)}`
  }
  // A note the reader already had may carry a heading and their own passages; the marks go underneath.
  const head = existing.trim()
  if (!head) return `${NOTE_BEGIN}\n\n${section}\n${NOTE_END}`
  return `${head}\n\n${NOTE_BEGIN}\n\n${section}\n${NOTE_END}\n`
}

function noteTitle(book: BookRecord): string {
  return t('reading.note_title_value0', { value0: book.title }).slice(0, 200)
}

/**
 * Create the book's note or write its generated section into the one it already has.
 *
 * The write goes through the note store's remote transform rather than the in-memory copy, because a
 * reading note is often open on another device and a blind overwrite there would drop their own
 * paragraphs.
 */
export async function ensureReadingNote(
  book: BookRecord,
  highlights: Highlight[],
  existingNoteId: string | undefined,
): Promise<string | null> {
  const settings = useReaderSettings.getState()
  const notes = useNotes.getState()
  const fraction = useLibrary.getState().progress[book.id]?.fraction ?? 0
  const chapterTitles = new Map<number, string>()
  for (const entry of book.toc) {
    if (entry.position?.kind === 'epub' && !chapterTitles.has(entry.position.chapter)) {
      chapterTitles.set(entry.position.chapter, entry.label)
    }
  }
  const section = renderReadingSection(book, highlights, fraction, {
    backlinks: settings.quoteBacklinks,
    chapterTitles,
  })

  // A note the reader deleted out from under the book must not be resurrected by id: the title is the
  // only handle that survives, and a missing one means a fresh note.
  const title = noteTitle(book)
  const linked = existingNoteId && notes.notes[existingNoteId] ? notes.notes[existingNoteId] : null
  const target = linked
    ?? Object.values(notes.notes).find((summary) => summary.title === title && !summary.deletedAt)
    ?? null
  if (target) {
    const result = await notes.editRemoteContent(target.id, (content) => spliceNote(content, section))
    if (result === 'conflict') useUi.getState().toast({ title: t('reading.note_conflict'), tone: 'warning' })
    return target.id
  }
  const folderId = settings.notesFolder
    ? findFolderByPath(notes.folders ?? [], settings.notesFolder) || undefined
    : undefined
  const body = `${frontmatter(book, highlights, fraction)}\n\n${NOTE_BEGIN}\n\n${section}\n${NOTE_END}\n`
  return createContextualNote({ title, content: body, open: false, ...(folderId ? { folderId } : {}) })
}

/** The folder a reader named in settings, matched by its whole path so same-named folders can be told apart. */
function findFolderByPath(folders: Parameters<typeof folderPathLabel>[0], wanted: string): string | null {
  const needle = wanted.trim().replace(/^\/+|\/+$/g, '')
  if (!needle) return null
  const exact = folders.find((folder) => folderPathLabel(folders, folder.id, ' / ') === needle || folder.name === needle)
  return exact?.id ?? null
}
