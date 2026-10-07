/** Fresh-note construction: template expansion, caret hand-off, and title sync. */
import { DEFAULT_NEW_NOTE_TEMPLATE, LIMITS } from '@shared/constants'
import { deleteFrontMatterValue, parseFrontMatter, setFrontMatterValue } from '@shared/markdown-utils'
import { renderNewNoteTemplate } from '@shared/note-template-render'
import type { Folder } from '@shared/types'
import { isVirtualFolderId } from '../lib/calendar-tree'
import { t } from '../lib/i18n'
import { useSession } from './session'
import { useUi } from './ui'

export interface BuiltNewNote {
  content: string
  cursor: number | null
  /** True when the template had no front matter for `tags` to be merged into. */
  tagsUnapplied: string[]
}

/**
 * Build the initial content of a fresh note from the configured template
 * (`settings.notes.newNoteTemplate`). An empty or whitespace-only template
 * yields a blank note, which is the pre-template behaviour.
 *
 * Tags the note was created under are merged into the front matter `tags`
 * list rather than written as body text, so a note made from a tag view lands
 * on that tag page without the tag cluttering the first line. `tagsUnapplied`
 * reports the ones that had nowhere to go.
 */
export function buildNewNoteContent(
  title: string,
  tags: readonly string[] = [],
  folderId: string | null = null,
  folders: readonly Folder[] = [],
): BuiltNewNote {
  const template = useSession.getState().settings.notes?.newNoteTemplate ?? DEFAULT_NEW_NOTE_TEMPLATE
  const tagList = tags.map((item) => item.trim().replace(/^#/, '')).filter(Boolean)
  if (!template.trim()) return { content: '', cursor: null, tagsUnapplied: tagList }
  const folder = folderId && !isVirtualFolderId(folderId)
    ? folders.find((item) => item.id === folderId)
    : null
  const rendered = renderNewNoteTemplate(
    template,
    {
      title: title || t('common.new_note'),
      now: new Date(),
      folder: folder?.name ?? '',
      tags: tagList.join(', '),
    },
    tagList,
  )
  // A tag only lands in the note through the front matter merge; without a
  // metadata block in the template there is nothing to merge into, and the
  // caller decides whether to fall back to a body tag instead.
  const merged = parseFrontMatter(rendered.content)
  return {
    content: rendered.content,
    cursor: rendered.cursor,
    tagsUnapplied: merged.lineOffset ? [] : tagList,
  }
}

/**
 * Pending caret positions for freshly created notes, consumed by the editor on
 * mount. A note created in the background never mounts, so the map is bounded to
 * the most recent entries rather than growing for the length of the session.
 */
export const pendingEditorCursors = new Map<string, number>()
const PENDING_CURSOR_MAX = 64

export function rememberPendingEditorCursor(noteId: string, cursor: number): void {
  pendingEditorCursors.set(noteId, cursor)
  while (pendingEditorCursors.size > PENDING_CURSOR_MAX) {
    const oldest = pendingEditorCursors.keys().next()
    if (oldest.done) break
    pendingEditorCursors.delete(oldest.value)
  }
}

export function takePendingEditorCursor(noteId: string): number | null {
  const cursor = pendingEditorCursors.get(noteId)
  pendingEditorCursors.delete(noteId)
  return cursor ?? null
}

export function frontMatterTitleOf(content: string): string | undefined {
  const title = parseFrontMatter(content).data.title
  return typeof title === 'string' ? title : undefined
}

/**
 * Rewrite the note's existing front matter `title` property, or return null
 * when the note has no front matter or never declared one: renaming a plain
 * note must not bolt a metadata block onto it.
 */
export function syncTitleIntoFrontMatter(content: string, title: string): string | null {
  if (!useSession.getState().settings.notes?.syncTitleToFrontMatter) return null
  const parsed = parseFrontMatter(content)
  if (!parsed.lineOffset || parsed.errors.length) return null
  if (!Object.prototype.hasOwnProperty.call(parsed.data, 'title')) return null
  const next = title
    ? setFrontMatterValue(content, 'title', title)
    : deleteFrontMatterValue(content, 'title')
  return next === content ? null : next
}

/**
 * The title a body edit just declared for itself, or null to leave the note's
 * title alone. Only a *change* in the front matter `title` counts: comparing
 * against the previous content is what stops a note whose title was renamed
 * while the property stayed behind from snapping back on the next keystroke.
 */
export function adoptedFrontMatterTitle(previous: string, next: string): string | null {
  if (!useSession.getState().settings.notes?.syncFrontMatterTitle) return null
  const title = frontMatterTitleOf(next)
  if (title === undefined || title === frontMatterTitleOf(previous)) return null
  return title.slice(0, LIMITS.titleMaxLength)
}

/** The folder a new note belongs to, given the view the reader is looking at. */
export function newNoteFolderId(): string | null {
  const ui = useUi.getState()
  return ui.view === 'folder' && !isVirtualFolderId(ui.folderId) ? ui.folderId : null
}
