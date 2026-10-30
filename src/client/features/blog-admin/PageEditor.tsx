import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, ExternalLink, History, PanelRightOpen } from 'lucide-react'
import type { BlogSettings } from '@shared/blog/settings'
import type { BlogPageItem } from '@shared/blog/model'
import { Badge, Button, IconButton, Spinner } from '../../components/primitives'
import { Drawer, Modal } from '../../components/overlay'
import { Field, Input, Select, Textarea } from '../../components/form'
import { DatePicker } from '../../components/date-picker'
import { api, ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import { useUi } from '../../store/ui'
import { useActiveNote, useNotes } from '../../store/notes'
import { Workspace } from '../workspace/Workspace'
import { VersionsPanel } from '../workspace/VersionsPanel'
import { AdminError, formatDateTime, useAdminResource } from './shared'

export function PageEditor({ identifier }: { identifier: string }) {
  const noteBacked = identifier.startsWith('note:')
  const noteId = noteBacked ? identifier.slice('note:'.length) : null
  const pageId = noteBacked ? null : identifier
  const { note, loaded } = useActiveNote()
  const [page, setPage] = useState<BlogPageItem | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settings = useAdminResource(() => api.blog.settings.get(), [])

  const loadPage = useCallback(async (initialize = false) => {
    setError('')
    setLoading(true)
    try {
      if (noteId) {
        useUi.getState().setActiveNote(noteId)
        void useNotes.getState().openNote(noteId, { revealOnMobile: false, activate: true })
        try {
          setPage(await api.blog.pages.byNote(noteId))
        } catch (cause) {
          if (!(cause instanceof ApiError && cause.status === 404)) throw cause
          if (initialize) {
            const { updateNoteBlogMeta } = await import('../blog/publish')
            await updateNoteBlogMeta(noteId, { blogType: 'page' })
          }
          await api.blog.syncNote(noteId)
          setPage(await api.blog.pages.byNote(noteId))
        }
      } else if (pageId) {
        const loadedPage = await api.blog.pages.get(pageId)
        setPage(loadedPage)
        if (loadedPage.noteId) {
          useUi.getState().setActiveNote(loadedPage.noteId)
          void useNotes.getState().openNote(loadedPage.noteId, { revealOnMobile: false, activate: true })
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [noteId, pageId])

  useEffect(() => {
    void loadPage()
  }, [loadPage])

  const siteUrl = typeof (settings.data as BlogSettings | null)?.site?.url === 'string'
    ? String((settings.data as BlogSettings).site.url).replace(/\/+$/, '')
    : ''
  const liveUrl = page?.publishedAt ? `${siteUrl}/pages/${page.slug}` : ''

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-1.5 md:px-3">
        <a
          href="/blog-admin/pages"
          aria-label={t('blog.admin.back_to_pages')}
          onClick={(event) => { event.preventDefault(); navigateToPath('/blog-admin/pages') }}
          className="inline-flex size-8 items-center justify-center rounded-[var(--r-md)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <ArrowLeft size={15} />
        </a>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
            {page?.title || note?.title || t('blog.admin.untitled_page')}
          </span>
          {page && <Badge tone={page.publishedAt ? 'success' : 'neutral'}>{page.publishedAt ? t('blog.admin.status_published') : t('blog.admin.status_draft')}</Badge>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {liveUrl && (
            <a href={liveUrl} target="_blank" rel="noopener noreferrer" className="hidden items-center gap-1 rounded-[var(--r-md)] px-2 py-1.5 text-[length:var(--text-12)] text-[var(--accent)] hover:bg-[var(--bg-hover)] sm:inline-flex">
              <ExternalLink size={12} aria-hidden="true" /> {t('blog.admin.view_live')}
            </a>
          )}
          {page?.noteId && (
            <IconButton label={t('blog.admin.revisions')} onClick={() => setHistoryOpen(true)}><History size={15} /></IconButton>
          )}
          <IconButton className="lg:hidden" label={t('blog.admin.editor_details')} onClick={() => setSettingsOpen(true)}><PanelRightOpen size={15} /></IconButton>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {loading ? (
            <div className="flex h-full items-center justify-center"><Spinner /></div>
          ) : error ? (
            <div className="p-6"><AdminError message={error} onRetry={() => void loadPage(true)} /></div>
          ) : page?.noteId && loaded ? (
            <Workspace />
          ) : page ? (
            <LegacyPageBody page={page} onSaved={() => void loadPage()} />
          ) : null}
        </div>
        <aside className="hidden w-[304px] shrink-0 overflow-y-auto border-l border-[var(--border-subtle)] bg-[var(--bg-base)] lg:block">
          {page && <PageSettings page={page} onChanged={() => void loadPage()} />}
        </aside>
      </div>

      <Drawer open={settingsOpen} onClose={() => setSettingsOpen(false)} side="right" width={340} title={t('blog.admin.page_settings')}>
        {page && <PageSettings page={page} onChanged={() => void loadPage()} />}
      </Drawer>

      <Modal open={historyOpen} onClose={() => setHistoryOpen(false)} title={t('blog.admin.revisions')} width={980} bodyClassName="h-[70vh] p-0">
        <div className="h-full min-h-0"><VersionsPanel onClose={() => setHistoryOpen(false)} /></div>
      </Modal>
    </div>
  )
}

function LegacyPageBody({ page, onSaved }: { page: BlogPageItem; onSaved: () => void }) {
  const toast = useUi((state) => state.toast)
  const [body, setBody] = useState(page.body)
  const [busy, setBusy] = useState(false)
  const dirty = body !== page.body
  const save = async () => {
    setBusy(true)
    try {
      await api.blog.pages.update(page.id, {
        title: page.title,
        slug: page.slug,
        kind: page.kind,
        body,
        publish: page.publishedAt !== null,
      })
      toast({ title: t('blog.admin.saved'), tone: 'success' })
      onSaved()
    } catch (error) {
      toast({ title: t('blog.admin.save_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <p className="mb-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('blog.admin.legacy_page_hint')}</p>
      <Textarea value={body} onChange={(event) => setBody(event.target.value)} className="min-h-0 flex-1 font-mono" aria-label={t('blog.admin.page_body')} />
      <div className="mt-2 flex justify-end">
        <Button size="sm" loading={busy} disabled={!dirty} onClick={() => void save()}>{t('blog.admin.save')}</Button>
      </div>
    </div>
  )
}

function PageSettings({ page, onChanged }: { page: BlogPageItem; onChanged: () => void }) {
  const toast = useUi((state) => state.toast)
  const [slug, setSlug] = useState(page.slug)
  const [kind, setKind] = useState(page.kind)
  const [schedule, setSchedule] = useState('')
  const [busy, setBusy] = useState('')

  useEffect(() => {
    setSlug(page.slug)
    setKind(page.kind)
  }, [page.id, page.slug, page.kind])

  const saveSlug = async () => {
    setBusy('slug')
    try {
      await api.blog.pages.update(page.id, {
        title: page.title,
        slug,
        kind,
        body: page.body,
        publish: page.publishedAt !== null,
      })
      toast({ title: t('blog.admin.saved'), tone: 'success' })
      onChanged()
    } catch (error) {
      toast({ title: t('blog.admin.save_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    } finally {
      setBusy('')
    }
  }

  const publish = async (published: boolean) => {
    setBusy(published ? 'publish' : 'unpublish')
    try {
      if (page.noteId) {
        const { publishNoteToBlog } = await import('../blog/publish')
        const ok = await publishNoteToBlog(page.noteId, published, {
          publishedAt: published ? (schedule ? new Date(schedule).toISOString() : null) : null,
        })
        if (!ok) return
      } else {
        await api.blog.pages.publish(page.id, published)
      }
      onChanged()
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="space-y-4 p-3">
      <section>
        <h2 className="px-1 pb-1 text-[length:var(--text-10-5)] font-semibold uppercase tracking-[0.075em] text-[var(--text-quaternary)]">{t('blog.admin.publish')}</h2>
        <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
          <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
            {page.publishedAt ? t('blog.admin.page_live_hint') : t('blog.admin.page_draft_hint')}
          </p>
          {page.publishedAt && <p className="mt-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{formatDateTime(page.publishedAt)}</p>}
          {!page.publishedAt && (
            <Field label={t('blog.admin.publish_date')} className="mt-2">
              <DatePicker label={t('blog.admin.publish_date')} value={schedule} withTime onChange={setSchedule} />
            </Field>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button size="sm" loading={busy === 'publish'} onClick={() => void publish(true)}>{page.publishedAt ? t('blog.admin.update') : t('blog.admin.publish_now')}</Button>
            {page.publishedAt && <Button size="sm" variant="ghost" loading={busy === 'unpublish'} onClick={() => void publish(false)}>{t('blog.admin.unpublish')}</Button>}
          </div>
        </div>
      </section>

      <section>
        <h2 className="px-1 pb-1 text-[length:var(--text-10-5)] font-semibold uppercase tracking-[0.075em] text-[var(--text-quaternary)]">{t('blog.admin.url_language')}</h2>
        <div className="space-y-2 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
          <Field label={t('blog.admin.slug')}><Input value={slug} onChange={(event) => setSlug(event.target.value)} /></Field>
          <Field label={t('blog.admin.page_kind')}>
            <Select value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="custom">{t('blog.admin.page_kind_custom')}</option>
              <option value="about">{t('blog.admin.page_kind_about')}</option>
            </Select>
          </Field>
          <Button size="sm" loading={busy === 'slug'} onClick={() => void saveSlug()}>{t('blog.admin.save_details')}</Button>
        </div>
      </section>

      {page.noteId && (
        <a
          href={`/n/${encodeURIComponent(page.noteId)}`}
          onClick={(event) => { event.preventDefault(); navigateToPath(`/n/${encodeURIComponent(page.noteId as string)}`) }}
          className="block rounded-[var(--r-md)] border border-[var(--border-subtle)] px-3 py-2 text-center text-[length:var(--text-11-5)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
        >
          {t('blog.admin.open_in_notes')}
        </a>
      )}
    </div>
  )
}
