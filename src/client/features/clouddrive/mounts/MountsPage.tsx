import { useEffect, useMemo, useState } from 'react'
import { HardDrive, LayoutGrid, List, Link2, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { Button, IconButton, Spinner } from '../../../components/primitives'
import { Checkbox, Field, Input, Select, Textarea } from '../../../components/form'
import { confirm, Modal } from '../../../components/overlay'
import { clouddriveApi } from '../api'
import { useCloudDriveStore } from '../store'
import { formatEntryDate } from '../files/format'
import {
  PAGE_SIZE_OPTIONS,
  STORAGE_TYPE_VALUES,
  pageCount,
  pageLabel,
  pageSlice,
  storageTypeLabel,
  WRITABLE_EXTERNAL_TYPES,
  type Mount,
  type Storage,
} from './shared'

interface MountForm {
  name: string
  storageId: string
  mountPath: string
  remark: string
  cacheTtl: string
  sortOrder: string
  enabled: boolean
  readOnly: boolean
  folderSummary: boolean
  webProxy: boolean
  webdavPolicy: string
  storageTypeFilter: string
}

function blankMount(storageId = 'primary'): MountForm {
  return {
    name: '', storageId, mountPath: '', remark: '', cacheTtl: '300', sortOrder: '0', enabled: true,
    readOnly: false, folderSummary: false, webProxy: false, webdavPolicy: 'native_proxy', storageTypeFilter: 'all',
  }
}

function formFromMount(mount: Mount, storages: readonly Storage[]): MountForm {
  const type = mount.storageId === 'primary' ? 'r2' : storages.find((storage) => storage.id === mount.storageId)?.type ?? 'all'
  const storage = storages.find((item) => item.id === mount.storageId)
  const urlProxy = typeof storage?.config.urlProxy === 'string' && storage.config.urlProxy ? storage.config.urlProxy : ''
  const policy = mount.webdavPolicy === '302_redirect' && type !== 's3'
    ? 'native_proxy'
    : mount.webdavPolicy === 'use_proxy_url' && !urlProxy
      ? 'native_proxy'
      : mount.webdavPolicy
  return {
    name: mount.name,
    storageId: mount.storageId,
    mountPath: mount.mountPath,
    remark: mount.remark,
    cacheTtl: String(mount.cacheTtl),
    sortOrder: String(mount.sortOrder),
    enabled: mount.enabled,
    readOnly: mount.readOnly,
    folderSummary: mount.folderSummary,
    webProxy: mount.webProxy,
    webdavPolicy: policy || 'native_proxy',
    storageTypeFilter: type,
  }
}

function mountStorageType(mount: Mount, storages: readonly Storage[]): string {
  if (mount.storageId === 'primary') return 'r2'
  return storages.find((storage) => storage.id === mount.storageId)?.type ?? 'unknown'
}

function mountStorageName(mount: Mount, storages: readonly Storage[]): string {
  if (mount.storageId === 'primary') return t('clouddrive.admin.mount.storage_primary')
  return storages.find((storage) => storage.id === mount.storageId)?.name ?? mount.storageId
}

function statusBadgeClass(enabled: boolean): string {
  return enabled ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]' : 'bg-[var(--bg-inset)] text-[var(--text-tertiary)]'
}

export function MountsPage() {
  const toast = useUi((state) => state.toast)
  const [storages, setStorages] = useState<Storage[]>([])
  const [mounts, setMounts] = useState<Mount[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(8)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Mount | null>(null)
  const [form, setForm] = useState<MountForm>(blankMount())

  const load = async () => {
    setLoading(true)
    try {
      const [storageResult, mountResult] = await Promise.all([clouddriveApi.storages(), clouddriveApi.mounts()])
      setStorages(storageResult.storages)
      setMounts(mountResult.mounts)
    } catch (error) {
      toast({ title: t('clouddrive.failed'), description: error instanceof Error ? error.message : '', tone: 'danger' })
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [])

  const refreshAll = async () => {
    await load()
    await useCloudDriveStore.getState().refresh()
  }

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return mounts
      .filter((mount) => {
        const type = mountStorageType(mount, storages)
        if (typeFilter !== 'all' && type !== typeFilter) return false
        if (statusFilter === 'enabled' && !mount.enabled) return false
        if (statusFilter === 'disabled' && mount.enabled) return false
        if (!needle) return true
        return `${mount.name} ${mount.mountPath} ${mount.remark} ${mountStorageName(mount, storages)}`.toLowerCase().includes(needle)
      })
      .sort((left, right) => left.sortOrder - right.sortOrder || left.createdAt - right.createdAt)
  }, [mounts, storages, query, typeFilter, statusFilter])
  const pages = pageCount(filtered.length, pageSize)
  const currentPage = Math.min(Math.max(1, page), pages)
  const visible = pageSlice(filtered, currentPage, pageSize)

  const openCreate = () => {
    const preferred = storages.find((storage) => storage.isDefault && storage.status === 'enabled') ?? storages.find((storage) => storage.status === 'enabled')
    setEditing(null)
    setForm({ ...blankMount(preferred?.id ?? 'primary'), storageTypeFilter: preferred?.type ?? 'r2' })
    setOpen(true)
  }
  const openEdit = (mount: Mount) => {
    setEditing(mount)
    setForm(formFromMount(mount, storages))
    setOpen(true)
  }
  const set = (patch: Partial<MountForm>) => setForm((current) => ({ ...current, ...patch }))

  const save = async () => {
    if (!form.name.trim() || !form.mountPath.trim()) {
      toast({ title: t('clouddrive.toast.failed'), description: t('clouddrive.mounts.path'), tone: 'danger' })
      return
    }
    setBusy(true)
    try {
      const selectedType = form.storageId === 'primary' ? 'primary' : storages.find((storage) => storage.id === form.storageId)?.type
      const readOnly = form.storageId === 'primary'
        ? false
        : !WRITABLE_EXTERNAL_TYPES.has(selectedType ?? '')
          ? true
          : form.readOnly
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        mountPath: form.mountPath.trim(),
        remark: form.remark.trim(),
        cacheTtl: Number(form.cacheTtl || 300),
        sortOrder: Number(form.sortOrder || 0),
        enabled: form.enabled,
        storageId: form.storageId,
        readOnly,
        folderSummary: form.folderSummary,
        webProxy: form.webProxy,
        webdavPolicy: form.webdavPolicy,
      }
      if (editing) await clouddriveApi.patchMount(editing.id, body)
      else await clouddriveApi.createMount(body)
      toast({ title: t('clouddrive.settings.saved') })
      setOpen(false)
      await refreshAll()
    } catch (error) {
      toast({ title: t('clouddrive.toast.failed'), description: error instanceof Error ? error.message : '', tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const test = async (mount: Mount) => {
    try {
      const result = await clouddriveApi.testMount(mount.id)
      toast({ title: result.ok ? t('clouddrive.mounts.test') : t('clouddrive.toast.failed'), description: result.message, tone: result.ok ? 'default' : 'danger' })
    } catch (error) {
      toast({ title: t('clouddrive.toast.failed'), description: error instanceof Error ? error.message : '', tone: 'danger' })
    }
  }

  const toggleEnabled = async (mount: Mount) => {
    try {
      await clouddriveApi.patchMount(mount.id, { enabled: !mount.enabled })
      await refreshAll()
    } catch (error) {
      toast({ title: t('clouddrive.toast.failed'), description: error instanceof Error ? error.message : '', tone: 'danger' })
    }
  }

  const remove = async (mount: Mount) => {
    if (!await confirm({ title: t('clouddrive.admin.mount.delete_title'), description: t('clouddrive.admin.mount.delete_body'), confirmLabel: t('clouddrive.mounts.delete'), tone: 'danger' })) return
    try {
      await clouddriveApi.deleteMount(mount.id)
      await refreshAll()
    } catch (error) {
      toast({ title: t('clouddrive.toast.failed'), description: error instanceof Error ? error.message : '', tone: 'danger' })
    }
  }

  const selectedType = form.storageId === 'primary'
    ? 'primary'
    : storages.find((storage) => storage.id === form.storageId)?.type ?? 'unknown'
  const selectedStorage = storages.find((storage) => storage.id === form.storageId)
  const urlProxyConfigured = typeof selectedStorage?.config.urlProxy === 'string' && selectedStorage.config.urlProxy.length > 0
  const typeFilteredStorages = form.storageTypeFilter === 'all'
    ? storages
    : form.storageTypeFilter === 'r2'
      ? []
      : storages.filter((storage) => storage.type === form.storageTypeFilter)
  const showPrimaryOption = form.storageTypeFilter === 'all' || form.storageTypeFilter === 'r2' || form.storageId === 'primary'

  const renderMount = (mount: Mount) => {
    const type = mountStorageType(mount, storages)
    const storage = storages.find((item) => item.id === mount.storageId)
    return (
      <article
        key={mount.id}
        className={`flex min-w-0 flex-col rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 ${mount.enabled ? '' : 'opacity-70'} ${view === 'list' ? 'sm:flex-row sm:items-center sm:gap-3' : ''}`}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {mount.id === 'primary' ? <HardDrive size={15} className="text-[var(--accent)]" /> : <Link2 size={15} className="text-[var(--text-secondary)]" />}
            <strong className="min-w-0 truncate text-[length:var(--text-12)]" title={mount.name}>{mount.name}</strong>
            {mount.id === 'primary' && <span className="rounded-full bg-[var(--accent-soft)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-primary)]">{t('clouddrive.admin.mount.primary_badge')}</span>}
            <span className={`rounded-full px-1.5 py-0.5 text-[length:var(--text-10)] ${statusBadgeClass(mount.enabled)}`}>{mount.enabled ? t('clouddrive.admin.enabled') : t('clouddrive.admin.disabled')}</span>
            {mount.readOnly && <span className="rounded-full bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{t('clouddrive.admin.mount.readonly_badge')}</span>}
            {!mount.readOnly && mount.storageId !== 'primary' && <span className="rounded-full bg-[var(--accent-soft)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-primary)]">{t('clouddrive.admin.mount.writable_badge')}</span>}
            {mount.webProxy && <span className="rounded-full bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{t('clouddrive.admin.mount.proxy_badge')}</span>}
            {mount.folderSummary && <span className="rounded-full bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{t('clouddrive.admin.mount.compute_badge')}</span>}
            {mount.webdavPolicy === '302_redirect' && <span className="rounded-full bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{t('clouddrive.admin.mount.policy_badge_redirect')}</span>}
            {mount.webdavPolicy === 'use_proxy_url' && <span className="rounded-full bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{t('clouddrive.admin.mount.policy_badge_proxy')}</span>}
            {storage?.status === 'disabled' && <span className="rounded-full bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--danger)]">{t('clouddrive.admin.mount.storage_disabled')}</span>}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            <code className="truncate text-[var(--text-secondary)]">{mount.mountPath}</code>
            <span>·</span>
            <span className="truncate">{mountStorageName(mount, storages)}</span>
            {type !== 'r2' && <><span>·</span><span>{storageTypeLabel(type)}</span></>}
          </div>
          {mount.remark && <p className="line-clamp-2 text-[length:var(--text-11)] text-[var(--text-secondary)]">{mount.remark}</p>}
          <p className="text-[length:var(--text-10)] text-[var(--text-quaternary)]">
            {t('clouddrive.admin.created')} {formatEntryDate(mount.createdAt)} · {t('clouddrive.mounts.sort_order')} {mount.sortOrder} · {t('clouddrive.mounts.cache_ttl')} {mount.cacheTtl}
          </p>
        </div>
        <div className={`mt-2 flex flex-wrap gap-1 ${view === 'list' ? 'sm:mt-0 sm:shrink-0 sm:justify-end' : ''}`}>
          <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => openEdit(mount)}>{t('clouddrive.admin.edit')}</Button>
          <Button size="sm" variant="ghost" onClick={() => void toggleEnabled(mount)}>{mount.enabled ? t('clouddrive.admin.disable') : t('clouddrive.admin.enable')}</Button>
          <Button size="sm" variant="ghost" onClick={() => void test(mount)}>{t('clouddrive.mounts.test')}</Button>
          {mount.id !== 'primary' && <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => void remove(mount)}>{t('clouddrive.mounts.delete')}</Button>}
        </div>
      </article>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto p-4">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">{t('clouddrive.mounts.title')}</h1>
        <span className="rounded-full bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{mounts.length}</span>
        <div className="ml-auto flex gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw size={13} /> {t('clouddrive.toolbar.refresh')}</Button>
          <Button size="sm" variant="primary" onClick={openCreate}><Plus size={13} /> {t('clouddrive.mounts.add')}</Button>
        </div>
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="relative min-w-[200px] max-w-[380px] flex-1">
          <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" aria-hidden />
          <Input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1) }} placeholder={t('clouddrive.admin.search_mount')} aria-label={t('clouddrive.admin.search_mount')} className="h-8 pl-7" />
        </label>
        <Select value={typeFilter} onChange={(event) => { setTypeFilter(event.target.value); setPage(1) }} aria-label={t('clouddrive.admin.mount.storage_type')} className="w-40">
          <option value="all">{t('clouddrive.admin.filter_all')}</option>
          <option value="r2">{t('clouddrive.admin.storage.primary_title')}</option>
          {STORAGE_TYPE_VALUES.map((type) => <option key={type} value={type}>{storageTypeLabel(type)}</option>)}
        </Select>
        <Select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(1) }} aria-label={t('clouddrive.admin.status')} className="w-32">
          <option value="all">{t('clouddrive.admin.filter_all')}</option>
          <option value="enabled">{t('clouddrive.admin.enabled')}</option>
          <option value="disabled">{t('clouddrive.admin.disabled')}</option>
        </Select>
        <div className="ml-auto flex items-center gap-1" role="group" aria-label={t('clouddrive.toolbar.view')}>
          <IconButton label={t('clouddrive.admin.view_grid')} active={view === 'grid'} onClick={() => setView('grid')}><LayoutGrid size={14} /></IconButton>
          <IconButton label={t('clouddrive.admin.view_list')} active={view === 'list'} onClick={() => setView('list')}><List size={14} /></IconButton>
        </div>
      </div>

      {loading ? <div className="flex h-32 items-center justify-center"><Spinner /></div> : (
        <>
          <section className={view === 'grid' ? 'grid gap-2 sm:grid-cols-2 xl:grid-cols-3' : 'flex flex-col gap-2'} aria-label={t('clouddrive.mounts.title')}>
            {visible.map(renderMount)}
          </section>
          {filtered.length === 0 && (
            <p className="py-10 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {mounts.length <= 1 ? t('clouddrive.admin.mount.empty') : t('clouddrive.admin.no_results')}
            </p>
          )}
          <footer className="mt-3 flex flex-wrap items-center gap-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            <span>{pageLabel(filtered.length ? (currentPage - 1) * pageSize + 1 : 0, Math.min(currentPage * pageSize, filtered.length), filtered.length)}</span>
            <label className="flex items-center gap-1.5">
              {t('clouddrive.admin.page_size')}
              <Select value={String(pageSize)} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1) }} aria-label={t('clouddrive.admin.page_size')} className="h-7 w-16">
                {PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}
              </Select>
            </label>
            <div className="ml-auto flex items-center gap-1">
              <Button size="sm" variant="ghost" disabled={currentPage <= 1} aria-label={t('clouddrive.admin.page_prev')} onClick={() => setPage(currentPage - 1)}>‹</Button>
              <span className="tabular">{currentPage} / {pages}</span>
              <Button size="sm" variant="ghost" disabled={currentPage >= pages} aria-label={t('clouddrive.admin.page_next')} onClick={() => setPage(currentPage + 1)}>›</Button>
            </div>
          </footer>
        </>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? t('clouddrive.admin.mount.edit_title') : t('clouddrive.admin.mount.add_title')}
        width={560}
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>{t('clouddrive.dialog.cancel')}</Button><Button variant="primary" loading={busy} onClick={() => void save()}>{t('clouddrive.dialog.save')}</Button></>}
      >
        <div className="grid gap-2">
          <Field label={t('clouddrive.mounts.name')} required><Input value={form.name} onChange={(event) => set({ name: event.target.value })} /></Field>
          <Field label={t('clouddrive.admin.mount.storage_type')}>
            <Select
              value={form.storageTypeFilter}
              onChange={(event) => {
                const filter = event.target.value
                const candidates = filter === 'all'
                  ? storages
                  : filter === 'r2'
                    ? []
                    : storages.filter((storage) => storage.type === filter)
                const storageId = filter === 'r2' ? 'primary' : candidates.find((storage) => storage.status === 'enabled')?.id ?? candidates[0]?.id ?? 'primary'
                set({ storageTypeFilter: filter, storageId, readOnly: false, webdavPolicy: 'native_proxy' })
              }}
            >
              <option value="all">{t('clouddrive.admin.filter_all')}</option>
              <option value="r2">{t('clouddrive.admin.storage.primary_title')}</option>
              {STORAGE_TYPE_VALUES.map((type) => <option key={type} value={type}>{storageTypeLabel(type)}</option>)}
            </Select>
          </Field>
          <Field label={t('clouddrive.mounts.storage')} required>
            <Select
              value={form.storageId}
              disabled={editing?.id === 'primary'}
              onChange={(event) => {
                const storageId = event.target.value
                const storage = storages.find((item) => item.id === storageId)
                const type = storageId === 'primary' ? 'primary' : storage?.type
                const urlProxy = typeof storage?.config.urlProxy === 'string' && storage.config.urlProxy.length > 0
                const policy = form.webdavPolicy === '302_redirect' && type !== 's3'
                  ? 'native_proxy'
                  : form.webdavPolicy === 'use_proxy_url' && !urlProxy
                    ? 'native_proxy'
                    : form.webdavPolicy
                set({ storageId, readOnly: type === 'primary' ? false : !WRITABLE_EXTERNAL_TYPES.has(type ?? '') ? true : form.readOnly, webdavPolicy: policy })
              }}
            >
              {showPrimaryOption && <option value="primary">{t('clouddrive.admin.mount.storage_primary')}</option>}
              {typeFilteredStorages.map((storage) => (
                <option key={storage.id} value={storage.id} disabled={storage.status !== 'enabled' && editing?.storageId !== storage.id}>
                  {storage.name} ({storageTypeLabel(storage.type)}){storage.status === 'disabled' ? ` · ${t('clouddrive.admin.disabled')}` : ''}
                </option>
              ))}
              {form.storageId !== 'primary' && !typeFilteredStorages.some((storage) => storage.id === form.storageId) && (
                <option value={form.storageId}>{storages.find((storage) => storage.id === form.storageId)?.name ?? form.storageId}</option>
              )}
            </Select>
          </Field>
          {storages.length === 0 && <p className="-mt-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('clouddrive.admin.mount.storage_required')}</p>}
          <Field label={t('clouddrive.mounts.path')} required>
            <Input value={form.mountPath} disabled={editing?.id === 'primary'} onChange={(event) => set({ mountPath: event.target.value })} placeholder={t('clouddrive.mounts.path_placeholder')} />
          </Field>
          {editing?.id === 'primary' && <p className="-mt-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('clouddrive.admin.mount.path_locked')}</p>}
          {selectedType !== 'primary' && (
            <div className="space-y-1">
              <Checkbox
                checked={form.readOnly || !WRITABLE_EXTERNAL_TYPES.has(selectedType)}
                disabled={!WRITABLE_EXTERNAL_TYPES.has(selectedType)}
                label={t('clouddrive.admin.mount.readonly')}
                onChange={(next) => set({ readOnly: next })}
              />
              <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{WRITABLE_EXTERNAL_TYPES.has(selectedType) ? t('clouddrive.admin.mount.readonly_hint') : t('clouddrive.admin.mount.readonly_note')}</p>
            </div>
          )}
          <Field label={t('clouddrive.admin.mount.remark')}>
            <Textarea value={form.remark} onChange={(event) => set({ remark: event.target.value })} placeholder={t('clouddrive.admin.mount.remark_placeholder')} rows={2} />
          </Field>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label={t('clouddrive.mounts.cache_ttl')} hint={t('clouddrive.admin.mount.cache_hint')}>
              <Input type="number" value={form.cacheTtl} onChange={(event) => set({ cacheTtl: event.target.value })} />
            </Field>
            <Field label={t('clouddrive.mounts.sort_order')} hint={t('clouddrive.admin.mount.sort_hint')}>
              <Input type="number" value={form.sortOrder} onChange={(event) => set({ sortOrder: event.target.value })} />
            </Field>
          </div>
          <p className="pt-1 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('clouddrive.admin.mount.advanced')}</p>
          <div className="space-y-1">
            <Checkbox checked={form.folderSummary} label={t('clouddrive.admin.mount.folder_summary')} onChange={(next) => set({ folderSummary: next })} />
            <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('clouddrive.admin.mount.folder_summary_hint')}</p>
          </div>
          <p className="pt-1 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('clouddrive.admin.mount.proxy_section')}</p>
          <div className="space-y-1">
            <Checkbox checked={form.webProxy} label={t('clouddrive.admin.mount.web_proxy')} onChange={(next) => set({ webProxy: next })} />
            <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('clouddrive.admin.mount.web_proxy_hint')}</p>
          </div>
          <Field label={t('clouddrive.admin.mount.webdav_policy')} hint={t('clouddrive.admin.mount.webdav_policy_hint')}>
            <Select value={form.webdavPolicy} onChange={(event) => set({ webdavPolicy: event.target.value })}>
              <option value="native_proxy">{t('clouddrive.admin.mount.policy_native')}</option>
              {selectedType === 's3' && <option value="302_redirect">{t('clouddrive.admin.mount.policy_redirect')}</option>}
              {urlProxyConfigured && <option value="use_proxy_url">{t('clouddrive.admin.mount.policy_proxy_url')}</option>}
            </Select>
          </Field>
          <Checkbox checked={form.enabled} label={t('clouddrive.admin.mount.enabled')} onChange={(next) => set({ enabled: next })} />
          <p className="-mt-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('clouddrive.admin.mount.enabled_hint')}</p>
        </div>
      </Modal>
    </div>
  )
}


