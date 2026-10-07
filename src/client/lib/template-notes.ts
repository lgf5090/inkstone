import { renderNewNoteTemplate } from '@shared/note-template-render'
import type { NoteTemplate } from '@shared/types'
import { createContextualNote } from '../store/notes'
import { useUi } from '../store/ui'
import { t } from './i18n'

/**
 * Create a note from a gallery template and open it, returning the new id.
 *
 * The template's `{{cursor}}` is handed to the editor through `createNote`, so
 * the marker is stripped from the body and the caret lands where the author
 * pointed it rather than at the end of the front matter. Placement follows the
 * same rules as the `+` button — the open folder, else the inbox — because a
 * template note is still just a new note.
 */
export async function createNoteFromTemplate(template: NoteTemplate, options: { folderId?: string } = {}): Promise<string | null> {
  const rendered = renderNewNoteTemplate(template.content, { title: template.name })
  const id = await createContextualNote({
    title: template.name,
    content: rendered.content,
    cursor: rendered.cursor,
    open: true,
    ...(options.folderId ? { folderId: options.folderId } : {}),
  })
  if (id)
    useUi.getState().toast({ title: t('templates.created_note_from_template'), tone: 'success' })
  return id
}
