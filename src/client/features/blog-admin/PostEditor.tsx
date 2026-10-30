import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, History, PanelRightOpen, RefreshCw, Save } from 'lucide-react'
import type { BlogPostAdminDetail } from '@shared/blog/model'
import { Badge, Button, IconButton, Spinner } from '../../components/primitives'
import { Drawer, Modal } from '../../components/overlay'
import { api, ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import { useUi } from '../../store/ui'
import { useActiveNote, useNotes } from '../../store/notes'
import { Workspace } from '../workspace/Workspace'
import { VersionsPanel } from '../workspace/VersionsPanel'
import { PostPublishPanel } from './PostPublishPanel'
import { AdminError, PostStatusBadge } from './shared'

function saveLabel(status: string): string {
  switch (status) {
    case 'saving': return t('blog.admin.saving')
    case 'dirty': return t('blog.admin.unsaved')
    case 'offline': return t('blog.admin.offline')
    case 'synced': return t('blog.admin.saved')
    default: return ''
  }
}

export function PostEditor({ noteId }: { noteId: string }) {
  const { note, loaded } = useActiveNote()
  const saveStatus = useNotes((state) => state.saveStatus)
  const [post, setPost] = useState<BlogPostAdminDetail | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const publishRef = useRef<(() => Promise<void>) | null>(null)

  const loadPost = useCallback(async (initialize = false) => {
    setError('')
    try {
      setPost(await api.blog.postByNote(noteId))
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) {
        try {
          if (initialize) {
            const { updateNoteBlogMeta } = await import('../blog/publish')
            await updateNoteBlogMeta(noteId, { blogType: 'post' })
          }
          await api.blog.syncNote(noteId)
          setPost(await api.blog.postByNote(noteId))
        } catch (inner) {
          setError(inner instanceof Error ? inner.message : String(inner))
        }
      } else {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      setLoading(false)
    }
  }, [noteId])

  useEffect(() => {
    setLoading(true)
    setPost(null)
    useUi.getState().setActiveNote(noteId)
    void useNotes.getState().openNote(noteId, { revealOnMobile: false, activate: true })
    void loadPost()
  }, [noteId, loadPost])

  const publishQuick = async () => {
    if (!post || publishing) return
    setPublishing(true)
    try {
      const blog = await import('../blog/publish')
      const ok = post.status === 'published' || post.status === 'scheduled'
        ? await blog.refreshBlogSnapshot(noteId)
        : await blog.publishNoteToBlog(noteId, true)
      if (ok) await loadPost()
    } finally {
      setPublishing(false)
    }
  }

  const pageHref = '/blog-admin/posts'
  const status = post?.status

  if (error) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <AdminError message={error} onRetry={() => void loadPost(true)} />
        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={() => void loadPost(true)}>{t('blog.admin.enable_blog_post')}</Button>
          <Button size="sm" variant="ghost" onClick={() => navigateToPath(pageHref)}>{t('blog.admin.back_to_posts')}</Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-1.5 md:px-3">
        <a
          href={pageHref}
          aria-label={t('blog.admin.back_to_posts')}
          onClick={(event) => { event.preventDefault(); navigateToPath(pageHref) }}
          className="inline-flex size-8 items-center justify-center rounded-[var(--r-md)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <ArrowLeft size={15} />
        </a>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
            {note?.title || t('blog.admin.untitled_post')}
          </span>
          {status && <PostStatusBadge status={status} />}
          {post && (post.renderStatus === 'stale' || (post.renderGeneratedAt !== null && (note?.updatedAt ?? 0) > post.renderGeneratedAt)) && <Badge tone="warning">{t('blog.admin.render_stale')}</Badge>}
          <span className="hidden items-center gap-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)] sm:flex">
            <Save size={10} aria-hidden="true" />
            {saveLabel(saveStatus)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton label={t('blog.admin.revisions')} onClick={() => setHistoryOpen(true)}>
            <History size={15} />
          </IconButton>
          <IconButton className="lg:hidden" label={t('blog.admin.editor_details')} onClick={() => setSettingsOpen(true)}>
            <PanelRightOpen size={15} />
          </IconButton>
          <Button
            size="sm"
            loading={publishing}
            icon={<RefreshCw size={12} />}
            onClick={() => void (publishRef.current?.() ?? publishQuick())}
            disabled={!post}
          >
            {status === 'draft' ? t('blog.admin.publish_section') : t('blog.admin.update')}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {loaded ? <Workspace /> : <div className="flex h-full items-center justify-center"><Spinner /></div>}
        </div>
        <aside className="hidden w-[304px] shrink-0 overflow-y-auto border-l border-[var(--border-subtle)] bg-[var(--bg-base)] lg:block">
          {loading && !post ? <div className="flex justify-center p-6"><Spinner /></div> : post && (
            <PostPublishPanel
              noteId={noteId}
              post={post}
              noteUpdatedAt={note?.updatedAt ?? 0}
              savingNote={saveStatus === 'saving' || saveStatus === 'dirty'}
              publishRef={publishRef}
              onChanged={() => loadPost()}
              onOpenHistory={() => setHistoryOpen(true)}
            />
          )}
        </aside>
      </div>

      <Drawer open={settingsOpen} onClose={() => setSettingsOpen(false)} side="right" width={340} title={t('blog.admin.editor_details')}>
        {post && (
          <PostPublishPanel
            noteId={noteId}
            post={post}
            noteUpdatedAt={note?.updatedAt ?? 0}
            savingNote={saveStatus === 'saving' || saveStatus === 'dirty'}
            publishRef={publishRef}
            onChanged={() => loadPost()}
            onOpenHistory={() => setHistoryOpen(true)}
          />
        )}
      </Drawer>

      <Modal open={historyOpen} onClose={() => setHistoryOpen(false)} title={t('blog.admin.revisions')} width={980} bodyClassName="h-[70vh] p-0">
        <div className="h-full min-h-0">
          <VersionsPanel onClose={() => setHistoryOpen(false)} />
        </div>
      </Modal>
    </div>
  )
}
