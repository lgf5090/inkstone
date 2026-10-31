import { api, ApiError } from '../../lib/api'
import {
  deleteFrontMatterValue,
  setFrontMatterValue,
  type FrontMatterValue,
} from '@shared/markdown-utils'
import { readBlogFrontMatter, setBlogPublished } from '@shared/blog/frontmatter'
import { t } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { captureBlogSnapshot } from './snapshot'
import { useBlogNoteStatus } from './status'

async function unpublishByNote(noteId: string): Promise<void> {
  try {
    const post = await api.blog.postByNote(noteId)
    await api.blog.unpublish(post.id)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return
    throw error
  }
}

async function saveNoteContent(noteId: string, transform: (content: string) => string): Promise<string> {
  const open = useNotes.getState().contents[noteId]
  if (open !== undefined) {
    const next = transform(open)
    if (next !== open) {
      useNotes.getState().editContent(noteId, next)
      await useNotes.getState().flush({ immediate: true })
    }
    return useNotes.getState().contents[noteId] ?? next
  }
  const note = await api.notes.get(noteId)
  const next = transform(note.content)
  if (next === note.content) return note.content
  const saved = await api.notes.patch(noteId, { rev: note.rev, content: next })
  return saved.content
}

export async function updateNoteBlogMeta(
  noteId: string,
  values: Record<string, FrontMatterValue | null>,
): Promise<boolean> {
  try {
    await saveNoteContent(noteId, (content) => {
      let next = content
      for (const [key, value] of Object.entries(values)) {
        next = value === null ? deleteFrontMatterValue(next, key) : setFrontMatterValue(next, key, value)
      }
      return next
    })
    return true
  } catch (error) {
    useUi.getState().toast({
      title: t('blog.admin.meta_save_failed'),
      description: error instanceof Error ? error.message : String(error),
      tone: 'danger',
    })
    return false
  }
}

export async function createBlogDraft(type: 'post' | 'page', title: string): Promise<string | null> {
  const content = `---\nblogType: ${type}\nisPublished: false\n---\n\n`
  const id = await useNotes.getState().createNote({ title, content, open: false })
  if (id) {
    useUi.getState().setActiveNote(id)
    void useNotes.getState().openNote(id, { revealOnMobile: false })
  }
  return id
}

export interface PublishOptions {
    publishedAt?: string | null
}

/**
 * Set the note's isPublished property, save it, then publish the rendered snapshot (or withdraw the
 * projection). The note remains the source of truth; a snapshot failure leaves the property set and
 * the post pending rather than pretending the publish succeeded.
 */
export async function publishNoteToBlog(
  noteId: string,
  publish: boolean,
  options: PublishOptions = {},
): Promise<boolean> {
  const ui = useUi.getState()
  try {
    const content = await saveNoteContent(noteId, (current) => {
      let next = current
      if (options.publishedAt !== undefined) {
        next = options.publishedAt === null
          ? deleteFrontMatterValue(next, 'blogPublishedAt')
          : setFrontMatterValue(next, 'blogPublishedAt', options.publishedAt)
      }
      return setBlogPublished(next, publish)
    })
    const meta = readBlogFrontMatter(content)

    if (!publish) {
      await unpublishByNote(noteId)
      void useBlogNoteStatus.getState().reload()
      ui.toast({ title: t('notes.unpublished_from_blog'), tone: 'success' })
      return true
    }

    if (meta.type === 'page') {
      const page = await api.blog.pages.byNote(noteId)
      if (!options.publishedAt) await api.blog.pages.publish(page.id, true)
      ui.toast({
        title: options.publishedAt && Date.parse(options.publishedAt) > Date.now()
          ? t('blog.admin.page_scheduled')
          : t('blog.admin.page_published'),
        tone: 'success',
      })
      void useBlogNoteStatus.getState().reload()
      return true
    }

    const snapshot = await captureBlogSnapshot(noteId, content)
    await api.blog.publish(noteId, snapshot)
    const scheduled = options.publishedAt && Date.parse(options.publishedAt) > Date.now()
    ui.toast({
      title: scheduled ? t('blog.admin.post_scheduled') : t('notes.published_to_blog'),
      tone: 'success',
    })
    void useBlogNoteStatus.getState().reload()
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

export async function refreshBlogSnapshot(noteId: string): Promise<boolean> {
  const ui = useUi.getState()
  try {
    const note = await api.notes.get(noteId)
    const meta = readBlogFrontMatter(note.content)
    if (!meta.isPublished) return false
    if (meta.type === 'page') return false
    const snapshot = await captureBlogSnapshot(noteId, note.content)
    await api.blog.publish(noteId, snapshot)
    return true
  } catch (error) {
    ui.toast({
      title: t('blog.admin.snapshot_failed'),
      description: error instanceof Error ? error.message : String(error),
      tone: 'danger',
    })
    return false
  }
}
