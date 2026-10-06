import { renderNewNoteTemplate } from '@shared/note-template-render'
import type { NoteTemplate } from '@shared/types'
import { useNotes } from '../store/notes'
import { useUi } from '../store/ui'
import { t } from './i18n'

/**
 * Create a note from a gallery template and open it, returning the new id.
 *
 * The template's `{{cursor}}` is handed to the editor through `createNote`, so
 * the marker is stripped from the body and the caret lands where the author
 * pointed it rather than at the end of the front matter.
 */
export async function createNoteFromTemplate(template: NoteTemplate): Promise<string | null> {
  const rendered = renderNewNoteTemplate(template.content, { title: template.name })
  const id = await useNotes.getState().createNote({
    title: template.name,
    content: rendered.content,
    cursor: rendered.cursor,
    open: true,
  })
  if (id)
    useUi.getState().toast({ title: t('templates.created_note_from_template'), tone: 'success' })
  return id
}
