import { useCallback, useEffect, useState } from 'react'
import type { MessageKey } from '@shared/locales/en-US'
import type { BlogAdminOverview, BlogPostAdminItem } from '@shared/blog/model'
import { BLOG_SETTING_KEYS, type BlogSettingKey, type BlogSettings } from '@shared/blog/settings'
import { Badge, Button, SectionLabel, Spinner } from '../../components/primitives'
import { Checkbox, Field, Input, Select, Textarea } from '../../components/form'
import { confirm } from '../../components/overlay'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { navigateToPath, usePathname } from '../../lib/app-history'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { CommentsPanel } from './CommentsPanel'
import { MediaPanel } from './MediaPanel'
import { TaxonomyPanel } from './TaxonomyPanel'
import { PagesPanel } from './PagesPanel'

interface AdminData {
  overview: BlogAdminOverview
  posts: BlogPostAdminItem[]
  settings: BlogSettings
}

const SECTIONS = [
  { id: 'overview', path: '/blog-admin', label: 'blog.admin.overview' },
  { id: 'posts', path: '/blog-admin/posts', label: 'blog.admin.posts' },
  { id: 'comments', path: '/blog-admin/comments', label: 'blog.admin.comments' },
  { id: 'media', path: '/blog-admin/media', label: 'blog.admin.media' },
  { id: 'pages', path: '/blog-admin/pages', label: 'blog.admin.pages' },
  { id: 'taxonomy', path: '/blog-admin/taxonomy', label: 'blog.admin.taxonomy' },
  { id: 'settings', path: '/blog-admin/settings', label: 'blog.admin.settings' },
] as const satisfies readonly { id: string; path: string; label: MessageKey }[]

const STATUS_KEYS: Record<BlogPostAdminItem['status'], MessageKey> = {
  draft: 'blog.admin.status_draft',
  pending_snapshot: 'blog.admin.status_pending',
  published: 'blog.admin.status_published',
  withdrawn: 'blog.admin.status_withdrawn',
}

const RENDER_KEYS: Record<BlogPostAdminItem['renderStatus'], MessageKey> = {
  ready: 'blog.admin.render_ready',
  stale: 'blog.admin.render_stale',
  missing: 'blog.admin.render_missing',
  failed: 'blog.admin.render_failed',
}

const STATUS_TONES: Record<BlogPostAdminItem['status'], 'neutral' | 'accent' | 'success' | 'warning'> = {
  draft: 'neutral',
  pending_snapshot: 'warning',
  published: 'success',
  withdrawn: 'neutral',
}

function sectionOf(pathname: string): (typeof SECTIONS)[number] {
  return [...SECTIONS].sort((a, b) => b.path.length - a.path.length).find((section) => pathname === section.path || pathname.startsWith(`${section.path}/`)) ?? SECTIONS[0]
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function formatDate(value: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  } catch {
    return new Date(value).toISOString()
  }
}

export function BlogAdminApp() {
  const pathname = usePathname()
  const section = sectionOf(pathname)
  const status = useSession((state) => state.status)
  const role = useSession((state) => state.user?.role)
  const [data, setData] = useState<AdminData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [overview, posts, settings] = await Promise.all([
        api.blog.overview(),
        api.blog.posts({ limit: 100 }),
        api.blog.settings.get(),
      ])
      setData({ overview, posts: posts.items, settings })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (role === 'owner') void load()
  }, [role, load])

  if (status !== 'authed') {
    return <div className="flex h-full items-center justify-center"><Spinner /></div>
  }
  if (role !== 'owner') {
    return <div className="flex h-full items-center justify-center p-6 text-sm text-[var(--text-tertiary)]">{t('blog.admin.forbidden')}</div>
  }

  const blogUrl = stringValue(data?.settings.site.url)

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-base)] md:flex-row">
      <aside className="flex shrink-0 flex-col gap-4 border-b border-[var(--border-subtle)] p-4 md:w-56 md:border-r md:border-b-0 md:p-5">
        <div>
          <SectionLabel>{t('blog.admin.title')}</SectionLabel>
          <p className="mt-1 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
            {t('blog.admin.subtitle')}
          </p>
        </div>
        <nav aria-label={t('blog.admin.title')} className="flex gap-1 overflow-x-auto md:flex-col">
          {SECTIONS.map((item) => {
            const active = item.id === section.id
            return (
              <a
                key={item.id}
                href={item.path}
                aria-current={active ? 'page' : undefined}
                onClick={(event) => {
                  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
                  event.preventDefault()
                  navigateToPath(item.path)
                }}
                className={active
                  ? 'rounded-[var(--r-md)] bg-[var(--accent-soft)] px-3 py-2 text-[length:var(--text-12-5)] font-medium text-[var(--accent-on-soft)]'
                  : 'rounded-[var(--r-md)] px-3 py-2 text-[length:var(--text-12-5)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}
              >
                {t(item.label)}
              </a>
            )
          })}
        </nav>
        {blogUrl
          ? <a href={blogUrl} target="_blank" rel="noopener noreferrer" className="text-[length:var(--text-12)] text-[var(--text-tertiary)] underline-offset-2 hover:text-[var(--accent)] hover:underline">{t('blog.admin.open_blog')}</a>
          : <span className="text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('blog.admin.open_blog')}</span>}
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto p-4 md:p-6">
        <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]">{t(section.label)}</h1>
            <p className="mt-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('blog.admin.subtitle')}</p>
          </div>
          <Button size="sm" onClick={() => void load()} loading={loading}>{t('blog.admin.refresh')}</Button>
        </header>

        {error ? (
          <div role="alert" className="rounded-[var(--r-lg)] border border-[var(--danger)]/30 bg-[var(--danger-soft)] p-4 text-[length:var(--text-12-5)] text-[var(--danger)]">
            <p className="font-medium">{t('blog.admin.load_failed')}</p>
            <p className="mt-1 break-words opacity-80">{error}</p>
            <Button size="sm" className="mt-3" onClick={() => void load()}>{t('blog.admin.retry')}</Button>
          </div>
        ) : loading && !data ? (
          <div className="flex items-center gap-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]"><Spinner /> {t('blog.admin.loading')}</div>
        ) : data ? (
          section.id === 'overview'
            ? <OverviewPanel overview={data.overview} />
            : section.id === 'posts'
              ? <PostsPanel posts={data.posts} onReload={load} />
              : section.id === 'comments'
                ? <CommentsPanel />
                : section.id === 'media'
                  ? <MediaPanel />
                  : section.id === 'pages'
                    ? <PagesPanel />
                    : section.id === 'taxonomy'
                      ? <TaxonomyPanel />
                      : <SettingsPanel settings={data.settings} onSaved={load} />
        ) : null}
      </main>
    </div>
  )
}

function OverviewPanel({ overview }: { overview: BlogAdminOverview }) {
  const cards: { label: MessageKey; value: number }[] = [
    { label: 'blog.admin.posts_published', value: overview.published },
    { label: 'blog.admin.posts_drafts', value: overview.drafts },
    { label: 'blog.admin.posts_pending', value: overview.pending },
    { label: 'blog.admin.posts_stale', value: overview.stale },
    { label: 'blog.admin.views', value: overview.views },
    { label: 'blog.admin.moments', value: overview.moments },
    { label: 'blog.admin.albums', value: overview.albums },
    { label: 'blog.admin.tasks', value: overview.tasks },
    { label: 'blog.admin.comments_pending', value: overview.commentsPending },
    { label: 'blog.admin.comments_approved', value: overview.commentsApproved },
    { label: 'blog.admin.comments_spam', value: overview.commentsSpam },
  ]
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((card) => (
        <div key={card.label} className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4">
          <p className="text-[length:var(--text-11-5)] font-medium tracking-wide text-[var(--text-tertiary)] uppercase">{t(card.label)}</p>
          <p className="mt-2 text-[length:var(--text-24)] font-semibold tabular-nums text-[var(--text-primary)]">{card.value}</p>
        </div>
      ))}
    </div>
  )
}

function PostsPanel({ posts, onReload }: { posts: BlogPostAdminItem[]; onReload: () => Promise<void> }) {
  const [busyId, setBusyId] = useState<string | null>(null)

  const run = async (noteId: string, publish: boolean) => {
    if (busyId) return
    if (!publish) {
      const ok = await confirm({
        title: t('blog.admin.unpublish_title'),
        description: t('blog.admin.unpublish_desc'),
        confirmLabel: t('blog.admin.unpublish'),
        tone: 'danger',
      })
      if (!ok) return
    }
    setBusyId(noteId)
    try {
      const { publishNoteToBlog } = await import('../blog/publish')
      const ok = await publishNoteToBlog(noteId, publish)
      if (ok) await onReload()
    } finally {
      setBusyId(null)
    }
  }

  if (posts.length === 0) {
    return <p className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5 text-[length:var(--text-12-5)] text-[var(--text-tertiary)]">{t('blog.admin.no_posts')}</p>
  }

  return (
    <div className="overflow-x-auto rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
      <table className="w-full min-w-[760px] border-collapse text-left text-[length:var(--text-12-5)]">
        <caption className="sr-only">{t('blog.admin.posts')}</caption>
        <thead className="border-b border-[var(--border-subtle)] text-[length:var(--text-11)] tracking-wide text-[var(--text-tertiary)] uppercase">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">{t('blog.admin.column_title')}</th>
            <th scope="col" className="px-4 py-3 font-medium">{t('blog.admin.column_status')}</th>
            <th scope="col" className="px-4 py-3 font-medium">{t('blog.admin.column_render')}</th>
            <th scope="col" className="px-4 py-3 font-medium">{t('blog.admin.column_updated')}</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">{t('blog.admin.column_actions')}</th>
          </tr>
        </thead>
        <tbody>
          {posts.map((post) => (
            <tr key={post.id} className="border-b border-[var(--border-subtle)] last:border-b-0">
              <td className="px-4 py-3 align-top">
                <p className="font-medium text-[var(--text-primary)]">{post.title || post.slug}</p>
                <p className="mt-0.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]">/{post.slug}</p>
              </td>
              <td className="px-4 py-3 align-top"><Badge tone={STATUS_TONES[post.status]}>{t(STATUS_KEYS[post.status])}</Badge></td>
              <td className="px-4 py-3 align-top">
                <Badge tone={post.renderStatus === 'ready' ? 'success' : post.renderStatus === 'stale' ? 'warning' : post.renderStatus === 'failed' ? 'danger' : 'neutral'}>
                  {t(RENDER_KEYS[post.renderStatus])}
                </Badge>
              </td>
              <td className="px-4 py-3 align-top text-[var(--text-tertiary)]">{formatDate(post.updatedAt)}</td>
              <td className="px-4 py-3 align-top">
                <div className="flex flex-wrap justify-end gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => navigateToPath(`/n/${encodeURIComponent(post.noteId)}`)}>{t('blog.admin.open_note')}</Button>
                  <Button size="sm" onClick={() => void run(post.noteId, true)} loading={busyId === post.noteId}>{t('blog.admin.publish')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => void run(post.noteId, false)} disabled={busyId === post.noteId}>{t('blog.admin.unpublish')}</Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const LOCALES = [
  { value: 'en', label: 'English' },
  { value: 'zh-CN', label: 'zh-CN' },
  { value: 'zh-TW', label: 'zh-TW' },
  { value: 'ja', label: 'ja' },
  { value: 'ko', label: 'ko' },
  { value: 'es', label: 'es' },
  { value: 'id', label: 'id' },
  { value: 'th', label: 'th' },
  { value: 'tr', label: 'tr' },
  { value: 'vi', label: 'vi' },
] as const

function SettingsPanel({ settings, onSaved }: { settings: BlogSettings; onSaved: () => Promise<void> }) {
  const site = settings.site
  const profile = settings.profile
  const [title, setTitle] = useState(stringValue(site.title))
  const [subtitle, setSubtitle] = useState(stringValue(site.subtitle))
  const [description, setDescription] = useState(stringValue(site.description))
  const [locale, setLocale] = useState(stringValue(site.locale) || 'en')
  const [timeZone, setTimeZone] = useState(stringValue(site.timeZone) || 'UTC')
  const [profileName, setProfileName] = useState(stringValue(profile.name))
  const [profileBio, setProfileBio] = useState(stringValue(profile.bio))
  const discussion = settings.discussion
  const [discussionEnabled, setDiscussionEnabled] = useState(discussion.enabled !== false)
  const [requireNameEmail, setRequireNameEmail] = useState(discussion.requireNameEmail !== false)
  const [requireApproval, setRequireApproval] = useState(discussion.requireApproval !== false)
  const [allowReplies, setAllowReplies] = useState(discussion.allowReplies !== false)
  const [maxLength, setMaxLength] = useState(String(Number(discussion.maxLength) || 4000))
  const [rateLimit, setRateLimit] = useState(String(Number(discussion.rateLimitPerHour) || 5))
  const [autoCloseDays, setAutoCloseDays] = useState(String(Number(discussion.autoCloseDays) || 0))
  const [advancedDomain, setAdvancedDomain] = useState<BlogSettingKey>('nav')
  const [advancedJson, setAdvancedJson] = useState(() => JSON.stringify(settings.nav, null, 2))
  const [advancedError, setAdvancedError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setTitle(stringValue(site.title))
    setSubtitle(stringValue(site.subtitle))
    setDescription(stringValue(site.description))
    setLocale(stringValue(site.locale) || 'en')
    setTimeZone(stringValue(site.timeZone) || 'UTC')
    setProfileName(stringValue(profile.name))
    setProfileBio(stringValue(profile.bio))
    const nextDiscussion = settings.discussion
    setDiscussionEnabled(nextDiscussion.enabled !== false)
    setRequireNameEmail(nextDiscussion.requireNameEmail !== false)
    setRequireApproval(nextDiscussion.requireApproval !== false)
    setAllowReplies(nextDiscussion.allowReplies !== false)
    setMaxLength(String(Number(nextDiscussion.maxLength) || 4000))
    setRateLimit(String(Number(nextDiscussion.rateLimitPerHour) || 5))
    setAutoCloseDays(String(Number(nextDiscussion.autoCloseDays) || 0))
    setAdvancedJson(JSON.stringify(settings[advancedDomain], null, 2))
  }, [site, profile, discussion, settings, advancedDomain])

  const save = async () => {
    setSaving(true)
    try {
      await api.blog.settings.patch('site', { ...site, title, subtitle, description, locale, timeZone })
      await api.blog.settings.patch('profile', { ...profile, name: profileName, bio: profileBio })
      await api.blog.settings.patch('discussion', {
        ...discussion,
        enabled: discussionEnabled,
        requireNameEmail,
        requireApproval,
        allowReplies,
        maxLength: Number(maxLength) || 4000,
        rateLimitPerHour: Number(rateLimit) || 5,
        autoCloseDays: Number(autoCloseDays) || 0,
      })
      useUi.getState().toast({ title: t('blog.admin.saved'), tone: 'success' })
      await onSaved()
    } catch (cause) {
      useUi.getState().toast({
        title: t('blog.admin.save_failed'),
        description: cause instanceof Error ? cause.message : String(cause),
        tone: 'danger',
      })
    } finally {
      setSaving(false)
    }
  }

  const saveAdvanced = async () => {
    setAdvancedError('')
    try {
      const parsed = JSON.parse(advancedJson)
      await api.blog.settings.patch(advancedDomain, parsed)
      useUi.getState().toast({ title: t('blog.admin.saved'), tone: 'success' })
      await onSaved()
    } catch (cause) {
      setAdvancedError(cause instanceof SyntaxError
        ? t('blog.admin.advanced_invalid')
        : cause instanceof Error ? cause.message : String(cause))
    }
  }

  const changeAdvancedDomain = (next: BlogSettingKey) => {
    setAdvancedDomain(next)
    setAdvancedJson(JSON.stringify(settings[next], null, 2))
    setAdvancedError('')
  }

  return (
    <form className="grid max-w-3xl gap-6" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <section className="space-y-4 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 sm:p-5">
        <h2 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">{t('blog.admin.site_section')}</h2>
        <Field label={t('blog.admin.site_title')}><Input value={title} onChange={(event) => setTitle(event.target.value)} /></Field>
        <Field label={t('blog.admin.site_subtitle')}><Input value={subtitle} onChange={(event) => setSubtitle(event.target.value)} /></Field>
        <Field label={t('blog.admin.site_description')}><Textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('blog.admin.site_locale')}>
            <Select value={locale} onChange={(event) => setLocale(event.target.value)}>
              {LOCALES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </Select>
          </Field>
          <Field label={t('blog.admin.site_timezone')}><Input value={timeZone} onChange={(event) => setTimeZone(event.target.value)} /></Field>
        </div>
      </section>
      <section className="space-y-4 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 sm:p-5">
        <h2 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">{t('blog.admin.profile_section')}</h2>
        <Field label={t('blog.admin.profile_name')}><Input value={profileName} onChange={(event) => setProfileName(event.target.value)} /></Field>
        <Field label={t('blog.admin.profile_bio')}><Textarea rows={3} value={profileBio} onChange={(event) => setProfileBio(event.target.value)} /></Field>
      </section>
      <section className="space-y-4 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 sm:p-5">
        <h2 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">{t('blog.admin.discussion_section')}</h2>
        <div className="grid gap-1 sm:grid-cols-2">
          <Checkbox checked={discussionEnabled} onChange={setDiscussionEnabled} label={t('blog.admin.discussion_enabled')} />
          <Checkbox checked={requireNameEmail} onChange={setRequireNameEmail} label={t('blog.admin.discussion_require_name_email')} />
          <Checkbox checked={requireApproval} onChange={setRequireApproval} label={t('blog.admin.discussion_require_approval')} />
          <Checkbox checked={allowReplies} onChange={setAllowReplies} label={t('blog.admin.discussion_allow_replies')} />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t('blog.admin.discussion_max_length')}><Input type="number" min={200} max={10000} value={maxLength} onChange={(event) => setMaxLength(event.target.value)} /></Field>
          <Field label={t('blog.admin.discussion_rate_limit')}><Input type="number" min={1} max={100} value={rateLimit} onChange={(event) => setRateLimit(event.target.value)} /></Field>
          <Field label={t('blog.admin.discussion_auto_close')}><Input type="number" min={0} max={3650} value={autoCloseDays} onChange={(event) => setAutoCloseDays(event.target.value)} /></Field>
        </div>
      </section>
      <section className="space-y-4 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 sm:p-5">
        <h2 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">{t('blog.admin.advanced_section')}</h2>
        <p className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('blog.admin.advanced_hint')}</p>
        <Field label={t('blog.admin.advanced_domain')}>
          <Select value={advancedDomain} onChange={(event) => changeAdvancedDomain(event.target.value as BlogSettingKey)}>
            {BLOG_SETTING_KEYS.map((key) => <option key={key} value={key}>{key}</option>)}
          </Select>
        </Field>
        <Field label={t('blog.admin.advanced_json')}>
          <Textarea rows={14} className="font-mono" value={advancedJson} onChange={(event) => setAdvancedJson(event.target.value)} spellCheck={false} />
        </Field>
        {advancedError && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{advancedError}</p>}
        <Button type="button" onClick={() => void saveAdvanced()}>{t('blog.admin.save')}</Button>
      </section>
      <div><Button type="submit" loading={saving}>{t('blog.admin.save')}</Button></div>
    </form>
  )
}

