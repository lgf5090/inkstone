import { useEffect, useMemo, useState } from 'react'
import {
  ArrowUpDown,
  ExternalLink,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import type { BlogAdminOverview, BlogPostAdminItem, TaxonomyItem } from '@shared/blog/model'
import { Checkbox, Field, Input, Select, Textarea } from '../../components/form'
import { Badge, Button, IconButton } from '../../components/primitives'
import { Menu, Modal, confirm, type MenuItem } from '../../components/overlay'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { navigateToPath, replaceAddress, useSearch } from '../../lib/app-history'
import { useUi } from '../../store/ui'
import {
  AdminCard,
  AdminEmpty,
  AdminError,
  AdminLoading,
  PageHeader,
  PostStatusBadge,
  RenderStatusBadge,
  SearchField,
  TabBar,
  formatDate,
  useAdminResource,
  useDebounced,
} from './shared'

type StatusTab = 'all' | 'published' | 'draft' | 'scheduled' | 'trash'

function statusFromSearch(search: string): StatusTab {
  const value = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('status')
  return value === 'published' || value === 'draft' || value === 'scheduled' || value === 'trash' ? value : 'all'
}

export function PostsPanel({ onReloadOverview }: { onReloadOverview: () => Promise<void> }) {
  const search = useSearch()
  const toast = useUi((state) => state.toast)
  const [status, setStatus] = useState<StatusTab>(() => statusFromSearch(search))
  const [query, setQuery] = useState('')
  const debouncedQuery = useDebounced(query, 300)
  const [category, setCategory] = useState('')
  const [tag, setTag] = useState('')
  const [series, setSeries] = useState('')
  const [sort, setSort] = useState('updated')
  const [page, setPage] = useState(1)
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [quickEdit, setQuickEdit] = useState<BlogPostAdminItem | null>(null)
  const [menuFor, setMenuFor] = useState<{ post: BlogPostAdminItem; anchor: { x: number; y: number } } | null>(null)

  const posts = useAdminResource(
    () => api.blog.posts({ status, q: debouncedQuery, category, tag, series, sort, page, limit: 20 }),
    [status, debouncedQuery, category, tag, series, sort, page],
  )
  const overview = useAdminResource<BlogAdminOverview>(() => api.blog.overview(), [])
  const taxonomy = useAdminResource(() => api.blog.taxonomy.list(), [])
  const settings = useAdminResource(() => api.blog.settings.get(), [])

  useEffect(() => {
    setStatus(statusFromSearch(search))
  }, [search])

  useEffect(() => {
    setSelection(new Set())
  }, [status, debouncedQuery, category, tag, series, page])

  const rawSiteUrl = settings.data?.site.url
  const siteUrl = typeof rawSiteUrl === 'string' ? rawSiteUrl.replace(/\/+$/, '') : ''
  const items = posts.data?.items ?? []
  const total = posts.data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / 20))
  const allSelected = items.length > 0 && items.every((post) => selection.has(post.noteId))

  const reloadAll = async () => {
    await Promise.all([posts.reload(), overview.reload()])
    await onReloadOverview()
  }

  const changeStatus = (next: StatusTab) => {
    setStatus(next)
    setPage(1)
    setSelection(new Set())
    replaceAddress('/blog-admin/posts', next === 'all' ? '' : `?status=${next}`)
  }

  const run = async (key: string, action: () => Promise<void>) => {
    if (busy) return
    setBusy(key)
    try {
      await action()
    } finally {
      setBusy(null)
    }
  }

  const publishOrRefresh = (post: BlogPostAdminItem) => run(post.noteId, async () => {
    const blog = await import('../blog/publish')
    const ok = post.status === 'draft'
      ? await blog.publishNoteToBlog(post.noteId, true)
      : await blog.refreshBlogSnapshot(post.noteId)
    if (ok) await reloadAll()
  })

  const unpublish = (post: BlogPostAdminItem) => run(post.noteId, async () => {
    const ok = await confirm({
      title: t('blog.admin.unpublish_title'),
      description: t('blog.admin.unpublish_desc'),
      confirmLabel: t('blog.admin.unpublish'),
      tone: 'danger',
    })
    if (!ok) return
    const { publishNoteToBlog } = await import('../blog/publish')
    if (await publishNoteToBlog(post.noteId, false)) await reloadAll()
  })

  const trash = (post: BlogPostAdminItem) => run(post.noteId, async () => {
    const ok = await confirm({
      title: t('blog.admin.trash_title'),
      description: t('blog.admin.trash_desc'),
      confirmLabel: t('blog.admin.move_to_trash'),
      tone: 'danger',
    })
    if (!ok) return
    await api.blog.trashPost(post.id)
    await reloadAll()
  })

  const restore = (post: BlogPostAdminItem) => run(post.noteId, async () => {
    await api.blog.restorePost(post.id)
    await reloadAll()
  })

  const remove = (post: BlogPostAdminItem) => run(post.noteId, async () => {
    const ok = await confirm({
      title: t('blog.admin.delete_title'),
      description: t('blog.admin.delete_desc'),
      confirmLabel: t('blog.admin.delete_forever'),
      tone: 'danger',
    })
    if (!ok) return
    await api.blog.deletePost(post.id)
    await reloadAll()
  })

  const togglePin = (post: BlogPostAdminItem) => run(post.noteId, async () => {
    await api.blog.patchPost(post.id, { pinned: !post.pinned })
    await reloadAll()
  })

  const bulk = async (action: 'unpublish' | 'trash' | 'restore' | 'pin' | 'unpin') => {
    if (bulkBusy || selection.size === 0) return
    if (action === 'trash' || action === 'unpublish') {
      const ok = await confirm({
        title: t(action === 'trash' ? 'blog.admin.bulk_trash_title' : 'blog.admin.bulk_unpublish_title'),
        description: t(action === 'trash' ? 'blog.admin.bulk_trash_desc' : 'blog.admin.bulk_unpublish_desc', { count: selection.size }),
        confirmLabel: t(action === 'trash' ? 'blog.admin.move_to_trash' : 'blog.admin.unpublish'),
        tone: 'danger',
      })
      if (!ok) return
    }
    setBulkBusy(true)
    try {
      if (action === 'unpublish') {
        const { publishNoteToBlog } = await import('../blog/publish')
        let updated = 0
        for (const noteId of selection) if (await publishNoteToBlog(noteId, false)) updated += 1
        toast({
          title: t('blog.admin.bulk_done', { count: updated }),
          tone: updated === selection.size ? 'success' : 'warning',
        })
      } else {
        const result = await api.blog.bulkPosts([...selection], action)
        toast({ title: t('blog.admin.bulk_done', { count: result.updated }), tone: 'success' })
      }
      setSelection(new Set())
      await reloadAll()
    } catch (error) {
      toast({ title: t('blog.admin.bulk_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    } finally {
      setBulkBusy(false)
    }
  }

  const quickEditSave = async (patch: Record<string, unknown>) => {
    if (!quickEdit) return
    setBusy(quickEdit.noteId)
    try {
      await api.blog.patchPost(quickEdit.id, patch)
      setQuickEdit(null)
      await reloadAll()
      toast({ title: t('blog.admin.saved'), tone: 'success' })
    } catch (error) {
      toast({ title: t('blog.admin.save_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    } finally {
      setBusy(null)
    }
  }

  const menuItems = (post: BlogPostAdminItem): MenuItem[] => {
    const items: MenuItem[] = [
      { id: 'edit', label: t('blog.admin.edit'), icon: <Pencil size={13} />, onSelect: () => navigateToPath(`/blog-admin/posts/${encodeURIComponent(post.noteId)}`) },
      { id: 'quick', label: t('blog.admin.quick_edit'), icon: <ArrowUpDown size={13} />, onSelect: () => setQuickEdit(post) },
      { id: 'pin', label: t('blog.admin.pin'), icon: <Pin size={13} />, onSelect: () => void togglePin(post) },
      { id: 'publish', label: post.status === 'draft' ? t('blog.admin.publish') : t('blog.admin.refresh_snapshot'), icon: <RefreshCw size={13} />, onSelect: () => void publishOrRefresh(post) },
    ]
    if (post.status === 'published' && siteUrl) {
      items.push({ id: 'view', label: t('blog.admin.view_live'), icon: <ExternalLink size={13} />, onSelect: () => window.open(`${siteUrl}/posts/${post.slug}`, '_blank', 'noopener,noreferrer') })
    }
    if (post.status === 'published' || post.status === 'scheduled') {
      items.push({ id: 'unpublish', label: t('blog.admin.unpublish'), icon: <ExternalLink size={13} />, onSelect: () => void unpublish(post), tone: 'danger' })
    }
    if (status === 'trash') {
      items.push({ id: 'restore', label: t('blog.admin.restore'), icon: <RefreshCw size={13} />, onSelect: () => void restore(post) })
      items.push({ id: 'delete', label: t('blog.admin.delete_forever'), icon: <Trash2 size={13} />, onSelect: () => void remove(post), tone: 'danger' })
    } else {
      items.push({ id: 'trash', label: t('blog.admin.move_to_trash'), icon: <Trash2 size={13} />, onSelect: () => void trash(post), tone: 'danger' })
    }
    return items
  }

  const tabs = useMemo(() => [
    { id: 'all' as const, label: t('blog.admin.posts_all'), count: overview.data?.posts },
    { id: 'published' as const, label: t('blog.admin.posts_published'), count: overview.data?.published },
    { id: 'draft' as const, label: t('blog.admin.posts_drafts'), count: overview.data?.drafts },
    { id: 'scheduled' as const, label: t('blog.admin.posts_scheduled'), count: overview.data?.scheduled },
    { id: 'trash' as const, label: t('blog.admin.trash'), count: overview.data?.trash },
  ], [overview.data])

  return (
    <div className="mx-auto max-w-[1240px]">
      <PageHeader
        title={t('blog.admin.posts')}
        description={t('blog.admin.posts_subtitle')}
        actions={<Button size="sm" icon={<Plus size={13} />} onClick={() => navigateToPath('/blog-admin/posts/new')}>{t('blog.admin.new_post')}</Button>}
      />

      <TabBar tabs={tabs} value={status} onChange={changeStatus} label={t('blog.admin.posts')} />

      <div className="my-3 flex flex-wrap items-center gap-2">
        <SearchField value={query} onChange={(value) => { setQuery(value); setPage(1) }} placeholder={t('blog.admin.search_posts')} className="min-w-[180px] max-w-sm" />
        <Select aria-label={t('blog.admin.categories')} value={category} onChange={(event) => { setCategory(event.target.value); setPage(1) }} className="w-auto min-w-[120px]">
          <option value="">{t('blog.admin.all_categories')}</option>
          {(taxonomy.data?.categories ?? []).map((item: TaxonomyItem) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </Select>
        <Select aria-label={t('blog.admin.tags')} value={tag} onChange={(event) => { setTag(event.target.value); setPage(1) }} className="w-auto min-w-[110px]">
          <option value="">{t('blog.admin.all_tags')}</option>
          {(taxonomy.data?.tags ?? []).map((item: TaxonomyItem) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </Select>
        <Select aria-label={t('blog.admin.series')} value={series} onChange={(event) => { setSeries(event.target.value); setPage(1) }} className="w-auto min-w-[110px]">
          <option value="">{t('blog.admin.all_series')}</option>
          {(taxonomy.data?.series ?? []).map((item: TaxonomyItem) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </Select>
        <Select aria-label={t('blog.admin.sort')} value={sort} onChange={(event) => { setSort(event.target.value); setPage(1) }} className="w-auto min-w-[110px]">
          <option value="updated">{t('blog.admin.sort_updated')}</option>
          <option value="published">{t('blog.admin.sort_published')}</option>
          <option value="created">{t('blog.admin.sort_created')}</option>
          <option value="title">{t('blog.admin.sort_title')}</option>
        </Select>
      </div>

      {selection.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-[var(--r-md)] border border-[var(--accent)]/25 bg-[var(--accent-soft)] px-3 py-2">
          <span className="text-[length:var(--text-12)] font-medium text-[var(--accent-on-soft)]">{t('blog.admin.selected_count', { count: selection.size })}</span>
          {status !== 'trash' && (
            <>
              <Button size="sm" variant="ghost" loading={bulkBusy} onClick={() => void bulk('unpublish')}>{t('blog.admin.unpublish')}</Button>
              <Button size="sm" variant="ghost" loading={bulkBusy} onClick={() => void bulk('pin')}>{t('blog.admin.pin')}</Button>
              <Button size="sm" variant="ghost" loading={bulkBusy} onClick={() => void bulk('unpin')}>{t('blog.admin.unpin')}</Button>
              <Button size="sm" variant="ghost" loading={bulkBusy} onClick={() => void bulk('trash')}>{t('blog.admin.move_to_trash')}</Button>
            </>
          )}
          {status === 'trash' && (
            <Button size="sm" variant="ghost" loading={bulkBusy} onClick={() => void bulk('restore')}>{t('blog.admin.restore')}</Button>
          )}
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelection(new Set())}>{t('blog.admin.clear_selection')}</Button>
        </div>
      )}

      {posts.error ? (
        <AdminError message={posts.error} onRetry={() => void posts.reload()} />
      ) : !posts.data ? (
        <AdminLoading />
      ) : items.length === 0 ? (
        <AdminEmpty>{status === 'trash' ? t('blog.admin.trash_empty') : t('blog.admin.no_posts')}</AdminEmpty>
      ) : (
        <AdminCard className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] border-collapse text-left text-[length:var(--text-12-5)]">
              <caption className="sr-only">{t('blog.admin.posts')}</caption>
              <thead>
                <tr className="border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                  <th scope="col" className="w-9 px-3 py-2">
                    <Checkbox
                      checked={allSelected}
                      onChange={(next) => {
                        const copy = new Set(selection)
                        for (const post of items) {
                          if (next) copy.add(post.noteId)
                          else copy.delete(post.noteId)
                        }
                        setSelection(copy)
                      }}
                      ariaLabel={t('blog.admin.select_all_posts')}
                    />
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('blog.admin.column_title')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('blog.admin.column_status')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('blog.admin.column_render')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('blog.admin.column_comments')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('blog.admin.views')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('blog.admin.column_date')}</th>
                  <th scope="col" className="w-10 px-2 py-2"><span className="sr-only">{t('blog.admin.column_actions')}</span></th>
                </tr>
              </thead>
              <tbody>
                {items.map((post) => (
                  <tr key={post.id} className="border-b border-[var(--border-subtle)] last:border-b-0 hover:bg-[var(--bg-hover)]">
                    <td className="px-3 py-2 align-top">
                      <Checkbox
                        checked={selection.has(post.noteId)}
                        onChange={(next) => {
                          const copy = new Set(selection)
                          if (next) copy.add(post.noteId)
                          else copy.delete(post.noteId)
                          setSelection(copy)
                        }}
                        ariaLabel={t('blog.admin.select_post', { title: post.title })}
                      />
                    </td>
                    <td className="min-w-[220px] px-2 py-2.5 align-top">
                      <button
                        type="button"
                        onClick={() => navigateToPath(`/blog-admin/posts/${encodeURIComponent(post.noteId)}`)}
                        className="block max-w-full truncate text-left font-medium text-[var(--text-primary)] hover:text-[var(--accent)]"
                      >
                        {post.title || t('blog.admin.untitled_post')}
                      </button>
                      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                        <span className="truncate">/{post.slug}</span>
                        {post.pinned && <Badge tone="accent">{t('blog.admin.pinned')}</Badge>}
                        {post.category && <span>· {post.category}</span>}
                      </p>
                    </td>
                    <td className="px-2 py-2.5 align-top"><PostStatusBadge status={post.status} /></td>
                    <td className="px-2 py-2.5 align-top"><RenderStatusBadge status={post.renderStatus} /></td>
                    <td className="px-2 py-2.5 align-top tabular text-[var(--text-tertiary)]">{post.commentCount}</td>
                    <td className="px-2 py-2.5 align-top tabular text-[var(--text-tertiary)]">{post.viewCount}</td>
                    <td className="whitespace-nowrap px-2 py-2.5 align-top text-[var(--text-tertiary)]">{formatDate(post.publishedAt ?? post.updatedAt)}</td>
                    <td className="px-2 py-2.5 align-top">
                      <IconButton
                        label={t('blog.admin.column_actions')}
                        size="sm"
                        onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenuFor({ post, anchor: { x: rect.left, y: rect.bottom } }) }}
                      >
                        <MoreHorizontal size={15} />
                      </IconButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminCard>
      )}

      {items.length > 0 && (
        <div className="mt-3 flex items-center justify-between text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          <span>{t('blog.admin.posts_range', { from: (page - 1) * 20 + 1, to: Math.min(page * 20, total), total })}</span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>{t('blog.admin.previous')}</Button>
            <span>{t('blog.admin.page_of', { current: page, total: pageCount })}</span>
            <Button size="sm" variant="ghost" disabled={page >= pageCount} onClick={() => setPage((current) => current + 1)}>{t('blog.admin.next')}</Button>
          </div>
        </div>
      )}

      {menuFor && (
        <Menu
          anchor={menuFor.anchor}
          open
          onClose={() => setMenuFor(null)}
          items={menuItems(menuFor.post)}
          label={t('blog.admin.column_actions')}
        />
      )}

      {quickEdit && (
        <QuickEditModal
          post={quickEdit}
          taxonomy={taxonomy.data}
          busy={busy === quickEdit.noteId}
          onClose={() => setQuickEdit(null)}
          onSave={(patch) => void quickEditSave(patch)}
        />
      )}
    </div>
  )
}

function QuickEditModal({
  post,
  taxonomy,
  busy,
  onClose,
  onSave,
}: {
  post: BlogPostAdminItem
  taxonomy: { categories: TaxonomyItem[]; tags: TaxonomyItem[]; series: TaxonomyItem[] } | null
  busy: boolean
  onClose: () => void
  onSave: (patch: Record<string, unknown>) => void
}) {
  const [slug, setSlug] = useState(post.slug)
  const [excerpt, setExcerpt] = useState(post.excerpt)
  const category = (taxonomy?.categories ?? []).find((item) => item.name === post.category)
  const series = (taxonomy?.series ?? []).find((item) => item.name === post.series)
  const [categoryId, setCategoryId] = useState(category?.id ?? '')
  const [seriesId, setSeriesId] = useState(series?.id ?? '')
  const [pinned, setPinned] = useState(post.pinned)

  return (
    <Modal
      open
      onClose={onClose}
      title={t('blog.admin.quick_edit')}
      footer={(
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>{t('blog.admin.cancel')}</Button>
          <Button size="sm" loading={busy} onClick={() => onSave({ slug, excerpt, categoryId: categoryId || null, seriesId: seriesId || null, pinned })}>{t('blog.admin.save')}</Button>
        </div>
      )}
    >
      <div className="space-y-3">
        <Field label={t('blog.admin.slug')}><Input value={slug} onChange={(event) => setSlug(event.target.value)} /></Field>
        <Field label={t('blog.admin.excerpt')}><Textarea rows={3} value={excerpt} onChange={(event) => setExcerpt(event.target.value)} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('blog.admin.category')}>
            <Select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
              <option value="">{t('blog.admin.no_category')}</option>
              {(taxonomy?.categories ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </Select>
          </Field>
          <Field label={t('blog.admin.series')}>
            <Select value={seriesId} onChange={(event) => setSeriesId(event.target.value)}>
              <option value="">{t('blog.admin.no_series')}</option>
              {(taxonomy?.series ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </Select>
          </Field>
        </div>
        <Checkbox checked={pinned} onChange={setPinned} label={t('blog.admin.pinned')} />
      </div>
    </Modal>
  )
}

