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
export async function createNoteFromTemplate(template: NoteTemplate, options: { folderId?: string, title?: string } = {}): Promise<string | null> {
  // A door that lets the reader name the note (the template chooser, a chord bound to "create") says so here;
  // the gallery does not, and the template's own name is then the note's, as it has always been.
  const title = options.title?.trim() || template.name
  const rendered = renderNewNoteTemplate(template.content, { title })
  const id = await createContextualNote({
    title,
    content: rendered.content,
    cursor: rendered.cursor,
    open: true,
    ...(options.folderId ? { folderId: options.folderId } : {}),
  })
  if (id) {
    useUi.getState().toast({ title: t('templates.created_note_from_template'), tone: 'success' })
    // A template that asked the assistant to write something is not finished until it has. The chat
    // module is loaded on demand: a template without slots never pays for it. The run is started rather
    // than awaited — the note is already made and open, and its passages arrive as the card says they do.
    if (rendered.aiSlots.length > 0) {
      const { startTemplateSlotFill } = await import('../features/chat/template-fill')
      startTemplateSlotFill(id, rendered.aiSlots)
    }
  }
  return id
}
