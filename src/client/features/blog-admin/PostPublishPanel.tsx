import { useEffect, useMemo, useState, type MutableRefObject } from 'react'
import { CalendarClock, ExternalLink, ImagePlus, RefreshCw, Trash2, X } from 'lucide-react'
import type { BlogSettings } from '@shared/blog/settings'
import type { BlogMediaItem, BlogPostAdminDetail, TaxonomyItem } from '@shared/blog/model'
import { Checkbox, Field, Input, Select, Textarea } from '../../components/form'
import { DatePicker } from '../../components/date-picker'
import { Badge, Button, SectionLabel } from '../../components/primitives'
import { confirm } from '../../components/overlay'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import { useUi } from '../../store/ui'
import { MediaPicker } from './MediaPicker'
import { PostStatusBadge, formatDateTime, useAdminResource } from './shared'

const LANGUAGES = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es', 'id', 'th', 'tr', 'vi']

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

function toLocalInput(value: number | null): string {
  if (!value) return ''
  const date = new Date(value)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function fromLocalInput(value: string): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function PostPublishPanel({
  noteId,
  post,
  noteUpdatedAt,
  savingNote,
  publishRef,
  onChanged,
  onOpenHistory,
}: {
  noteId: string
  post: BlogPostAdminDetail
  noteUpdatedAt: number
  savingNote: boolean
  publishRef: MutableRefObject<(() => Promise<void>) | null>
  onChanged: () => Promise<void>
  onOpenHistory: () => void
}) {
  const toast = useUi((state) => state.toast)
  const taxonomy = useAdminResource(() => api.blog.taxonomy.list(), [])
  const settings = useAdminResource(() => api.blog.settings.get(), [])
  const [slug, setSlug] = useState(post.slug)
  const [excerpt, setExcerpt] = useState(post.excerpt)
  const [description, setDescription] = useState(post.description)
  const [categoryId, setCategoryId] = useState(post.categoryId ?? '')
  const [seriesId, setSeriesId] = useState(post.seriesId ?? '')
  const [seriesOrder, setSeriesOrder] = useState(post.seriesOrder === null ? '' : String(post.seriesOrder))
  const [tags, setTags] = useState(post.tags.join(', '))
  const [pinned, setPinned] = useState(post.pinned)
  const [commentsEnabled, setCommentsEnabled] = useState(post.commentsEnabled)
  const [hideHomeContent, setHideHomeContent] = useState(post.hideHomeContent)
  const [language, setLanguage] = useState(post.language)
  const [license, setLicense] = useState(post.license)
  const [alias, setAlias] = useState(post.alias)
  const [permalink, setPermalink] = useState(post.permalink)
  const [coverAssetId, setCoverAssetId] = useState(post.coverAssetId ?? '')
  const [coverUrl, setCoverUrl] = useState(post.coverUrl ?? '')
  const [password, setPassword] = useState('')
  const [clearPassword, setClearPassword] = useState(false)
  const [schedule, setSchedule] = useState(toLocalInput(post.publishedAt))
  const [busy, setBusy] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => {
    setSlug(post.slug)
    setExcerpt(post.excerpt)
    setDescription(post.description)
    setCategoryId(post.categoryId ?? '')
    setSeriesId(post.seriesId ?? '')
    setSeriesOrder(post.seriesOrder === null ? '' : String(post.seriesOrder))
    setTags(post.tags.join(', '))
    setPinned(post.pinned)
    setCommentsEnabled(post.commentsEnabled)
    setHideHomeContent(post.hideHomeContent)
    setLanguage(post.language)
    setLicense(post.license)
    setAlias(post.alias)
    setPermalink(post.permalink)
    setCoverAssetId(post.coverAssetId ?? '')
    setCoverUrl(post.coverUrl ?? '')
    setSchedule(toLocalInput(post.publishedAt))
  }, [post.id, post.slug, post.excerpt, post.description, post.categoryId, post.seriesId, post.seriesOrder, post.tags, post.pinned, post.commentsEnabled, post.hideHomeContent, post.language, post.license, post.alias, post.permalink, post.coverAssetId, post.coverUrl, post.publishedAt])

  const siteUrl = typeof (settings.data as BlogSettings | null)?.site?.url === 'string'
    ? String((settings.data as BlogSettings).site.url).replace(/\/+$/, '')
    : ''
  const liveUrl = post.status === 'published' ? `${siteUrl}/posts/${post.slug}` : ''
  const draftChanges = post.status === 'published' && (post.renderStatus === 'stale' || savingNote || noteUpdatedAt > (post.renderGeneratedAt ?? 0))
  const dirty = useMemo(() => (
    slug !== post.slug ||
    excerpt !== post.excerpt ||
    description !== post.description ||
    categoryId !== (post.categoryId ?? '') ||
    seriesId !== (post.seriesId ?? '') ||
    seriesOrder !== (post.seriesOrder === null ? '' : String(post.seriesOrder)) ||
    tags !== post.tags.join(', ') ||
    pinned !== post.pinned ||
    commentsEnabled !== post.commentsEnabled ||
    hideHomeContent !== post.hideHomeContent ||
    language !== post.language ||
    license !== post.license ||
    alias !== post.alias ||
    permalink !== post.permalink ||
    coverAssetId !== (post.coverAssetId ?? '') ||
    password.length > 0 ||
    clearPassword
  ), [post, slug, excerpt, description, categoryId, seriesId, seriesOrder, tags, pinned, commentsEnabled, hideHomeContent, language, license, alias, permalink, coverAssetId, password, clearPassword])

  const saveDetails = async (silent = false): Promise<boolean> => {
    setBusy('save')
    try {
      const { updateNoteBlogMeta } = await import('../blog/publish')
      const tagNames = tags.split(',').map((tag) => tag.trim()).filter(Boolean).slice(0, 30)
      if (!(await updateNoteBlogMeta(noteId, { tags: tagNames }))) return false
      await api.blog.patchPost(post.id, {
        slug,
        excerpt,
        description,
        categoryId: categoryId || null,
        seriesId: seriesId || null,
        seriesOrder: seriesOrder === '' ? null : Number(seriesOrder),
        pinned,
        commentsEnabled,
        hideHomeContent,
        language,
        license,
        alias,
        permalink,
        coverAssetId: coverAssetId || null,
        ...(password.trim() ? { password } : {}),
        ...(clearPassword ? { clearPassword: true } : {}),
      })
      setPassword('')
      setClearPassword(false)
      if (!silent) toast({ title: t('blog.admin.saved'), tone: 'success' })
      await onChanged()
      return true
    } catch (error) {
      toast({
        title: t('blog.admin.save_failed'),
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      })
      return false
    } finally {
      setBusy('')
    }
  }

  const publishNow = async () => {
    setBusy('publish')
    try {
      if (dirty && !(await saveDetails(true))) return
      const now = Date.now()
      await api.blog.patchPost(post.id, { publishedAt: now })
      const { publishNoteToBlog } = await import('../blog/publish')
      if (await publishNoteToBlog(noteId, true, { publishedAt: new Date(now).toISOString() })) {
        await onChanged()
      }
    } catch (error) {
      toast({ title: t('blog.admin.publish_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    } finally {
      setBusy('')
    }
  }

  const schedulePublish = async () => {
    if (busy) return
    const at = fromLocalInput(schedule)
    if (at === null || at <= Date.now()) {
      toast({ title: t('blog.admin.schedule_invalid'), tone: 'danger' })
      return
    }
    setBusy('schedule')
    try {
      if (dirty && !(await saveDetails(true))) return
      await api.blog.patchPost(post.id, { publishedAt: at })
      const { publishNoteToBlog } = await import('../blog/publish')
      if (await publishNoteToBlog(noteId, true, { publishedAt: new Date(at).toISOString() })) {
        await onChanged()
      }
    } catch (error) {
      toast({ title: t('blog.admin.publish_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    } finally {
      setBusy('')
    }
  }

  const unpublish = async () => {
    const ok = await confirm({
      title: t('blog.admin.unpublish_title'),
      description: t('blog.admin.unpublish_desc'),
      confirmLabel: t('blog.admin.unpublish'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy('unpublish')
    try {
      const { publishNoteToBlog } = await import('../blog/publish')
      if (await publishNoteToBlog(noteId, false)) await onChanged()
    } finally {
      setBusy('')
    }
  }

  const refresh = async () => {
    setBusy('refresh')
    try {
      const { refreshBlogSnapshot } = await import('../blog/publish')
      if (await refreshBlogSnapshot(noteId)) await onChanged()
    } finally {
      setBusy('')
    }
  }

  const trash = async () => {
    const ok = await confirm({
      title: t('blog.admin.trash_title'),
      description: t('blog.admin.trash_desc'),
      confirmLabel: t('blog.admin.move_to_trash'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy('trash')
    try {
      await api.blog.trashPost(post.id)
      navigateToPath('/blog-admin/posts')
    } finally {
      setBusy('')
    }
  }

  publishRef.current = publishNow

  const chooseCover = (item: BlogMediaItem) => {
    setCoverAssetId(item.id)
    setCoverUrl(item.url)
  }

  return (
    <div className="space-y-4 p-3">
      <section aria-label={t('blog.admin.publish')}>
        <div className="flex items-center justify-between gap-2">
          <SectionLabel>{t('blog.admin.publish_section')}</SectionLabel>
        </div>
        <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
          <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2.5">
            <PostStatusBadge status={post.status} />
            {post.status === 'published' && post.publishedAt && (
              <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{formatDateTime(post.publishedAt)}</span>
            )}
            {post.status === 'scheduled' && post.publishedAt && (
              <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{formatDateTime(post.publishedAt)}</span>
            )}
            {post.encrypted && <Badge tone="warning">{t('blog.admin.protected')}</Badge>}
          </div>
          <div className="space-y-2 px-3 py-2.5 text-[length:var(--text-11-5)]">
            {post.status === 'published' && (
              <p className="flex items-start gap-2">
                <span aria-hidden="true" className="mt-1 size-1.5 shrink-0 rounded-full bg-[var(--success)]" />
                <span><strong className="font-medium text-[var(--text-primary)]">{t('blog.admin.live_version')}</strong><br /><span className="text-[var(--text-tertiary)]">{t('blog.admin.live_version_hint')}</span></span>
              </p>
            )}
            {draftChanges && (
              <p className="flex items-start gap-2">
                <span aria-hidden="true" className="mt-1 size-1.5 shrink-0 rounded-full bg-[var(--warning)]" />
                <span><strong className="font-medium text-[var(--text-primary)]">{t('blog.admin.draft_changes')}</strong><br /><span className="text-[var(--text-tertiary)]">{t('blog.admin.draft_changes_hint')}</span></span>
              </p>
            )}
            {post.status === 'draft' && (
              <p className="flex items-start gap-2">
                <span aria-hidden="true" className="mt-1 size-1.5 shrink-0 rounded-full bg-[var(--border-strong)]" />
                <span><strong className="font-medium text-[var(--text-primary)]">{t('blog.admin.draft_version')}</strong><br /><span className="text-[var(--text-tertiary)]">{t('blog.admin.draft_version_hint')}</span></span>
              </p>
            )}
            {post.status === 'scheduled' && (
              <p className="flex items-start gap-2">
                <span aria-hidden="true" className="mt-1 size-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
                <span><strong className="font-medium text-[var(--text-primary)]">{t('blog.admin.scheduled_version')}</strong><br /><span className="text-[var(--text-tertiary)]">{formatDateTime(post.publishedAt)}</span></span>
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5 border-t border-[var(--border-subtle)] px-3 py-2">
            {post.status === 'draft' ? (
              <Button size="sm" block loading={busy === 'publish'} onClick={() => void publishNow()}>{t('blog.admin.publish_now')}</Button>
            ) : (
              <>
                <Button size="sm" loading={busy === 'refresh'} icon={<RefreshCw size={12} />} onClick={() => void refresh()}>{t('blog.admin.update')}</Button>
                <Button size="sm" variant="ghost" loading={busy === 'publish'} onClick={() => void publishNow()}>{t('blog.admin.publish_now')}</Button>
              </>
            )}
            {(post.status === 'published' || post.status === 'scheduled') && (
              <Button size="sm" variant="ghost" loading={busy === 'unpublish'} onClick={() => void unpublish()}>{t('blog.admin.unpublish')}</Button>
            )}
          </div>
          {liveUrl && (
            <a href={liveUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 border-t border-[var(--border-subtle)] px-3 py-2 text-[length:var(--text-11-5)] text-[var(--accent)] hover:underline">
              <ExternalLink size={12} aria-hidden="true" /> {t('blog.admin.view_live')}
            </a>
          )}
        </div>
      </section>

      {post.status !== 'published' && (
      <section>
        <SectionLabel>{t('blog.admin.schedule')}</SectionLabel>
        <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
          <Field label={t('blog.admin.publish_date')} hint={t('blog.admin.publish_date_hint')}>
            <DatePicker label={t('blog.admin.publish_date')} value={schedule} withTime onChange={setSchedule} />
          </Field>
          <div className="mt-2 flex items-center gap-1.5">
            <Button size="sm" icon={<CalendarClock size={12} />} loading={busy === 'schedule'} onClick={() => void schedulePublish()}>{t('blog.admin.schedule_action')}</Button>
            {post.status === 'scheduled' && (
              <Button size="sm" variant="ghost" onClick={() => { setSchedule(''); void (async () => { const { updateNoteBlogMeta, publishNoteToBlog } = await import('../blog/publish'); await updateNoteBlogMeta(noteId, { blogPublishedAt: null }); await api.blog.patchPost(post.id, { publishedAt: null }); if (await publishNoteToBlog(noteId, false)) await onChanged() })() }}>{t('blog.admin.clear_schedule')}</Button>
            )}
          </div>
        </div>
      </section>
      )}

      <section>
        <SectionLabel>{t('blog.admin.url_language')}</SectionLabel>
        <div className="space-y-2 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
          <Field label={t('blog.admin.slug')}>
            <Input value={slug} onChange={(event) => setSlug(event.target.value)} />
          </Field>
          {siteUrl && <p className="truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{`${siteUrl}/posts/${slug}`}</p>}
          <Field label={t('blog.admin.language')}>
            <Select value={language} onChange={(event) => setLanguage(event.target.value)}>
              <option value="">{t('blog.admin.language_default')}</option>
              {LANGUAGES.map((code) => <option key={code} value={code}>{languageName(code)}</option>)}
            </Select>
          </Field>
          <Field label={t('blog.admin.alias')} hint={t('blog.admin.alias_hint')}>
            <Input value={alias} onChange={(event) => setAlias(event.target.value)} />
          </Field>
          <Field label={t('blog.admin.permalink')} hint={t('blog.admin.permalink_hint')}>
            <Input value={permalink} onChange={(event) => setPermalink(event.target.value)} />
          </Field>
        </div>
      </section>

      <section>
        <SectionLabel>{t('blog.admin.summary_seo')}</SectionLabel>
        <div className="space-y-2 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
          <Field label={t('blog.admin.excerpt')}>
            <Textarea rows={3} value={excerpt} onChange={(event) => setExcerpt(event.target.value)} />
          </Field>
          <Field label={t('blog.admin.meta_description')} hint={t('blog.admin.meta_description_hint')}>
            <Textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
          </Field>
        </div>
      </section>

      <section>
        <SectionLabel>{t('blog.admin.featured_image')}</SectionLabel>
        <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
          {coverUrl ? (
            <div className="relative overflow-hidden rounded-[var(--r-md)]">
              <img src={coverUrl} alt="" className="aspect-[16/9] w-full object-cover" />
              <button type="button" onClick={() => { setCoverAssetId(''); setCoverUrl('') }} className="absolute right-1.5 top-1.5 rounded-full bg-black/60 p-1 text-white" aria-label={t('blog.admin.remove_cover')}>
                <X size={12} />
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => setPickerOpen(true)} className="flex aspect-[16/9] w-full flex-col items-center justify-center gap-1.5 rounded-[var(--r-md)] border border-dashed border-[var(--border-strong)] text-[length:var(--text-11-5)] text-[var(--text-tertiary)] hover:border-[var(--accent)] hover:text-[var(--accent)]">
              <ImagePlus size={18} aria-hidden="true" />
              {t('blog.admin.set_cover')}
            </button>
          )}
          {coverUrl && <Button size="sm" variant="ghost" className="mt-2" onClick={() => setPickerOpen(true)}>{t('blog.admin.replace_cover')}</Button>}
        </div>
      </section>

      <section>
        <SectionLabel>{t('blog.admin.taxonomy')}</SectionLabel>
        <div className="space-y-2 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
          <Field label={t('blog.admin.category')}>
            <Select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
              <option value="">{t('blog.admin.no_category')}</option>
              {(taxonomy.data?.categories ?? []).map((item: TaxonomyItem) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </Select>
          </Field>
          <Field label={t('blog.admin.series')}>
            <Select value={seriesId} onChange={(event) => setSeriesId(event.target.value)}>
              <option value="">{t('blog.admin.no_series')}</option>
              {(taxonomy.data?.series ?? []).map((item: TaxonomyItem) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </Select>
          </Field>
          <Field label={t('blog.admin.series_order')}>
            <Input type="number" min={1} value={seriesOrder} onChange={(event) => setSeriesOrder(event.target.value)} />
          </Field>
          <Field label={t('blog.admin.tags')} hint={t('blog.admin.tags_hint')}>
            <Input value={tags} onChange={(event) => setTags(event.target.value)} />
          </Field>
        </div>
      </section>

      <section>
        <SectionLabel>{t('blog.admin.options')}</SectionLabel>
        <div className="space-y-2 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
          <Checkbox checked={pinned} onChange={setPinned} label={t('blog.admin.pinned')} />
          <Checkbox checked={commentsEnabled} onChange={setCommentsEnabled} label={t('blog.admin.comments_enabled')} />
          <Checkbox checked={hideHomeContent} onChange={setHideHomeContent} label={t('blog.admin.hide_home')} />
          <Field label={t('blog.admin.license')}>
            <Input value={license} onChange={(event) => setLicense(event.target.value)} />
          </Field>
          <Field label={t('blog.admin.password')} hint={t('blog.admin.password_hint')}>
            <Input type="password" value={password} onChange={(event) => { setPassword(event.target.value); setClearPassword(false) }} autoComplete="new-password" />
          </Field>
          {post.encrypted && (
            <Checkbox checked={clearPassword} onChange={setClearPassword} label={t('blog.admin.clear_password')} />
          )}
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="ghost" onClick={onOpenHistory}>{t('blog.admin.revisions')}</Button>
        <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} loading={busy === 'refresh'} onClick={() => void refresh()}>{t('blog.admin.rebuild')}</Button>
      </div>

      <div className="flex flex-wrap gap-1.5 border-t border-[var(--border-subtle)] pt-3">
        <Button size="sm" block loading={busy === 'save'} disabled={!dirty} onClick={() => void saveDetails()}>{t('blog.admin.save_details')}</Button>
      </div>

      <button type="button" onClick={() => void trash()} className="flex w-full items-center justify-center gap-1.5 rounded-[var(--r-md)] px-2 py-1.5 text-[length:var(--text-11-5)] text-[var(--danger)] transition-colors hover:bg-[var(--danger-soft)]">
        <Trash2 size={12} aria-hidden="true" />
        {t('blog.admin.move_to_trash')}
      </button>

      <MediaPicker open={pickerOpen} onClose={() => setPickerOpen(false)} onSelect={chooseCover} />
    </div>
  )
}
