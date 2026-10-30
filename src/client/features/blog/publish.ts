import { api, ApiError } from '../../lib/api'
import { setBlogPublished } from '@shared/blog/frontmatter'
import { t } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { captureBlogSnapshot } from './snapshot'

async function unpublishByNote(noteId: string): Promise<void> {
  try {
    const post = await api.blog.postByNote(noteId)
    await api.blog.unpublish(post.id)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return
    throw error
  }
}

/**
 * Set the note's isPublished property, save it, then publish the rendered snapshot (or withdraw the
 * projection). The note remains the source of truth; a snapshot failure leaves the property set and
 * the post pending rather than pretending the publish succeeded.
 */
export async function publishNoteToBlog(noteId: string, publish: boolean): Promise<boolean> {
  const ui = useUi.getState()
  try {
    const open = useNotes.getState().contents[noteId]
    let content: string
    if (open !== undefined) {
      const next = setBlogPublished(open, publish)
      if (next !== open) {
        useNotes.getState().editContent(noteId, next)
        await useNotes.getState().flush({ immediate: true })
      }
      content = useNotes.getState().contents[noteId] ?? next
    } else {
      const note = await api.notes.get(noteId)
      const next = setBlogPublished(note.content, publish)
      const saved = next === note.content ? note : await api.notes.patch(noteId, { rev: note.rev, content: next })
      content = saved.content
    }

    if (publish) {
      const snapshot = await captureBlogSnapshot(noteId, content)
      await api.blog.publish(noteId, snapshot)
    } else {
      await unpublishByNote(noteId)
    }
    ui.toast({
      title: publish ? t('notes.published_to_blog') : t('notes.unpublished_from_blog'),
      tone: 'success',
    })
    return true
  } catch (error) {
    ui.toast({
      title: t('notes.blog_publish_failed'),
      description: error instanceof Error ? error.message : String(error),
      tone: 'danger',
    })
    return false
  }
}
