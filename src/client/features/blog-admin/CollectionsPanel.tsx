import { useState } from 'react'
import { ExternalLink, Plus, Trash2 } from 'lucide-react'
import type { MessageKey } from '@shared/locales/en-US'
import {
  BLOG_COLLECTION_KINDS,
  type BlogCollectionItem,
  type BlogCollectionKind,
} from '@shared/blog/model'
import type { BlogSettings } from '@shared/blog/settings'
import { Badge, Button, IconButton } from '../../components/primitives'
import { Field, Input } from '../../components/form'
import { Modal, confirm } from '../../components/overlay'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import { useUi } from '../../store/ui'
import { AlbumPhotosDrawer, CollectionForm } from './CollectionForm'
import {
  AdminCard,
  AdminEmpty,
  AdminError,
  AdminLoading,
  PageHeader,
  SearchField,
  TabBar,
  formatDate,
  useAdminResource,
  useDebounced,
} from './shared'

const KIND_LABEL: Record<BlogCollectionKind, MessageKey> = {
  moments: 'blog.admin.moments',
  albums: 'blog.admin.albums',
  friends: 'blog.admin.friends',
  projects: 'blog.admin.projects',
  skills: 'blog.admin.skills',
  devices: 'blog.admin.devices',
  games: 'blog.admin.games',
  anime: 'blog.admin.anime',
  timeline: 'blog.admin.timeline',
  compass: 'blog.admin.compass',
}

function pathFor(kind: BlogCollectionKind): string {
  if (kind === 'moments') return '/blog-admin/moments'
  if (kind === 'albums') return '/blog-admin/albums'
  return `/blog-admin/collections/${kind}`
}

function asKind(value: string): BlogCollectionKind {
  return (BLOG_COLLECTION_KINDS as readonly string[]).includes(value) ? value as BlogCollectionKind : 'friends'
}

function summary(item: BlogCollectionItem): string {
  const data = item.data
  for (const key of ['summary', 'description', 'content', 'blurb', 'subtitle', 'note']) {
    const value = data[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  if (item.kind === 'friends') return String(data.url ?? '')
  if (item.kind === 'albums') return `${data.photoCount ?? 0}`
  return ''
}

export function CollectionsPanel({ kind: rawKind }: { kind: string }) {
  const kind = asKind(rawKind)
  const toast = useUi((state) => state.toast)
  const items = useAdminResource(() => api.blog.collections.list(kind), [kind])
  const settings = useAdminResource(() => api.blog.settings.get(), [])
  const [query, setQuery] = useState('')
  const debounced = useDebounced(query, 250)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<BlogCollectionItem | null>(null)
  const [saving, setSaving] = useState(false)
  const [photoAlbum, setPhotoAlbum] = useState<BlogCollectionItem | null>(null)
  const [compassShelf, setCompassShelf] = useState<BlogCollectionItem | null>(null)

  const siteUrl = typeof (settings.data as BlogSettings | null)?.site?.url === 'string'
    ? String((settings.data as BlogSettings).site.url).replace(/\/+$/, '')
    : ''
  const list = (items.data?.items ?? []).filter((item) => {
    if (!debounced.trim()) return true
    return `${item.title} ${item.slug} ${summary(item)}`.toLowerCase().includes(debounced.trim().toLowerCase())
  })

  const openAdd = () => {
    setEditing(null)
    setFormOpen(true)
  }

  const openEdit = (item: BlogCollectionItem) => {
    setEditing(item)
    setFormOpen(true)
  }

  const save = async (input: Record<string, unknown>) => {
    setSaving(true)
    try {
      if (editing) await api.blog.collections.update(kind, editing.id, input)
      else await api.blog.collections.create(kind, input)
      setFormOpen(false)
      setEditing(null)
      await items.reload()
      toast({ title: t('blog.admin.saved'), tone: 'success' })
    } catch (error) {
      toast({ title: t('blog.admin.save_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    } finally {
      setSaving(false)
    }
  }

  const remove = async (item: BlogCollectionItem) => {
    const ok = await confirm({
      title: t('blog.admin.collection_delete_title', { title: item.title }),
      description: t('blog.admin.collection_delete_desc'),
      confirmLabel: t('blog.admin.delete_forever'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await api.blog.collections.remove(kind, item.id)
      await items.reload()
    } catch (error) {
      toast({ title: t('blog.admin.delete_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    }
  }

  const togglePublished = async (item: BlogCollectionItem) => {
    try {
      if (kind === 'albums') {
        await api.blog.collections.update(kind, item.id, { published_at: item.publishedAt ? null : Date.now() })
      } else if (kind === 'moments') {
        await api.blog.collections.update(kind, item.id, { draft: item.status === 'published' })
      } else if (kind === 'friends') {
        await api.blog.collections.update(kind, item.id, { enabled: item.status !== 'published' })
      }
      await items.reload()
    } catch (error) {
      toast({ title: t('blog.admin.save_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    }
  }

  const liveUrl = (item: BlogCollectionItem): string => {
    if (!siteUrl) return ''
    if (kind === 'moments') return `${siteUrl}/moments`
    if (kind === 'albums') return `${siteUrl}/albums/${item.slug}`
    if (kind === 'friends') return `${siteUrl}/friends`
    if (kind === 'projects') return `${siteUrl}/projects`
    if (kind === 'skills') return `${siteUrl}/skills`
    if (kind === 'devices') return `${siteUrl}/devices`
    if (kind === 'games') return `${siteUrl}/games`
    if (kind === 'anime') return `${siteUrl}/anime`
    if (kind === 'timeline') return `${siteUrl}/timeline`
    if (kind === 'compass') return `${siteUrl}/compass`
    return ''
  }

  const tabs = BLOG_COLLECTION_KINDS
    .filter((id) => id !== 'friends')
    .map((id) => ({ id, label: t(KIND_LABEL[id]) }))

  return (
    <div className="mx-auto max-w-[1140px]">
      <PageHeader
        title={t(KIND_LABEL[kind])}
        description={t('blog.admin.collections_subtitle')}
        actions={<Button size="sm" icon={<Plus size={13} />} onClick={openAdd}>{t('blog.admin.collection_add', { kind: t(KIND_LABEL[kind]) })}</Button>}
      />
      <TabBar tabs={tabs} value={kind} onChange={(next) => navigateToPath(pathFor(next))} label={t('blog.admin.collections')} />
      <div className="my-3 flex items-center gap-2">
        <SearchField value={query} onChange={setQuery} placeholder={t('blog.admin.collection_search')} className="max-w-sm" />
      </div>

      {items.error ? (
        <AdminError message={items.error} onRetry={() => void items.reload()} />
      ) : !items.data ? (
        <AdminLoading />
      ) : list.length === 0 ? (
        <AdminEmpty>{t('blog.admin.collection_empty', { kind: t(KIND_LABEL[kind]) })}</AdminEmpty>
      ) : (
        <AdminCard className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] border-collapse text-left text-[length:var(--text-12-5)]">
              <caption className="sr-only">{t(KIND_LABEL[kind])}</caption>
              <thead>
                <tr className="border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                  <th scope="col" className="px-3 py-2 font-medium">{t('blog.admin.column_title')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('blog.admin.field_description')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('blog.admin.column_status')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('blog.admin.column_date')}</th>
                  <th scope="col" className="w-32 px-2 py-2"><span className="sr-only">{t('blog.admin.column_actions')}</span></th>
                </tr>
              </thead>
              <tbody>
                {list.map((item) => (
                  <tr key={item.id} className="border-b border-[var(--border-subtle)] last:border-b-0 hover:bg-[var(--bg-hover)]">
                    <td className="max-w-[260px] px-3 py-2.5">
                      <button type="button" onClick={() => kind === 'compass' ? setCompassShelf(item) : openEdit(item)} className="block max-w-full truncate text-left font-medium text-[var(--text-primary)] hover:text-[var(--accent)]">
                        {item.title || t('blog.admin.untitled_item')}
                      </button>
                      {item.slug && <p className="truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">/{item.slug}</p>}
                    </td>
                    <td className="max-w-[360px] px-2 py-2.5 text-[var(--text-tertiary)]"><span className="line-clamp-2">{summary(item)}</span></td>
                    <td className="px-2 py-2.5">
                      {kind === 'albums' || kind === 'moments' || kind === 'friends' ? (
                        <button type="button" onClick={() => void togglePublished(item)} aria-label={t('blog.admin.toggle_status')}>
                          <Badge tone={item.status === 'published' ? 'success' : item.status === 'draft' ? 'warning' : 'neutral'}>
                            {item.status === 'published' ? t('blog.admin.status_published') : item.status === 'draft' ? t('blog.admin.status_draft') : t('blog.admin.status_active')}
                          </Badge>
                        </button>
                      ) : (
                        <Badge tone="neutral">{t('blog.admin.status_active')}</Badge>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2.5 text-[var(--text-tertiary)]">{formatDate(item.publishedAt ?? item.updatedAt)}</td>
                    <td className="px-2 py-2.5">
                      <div className="flex justify-end gap-0.5">
                        {kind === 'albums' && <Button size="sm" variant="ghost" onClick={() => setPhotoAlbum(item)}>{t('blog.admin.album_photos_short', { count: Number(item.data.photoCount ?? 0) })}</Button>}
                        {kind === 'compass' && <Button size="sm" variant="ghost" onClick={() => setCompassShelf(item)}>{t('blog.admin.compass_entries')}</Button>}
                        <Button size="sm" variant="ghost" onClick={() => openEdit(item)}>{t('blog.admin.edit')}</Button>
                        {liveUrl(item) && item.status === 'published' && (
                          <a href={liveUrl(item)} target="_blank" rel="noopener noreferrer" aria-label={t('blog.admin.view_live')} className="inline-flex size-6 items-center justify-center rounded-[var(--r-md)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
                            <ExternalLink size={13} />
                          </a>
                        )}
                        <IconButton label={t('blog.admin.delete_forever')} size="sm" onClick={() => void remove(item)}><Trash2 size={13} /></IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminCard>
      )}

      {formOpen && (
        <CollectionForm
          kind={kind}
          item={editing}
          busy={saving}
          onClose={() => { setFormOpen(false); setEditing(null) }}
          onSave={(input) => void save(input)}
        />
      )}
      {photoAlbum && <AlbumPhotosDrawer album={photoAlbum} open onClose={() => setPhotoAlbum(null)} />}
      {compassShelf && <CompassEntriesModal shelf={compassShelf} onClose={() => setCompassShelf(null)} />}
    </div>
  )
}

interface CompassEntry {
  id: string
  label: string
  href: string
  note: string
  icon: string
  image: string
}

function CompassEntriesModal({ shelf, onClose }: { shelf: BlogCollectionItem; onClose: () => void }) {
  const toast = useUi((state) => state.toast)
  const entries = useAdminResource(() => api.blog.collections.compassEntries(shelf.id), [shelf.id])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [href, setHref] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const items = (entries.data?.items ?? []) as unknown as CompassEntry[]

  const reset = () => {
    setEditingId(null)
    setLabel('')
    setHref('')
    setNote('')
  }

  const save = async () => {
    if (!label.trim() || !href.trim()) return
    setBusy(true)
    try {
      await api.blog.collections.saveCompassEntry(shelf.id, { label, href, note }, editingId ?? undefined)
      reset()
      await entries.reload()
    } catch (error) {
      toast({ title: t('blog.admin.save_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (entry: CompassEntry) => {
    try {
      await api.blog.collections.removeCompassEntry(shelf.id, entry.id)
      await entries.reload()
    } catch (error) {
      toast({ title: t('blog.admin.delete_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    }
  }

  return (
    <Modal open onClose={onClose} title={t('blog.admin.compass_entries_for', { title: shelf.title })} width={640}>
      <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label={t('blog.admin.field_name')}><Input value={label} onChange={(event) => setLabel(event.target.value)} /></Field>
          <Field label={t('blog.admin.field_url')}><Input value={href} onChange={(event) => setHref(event.target.value)} placeholder={t('blog.admin.path_placeholder')} /></Field>
          <Field label={t('blog.admin.field_note')} className="sm:col-span-2"><Input value={note} onChange={(event) => setNote(event.target.value)} /></Field>
        </div>
        <div className="flex justify-end gap-2">
          {editingId && <Button size="sm" variant="ghost" onClick={reset}>{t('blog.admin.cancel')}</Button>}
          <Button size="sm" loading={busy} disabled={!label.trim() || !href.trim()} onClick={() => void save()}>{editingId ? t('blog.admin.save') : t('blog.admin.compass_add_entry')}</Button>
        </div>
        {entries.error ? <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{entries.error}</p> : entries.loading ? <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('blog.admin.loading')}</p> : items.length === 0 ? (
          <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('blog.admin.compass_empty')}</p>
        ) : (
          <ul className="max-h-64 divide-y divide-[var(--border-subtle)] overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-subtle)]">
            {items.map((entry) => (
              <li key={entry.id} className="flex items-center gap-2 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[length:var(--text-12)] text-[var(--text-primary)]">{entry.label}</span>
                  <span className="block truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{entry.href}{entry.note ? ` · ${entry.note}` : ''}</span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => { setEditingId(entry.id); setLabel(entry.label); setHref(entry.href); setNote(entry.note) }}>{t('blog.admin.edit')}</Button>
                <IconButton label={t('blog.admin.delete_forever')} size="sm" onClick={() => void remove(entry)}><Trash2 size={12} /></IconButton>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
