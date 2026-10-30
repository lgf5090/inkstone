import { useEffect, useMemo, useState } from 'react'
import { Database, HardDrive, Pencil, Plus, RefreshCw, Search, Star, Trash2 } from 'lucide-react'
import { formatBytes } from '../../../lib/time'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { Button, Spinner } from '../../../components/primitives'
import { Checkbox, Field, Input, Select } from '../../../components/form'
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
  storageEndpoint,
  storageProviderLabel,
  storageTypeLabel,
  type Storage,
  type StorageType,
} from './shared'

interface StorageForm {
  name: string
  type: StorageType
  status: 'enabled' | 'disabled'
  isDefault: boolean
  provider: string
  endpoint: string
  bucketName: string
  region: string
  pathStyle: boolean
  rootPath: string
  customHost: string
  baseUrl: string
  repo: string
  branch: string
  repoType: 'model' | 'dataset'
  revision: string
  channelId: string
  chatId: string
  driveId: string
  folderId: string
  accessKeyId: string
  secretAccessKey: string
  username: string
  password: string
  token: string
  refreshToken: string
  clientId: string
  clientSecret: string
  botToken: string
  capacityValue: string
  capacityUnit: CapacityUnit
  defaultPath: string
  urlProxy: string
  readQuota: boolean
  apiKeyVisible: boolean
}

type CapacityUnit = 'B' | 'KB' | 'MB' | 'GB' | 'TB'

const CAPACITY_UNITS: readonly { value: CapacityUnit; factor: number }[] = [
  { value: 'B', factor: 1 },
  { value: 'KB', factor: 1024 },
  { value: 'MB', factor: 1024 ** 2 },
  { value: 'GB', factor: 1024 ** 3 },
  { value: 'TB', factor: 1024 ** 4 },
]

function splitCapacity(bytes: number | undefined): { value: string; unit: CapacityUnit } {
  if (!bytes || bytes <= 0) return { value: '', unit: 'GB' }
  let factor = 1024 ** 4
  let unit: CapacityUnit = 'TB'
  for (const candidate of CAPACITY_UNITS) {
    if (bytes >= candidate.factor) factor = candidate.factor
    else break
    unit = candidate.value
  }
  return { value: String(Math.round((bytes / factor) * 100) / 100), unit }
}

function parseCapacity(value: string, unit: CapacityUnit): number | null {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return null
  const factor = CAPACITY_UNITS.find((candidate) => candidate.value === unit)?.factor ?? 1
  return Math.floor(number * factor)
}

function blankForm(type: StorageType = 's3'): StorageForm {
  return {
    name: '', type, status: 'enabled', isDefault: false, provider: 'r2',
    endpoint: '', bucketName: '', region: 'auto', pathStyle: true, rootPath: '', customHost: '',
    baseUrl: '', repo: '', branch: '', repoType: 'model', revision: 'main',
    channelId: '', chatId: '', driveId: '', folderId: '',
    accessKeyId: '', secretAccessKey: '', username: '', password: '', token: '',
    refreshToken: '', clientId: '', clientSecret: '', botToken: '',
    capacityValue: '', capacityUnit: 'GB', defaultPath: '', urlProxy: '', readQuota: false, apiKeyVisible: false,
  }
}

function formFromStorage(storage: Storage): StorageForm {
  const config = storage.config
  const text = (key: string) => typeof config[key] === 'string' ? String(config[key]) : ''
  const form = blankForm(storage.type as StorageType)
  const capacity = splitCapacity(typeof config.capacityBytes === 'number' ? config.capacityBytes : undefined)
  return {
    ...form,
    name: storage.name,
    status: storage.status === 'disabled' ? 'disabled' : 'enabled',
    isDefault: storage.isDefault,
    provider: text('provider') || 'other',
    endpoint: text('endpoint'),
    bucketName: text('bucketName'),
    region: text('region') || 'auto',
    pathStyle: config.pathStyle !== false,
    rootPath: text('rootPath'),
    customHost: text('customHost'),
    baseUrl: text('baseUrl'),
    repo: text('repo'),
    branch: text('branch'),
    repoType: config.repoType === 'dataset' ? 'dataset' : 'model',
    revision: text('revision') || 'main',
    channelId: text('channelId'),
    chatId: text('chatId'),
    driveId: text('driveId'),
    folderId: text('folderId'),
    capacityValue: capacity.value,
    capacityUnit: capacity.unit,
    defaultPath: storage.defaultPath && storage.defaultPath !== '/' ? storage.defaultPath : '',
    urlProxy: text('urlProxy'),
    readQuota: storage.readQuota,
    apiKeyVisible: storage.apiKeyVisible,
  }
}

function storagePayload(form: StorageForm): {
  config: Record<string, unknown>
  credentials: Record<string, string>
  defaultPath: string
  readQuota: boolean
  apiKeyVisible: boolean
} {
  const config: Record<string, unknown> = {}
  const credentials: Record<string, string> = {}
  const capacity = parseCapacity(form.capacityValue, form.capacityUnit)
  if (capacity !== null) config.capacityBytes = capacity
  if (form.urlProxy.trim()) config.urlProxy = form.urlProxy.trim()
  if (form.type === 's3') {
    Object.assign(config, {
      provider: form.provider, endpoint: form.endpoint.trim(), bucketName: form.bucketName.trim(),
      region: form.region.trim() || 'auto', pathStyle: form.pathStyle, rootPath: form.rootPath.trim(),
      ...(form.customHost.trim() ? { customHost: form.customHost.trim() } : {}),
    })
    if (form.accessKeyId) credentials.accessKeyId = form.accessKeyId
    if (form.secretAccessKey) credentials.secretAccessKey = form.secretAccessKey
  } else if (form.type === 'webdav') {
    Object.assign(config, { baseUrl: form.baseUrl.trim(), rootPath: form.rootPath.trim() })
    if (form.username) credentials.username = form.username
    if (form.password) credentials.password = form.password
  } else if (form.type === 'github') {
    Object.assign(config, { repo: form.repo.trim(), branch: form.branch.trim(), rootPath: form.rootPath.trim() })
    if (form.token) credentials.token = form.token
  } else if (form.type === 'huggingface') {
    Object.assign(config, { repo: form.repo.trim(), repoType: form.repoType, revision: form.revision.trim() || 'main', rootPath: form.rootPath.trim() })
    if (form.token) credentials.token = form.token
  } else if (form.type === 'discord') {
    Object.assign(config, { channelId: form.channelId.trim() })
    if (form.botToken) credentials.botToken = form.botToken
  } else if (form.type === 'telegram') {
    Object.assign(config, { chatId: form.chatId.trim() })
    if (form.botToken) credentials.botToken = form.botToken
  } else if (form.type === 'onedrive') {
    Object.assign(config, { driveId: form.driveId.trim(), rootPath: form.rootPath.trim() })
    if (form.token) credentials.accessToken = form.token
    if (form.refreshToken) credentials.refreshToken = form.refreshToken
    if (form.clientId) credentials.clientId = form.clientId
    if (form.clientSecret) credentials.clientSecret = form.clientSecret
  } else {
    Object.assign(config, { folderId: form.folderId.trim() || 'root', rootPath: form.rootPath.trim() })
    if (form.token) credentials.accessToken = form.token
    if (form.refreshToken) credentials.refreshToken = form.refreshToken
    if (form.clientId) credentials.clientId = form.clientId
    if (form.clientSecret) credentials.clientSecret = form.clientSecret
  }
  return {
    config, credentials,
    defaultPath: form.defaultPath.trim(), readQuota: form.readQuota, apiKeyVisible: form.apiKeyVisible,
  }
}

function storageDetails(storage: Storage): { label: string; value: string }[] {
  const config = storage.config
  const text = (key: string) => typeof config[key] === 'string' ? String(config[key]) : ''
  const rows: { label: string; value: string }[] = []
  if (storage.type === 's3') {
    rows.push({ label: t('clouddrive.storage.endpoint'), value: text('endpoint') })
    rows.push({ label: t('clouddrive.storage.bucket'), value: text('bucketName') })
    rows.push({ label: t('clouddrive.storage.region'), value: text('region') || 'auto' })
    rows.push({ label: t('clouddrive.admin.storage.path_style'), value: t(config.pathStyle === false ? 'clouddrive.admin.storage.path_style_virtual' : 'clouddrive.admin.storage.path_style_path') })
  } else if (storage.type === 'webdav') {
    rows.push({ label: t('clouddrive.storage.base_url'), value: text('baseUrl') })
    rows.push({ label: t('clouddrive.storage.root_path'), value: text('rootPath') || '/' })
  } else if (storage.type === 'github' || storage.type === 'huggingface') {
    rows.push({ label: t('clouddrive.storage.repo'), value: text('repo') })
    rows.push({
      label: storage.type === 'github' ? t('clouddrive.storage.branch') : t('clouddrive.storage.revision'),
      value: (storage.type === 'github' ? text('branch') : text('revision')) || 'main',
    })
  } else if (storage.type === 'discord') {
    rows.push({ label: t('clouddrive.storage.channel_id'), value: text('channelId') })
  } else if (storage.type === 'telegram') {
    rows.push({ label: t('clouddrive.storage.chat_id'), value: text('chatId') })
  } else if (storage.type === 'onedrive') {
    rows.push({ label: t('clouddrive.storage.drive_id'), value: text('driveId') || '—' })
  } else {
    rows.push({ label: t('clouddrive.storage.folder_id'), value: text('folderId') || 'root' })
  }
  const capacity = typeof config.capacityBytes === 'number' && config.capacityBytes > 0 ? config.capacityBytes : null
  rows.push({
    label: t('clouddrive.admin.storage.capacity'),
    value: capacity
      ? t('clouddrive.admin.storage.used_of', { used: formatBytes(storage.usedBytes), total: formatBytes(capacity) })
      : t('clouddrive.admin.storage.used', { used: formatBytes(storage.usedBytes) }),
  })
  if (storage.defaultPath && storage.defaultPath !== '/') {
    rows.push({ label: t('clouddrive.admin.storage.default_path'), value: storage.defaultPath })
  }
  if (text('urlProxy')) rows.push({ label: t('clouddrive.admin.storage.url_proxy'), value: text('urlProxy') })
  if (storage.readQuota) rows.push({ label: t('clouddrive.admin.storage.read_quota'), value: t('clouddrive.admin.enabled') })
  if (storage.apiKeyVisible) rows.push({ label: t('clouddrive.admin.storage.api_key_visible'), value: t('clouddrive.admin.enabled') })
  rows.push({
    label: t('clouddrive.admin.last_test'),
    value: storage.lastTestStatus
      ? `${t(storage.lastTestStatus === 'ok' ? 'clouddrive.admin.test_ok' : 'clouddrive.admin.test_failed')} · ${formatEntryDate(storage.lastTestAt)}`
      : t('clouddrive.admin.never'),
  })
  rows.push({ label: t('clouddrive.admin.created'), value: formatEntryDate(storage.createdAt) })
  return rows
}

export function StoragePage() {
  const toast = useUi((state) => state.toast)
  const usage = useCloudDriveStore((state) => state.bootstrap?.usage)
  const [storages, setStorages] = useState<Storage[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(8)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Storage | null>(null)
  const [form, setForm] = useState<StorageForm>(blankForm())

  const load = async () => {
    setLoading(true)
    try {
      const result = await clouddriveApi.storages()
      setStorages(result.storages)
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
    return storages.filter((storage) => {
      if (typeFilter !== 'all' && storage.type !== typeFilter) return false
      if (!needle) return true
      return `${storage.name} ${storageEndpoint(storage)} ${JSON.stringify(storage.config)}`.toLowerCase().includes(needle)
    })
  }, [storages, query, typeFilter])
  const pages = pageCount(filtered.length, pageSize)
  const currentPage = Math.min(Math.max(1, page), pages)
  const visible = pageSlice(filtered, currentPage, pageSize)

  const openCreate = () => {
    setEditing(null)
    setForm(blankForm())
    setOpen(true)
  }
  const openEdit = (storage: Storage) => {
    setEditing(storage)
    setForm(formFromStorage(storage))
    setOpen(true)
  }
  const set = (patch: Partial<StorageForm>) => setForm((current) => ({ ...current, ...patch }))

  const save = async () => {
    if (!form.name.trim()) {
      toast({ title: t('clouddrive.toast.failed'), description: t('clouddrive.storage.name'), tone: 'danger' })
      return
    }
    setBusy(true)
    try {
      const { config, credentials, defaultPath, readQuota, apiKeyVisible } = storagePayload(form)
      const body: Record<string, unknown> = {
        name: form.name.trim(), status: form.status, isDefault: form.isDefault, config,
        defaultPath: defaultPath || '/', readQuota, apiKeyVisible,
      }
      if (editing) {
        if (Object.keys(credentials).length > 0) body.credentials = credentials
        await clouddriveApi.patchStorage(editing.id, body)
      } else {
        body.type = form.type
        body.credentials = credentials
        await clouddriveApi.createStorage(body)
      }
      toast({ title: t('clouddrive.settings.saved') })
      setOpen(false)
      await refreshAll()
    } catch (error) {
      toast({ title: t('clouddrive.toast.failed'), description: error instanceof Error ? error.message : '', tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const test = async (storage: Storage) => {
    try {
      const result = await clouddriveApi.testStorage(storage.id)
      const description = result.quota
        ? `${t('clouddrive.admin.storage.quota')}: ${formatBytes(result.quota.used)} / ${result.quota.total === null ? '—' : formatBytes(result.quota.total)}`
        : result.message
      toast({ title: result.ok ? t('clouddrive.storage.test') : t('clouddrive.toast.failed'), description, tone: result.ok ? 'default' : 'danger' })
    } catch (error) {
      toast({ title: t('clouddrive.toast.failed'), description: error instanceof Error ? error.message : '', tone: 'danger' })
    }
    await load()
  }

  const setDefault = async (storage: Storage) => {
    try {
      await clouddriveApi.defaultStorage(storage.id)
      await refreshAll()
    } catch (error) {
      toast({ title: t('clouddrive.toast.failed'), description: error instanceof Error ? error.message : '', tone: 'danger' })
    }
  }

  const toggleStatus = async (storage: Storage) => {
    try {
      await clouddriveApi.patchStorage(storage.id, { status: storage.status === 'enabled' ? 'disabled' : 'enabled' })
      await refreshAll()
    } catch (error) {
      toast({ title: t('clouddrive.toast.failed'), description: error instanceof Error ? error.message : '', tone: 'danger' })
    }
  }

  const remove = async (storage: Storage) => {
    if (!await confirm({ title: t('clouddrive.admin.storage.delete_title'), description: t('clouddrive.admin.storage.delete_body'), confirmLabel: t('clouddrive.storage.delete'), tone: 'danger' })) return
    try {
      await clouddriveApi.deleteStorage(storage.id)
      await refreshAll()
    } catch (error) {
      toast({ title: t('clouddrive.toast.failed'), description: error instanceof Error ? error.message : '', tone: 'danger' })
    }
  }

  const typeBadge = (storage: Storage) => {
    const provider = typeof storage.config.provider === 'string' ? storage.config.provider : ''
    return provider && storage.type === 's3' ? `${storageTypeLabel(storage.type)} · ${storageProviderLabel(provider)}` : storageTypeLabel(storage.type)
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto p-4">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">{t('clouddrive.storage.title')}</h1>
        <span className="rounded-full bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{storages.length + 1}</span>
        <div className="ml-auto flex gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw size={13} /> {t('clouddrive.toolbar.refresh')}</Button>
          <Button size="sm" variant="primary" onClick={openCreate}><Plus size={13} /> {t('clouddrive.storage.add')}</Button>
        </div>
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="relative min-w-[220px] max-w-[420px] flex-1">
          <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" aria-hidden />
          <Input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1) }} placeholder={t('clouddrive.admin.search_storage')} aria-label={t('clouddrive.admin.search_storage')} className="h-8 pl-7" />
        </label>
        <Select value={typeFilter} onChange={(event) => { setTypeFilter(event.target.value); setPage(1) }} aria-label={t('clouddrive.admin.mount.storage_type')} className="w-44">
          <option value="all">{t('clouddrive.admin.filter_all')}</option>
          {STORAGE_TYPE_VALUES.map((type) => <option key={type} value={type}>{storageTypeLabel(type)}</option>)}
        </Select>
      </div>

      {loading ? <div className="flex h-32 items-center justify-center"><Spinner /></div> : (
        <>
          <section className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-label={t('clouddrive.storage.title')}>
            <article className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
              <div className="flex min-w-0 items-center gap-2">
                <HardDrive size={15} className="text-[var(--accent)]" />
                <strong className="min-w-0 flex-1 truncate text-[length:var(--text-12)]">{t('clouddrive.admin.storage.primary_title')}</strong>
                <span className="rounded-full bg-[var(--accent-soft)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-primary)]">{t('clouddrive.storage.default')}</span>
              </div>
              <p className="mt-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('clouddrive.admin.storage.primary_hint')}</p>
              <p className="mt-2 text-[length:var(--text-11)] text-[var(--text-secondary)]">{t('clouddrive.admin.used', { size: formatBytes(usage?.usedBytes ?? 0) })}</p>
            </article>
            {visible.map((storage) => (
              <article key={storage.id} className="flex min-w-0 flex-col rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Database size={15} className="text-[var(--text-secondary)]" />
                  <strong className="min-w-0 flex-1 truncate text-[length:var(--text-12)]" title={storage.name}>{storage.name}</strong>
                  {storage.isDefault && <span className="rounded-full bg-[var(--accent-soft)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-primary)]">{t('clouddrive.storage.default')}</span>}
                  <span className="rounded-full bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{typeBadge(storage)}</span>
                  <span className={`rounded-full px-1.5 py-0.5 text-[length:var(--text-10)] ${storage.status === 'enabled' ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]' : 'bg-[var(--bg-inset)] text-[var(--text-tertiary)]'}`}>
                    {storage.status === 'enabled' ? t('clouddrive.admin.enabled') : t('clouddrive.admin.disabled')}
                  </span>
                </div>
                <dl className="mt-2 grid gap-x-3 gap-y-1 text-[length:var(--text-11)]">
                  {storageDetails(storage).map((row) => (
                    <div key={row.label} className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
                      <dt className="truncate text-[var(--text-tertiary)]">{row.label}</dt>
                      <dd className="truncate text-[var(--text-secondary)]" title={row.value}>{row.value}</dd>
                    </div>
                  ))}
                </dl>
                <div className="mt-auto flex flex-wrap gap-1 pt-2">
                  <Button size="sm" variant="ghost" onClick={() => void test(storage)}>{t('clouddrive.admin.test')}</Button>
                  <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => openEdit(storage)}>{t('clouddrive.admin.edit')}</Button>
                  {!storage.isDefault && <Button size="sm" variant="ghost" icon={<Star size={13} />} onClick={() => void setDefault(storage)}>{t('clouddrive.storage.set_default')}</Button>}
                  <Button size="sm" variant="ghost" onClick={() => void toggleStatus(storage)}>{storage.status === 'enabled' ? t('clouddrive.admin.disable') : t('clouddrive.admin.enable')}</Button>
                  <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => void remove(storage)}>{t('clouddrive.storage.delete')}</Button>
                </div>
              </article>
            ))}
          </section>
          {filtered.length === 0 && (
            <p className="py-10 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {storages.length === 0 ? t('clouddrive.admin.storage.empty') : t('clouddrive.admin.no_results')}
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
        title={editing ? t('clouddrive.admin.storage.edit_title') : t('clouddrive.admin.storage.add_title')}
        width={560}
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>{t('clouddrive.dialog.cancel')}</Button><Button variant="primary" loading={busy} onClick={() => void save()}>{t('clouddrive.dialog.save')}</Button></>}
      >
        <div className="grid gap-2">
          <Field label={t('clouddrive.storage.name')} required><Input value={form.name} onChange={(event) => set({ name: event.target.value })} /></Field>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label={t('clouddrive.storage.type')} required>
              <Select value={form.type} disabled={editing !== null} onChange={(event) => set({ type: event.target.value as StorageType })}>
                {STORAGE_TYPE_VALUES.map((type) => <option key={type} value={type}>{storageTypeLabel(type)}</option>)}
              </Select>
            </Field>
            <Field label={t('clouddrive.admin.status')}>
              <Select value={form.status} onChange={(event) => set({ status: event.target.value === 'disabled' ? 'disabled' : 'enabled' })}>
                <option value="enabled">{t('clouddrive.admin.enabled')}</option>
                <option value="disabled">{t('clouddrive.admin.disabled')}</option>
              </Select>
            </Field>
          </div>
          {editing && <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('clouddrive.admin.storage.type_locked')}</p>}
          <p className="-mt-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('clouddrive.admin.storage.status_hint')}</p>
          <Field label={t('clouddrive.admin.storage.capacity')} hint={t('clouddrive.admin.storage.capacity_hint')}>
            <div className="flex gap-2">
              <Input type="number" min="0" step="0.01" value={form.capacityValue} onChange={(event) => set({ capacityValue: event.target.value })} placeholder={t('clouddrive.admin.storage.capacity_placeholder')} aria-label={t('clouddrive.admin.storage.capacity')} className="flex-1" />
              <Select value={form.capacityUnit} onChange={(event) => set({ capacityUnit: event.target.value as CapacityUnit })} aria-label={t('clouddrive.admin.storage.capacity')} className="w-24">
                {CAPACITY_UNITS.map((unit) => <option key={unit.value} value={unit.value}>{unit.value}</option>)}
              </Select>
            </div>
          </Field>

          {form.type === 's3' && (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label={t('clouddrive.admin.storage.provider')}>
                  <Select
                    value={form.provider}
                    onChange={(event) => {
                      const provider = event.target.value
                      set({
                        provider,
                        pathStyle: provider === 'r2' || provider === 'other',
                        region: provider === 'r2' ? 'auto' : provider === 'aws' ? 'us-east-1' : form.region,
                      })
                    }}
                  >
                    <option value="r2">{t('clouddrive.admin.storage.provider_r2')}</option>
                    <option value="b2">{t('clouddrive.admin.storage.provider_b2')}</option>
                    <option value="aws">{t('clouddrive.admin.storage.provider_aws')}</option>
                    <option value="oss">{t('clouddrive.admin.storage.provider_oss')}</option>
                    <option value="other">{t('clouddrive.admin.storage.provider_other')}</option>
                  </Select>
                </Field>
                <Field label={t('clouddrive.storage.region')}><Input value={form.region} onChange={(event) => set({ region: event.target.value })} placeholder="auto" /></Field>
              </div>
              <Field label={t('clouddrive.storage.endpoint')} required><Input value={form.endpoint} onChange={(event) => set({ endpoint: event.target.value })} placeholder="https://s3.example.com" /></Field>
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label={t('clouddrive.storage.bucket')} required><Input value={form.bucketName} onChange={(event) => set({ bucketName: event.target.value })} /></Field>
                <Field label={t('clouddrive.storage.root_path')}><Input value={form.rootPath} onChange={(event) => set({ rootPath: event.target.value })} placeholder={t('clouddrive.storage.root_path_placeholder')} /></Field>
              </div>
              <Checkbox checked={form.pathStyle} label={t('clouddrive.admin.storage.path_style')} onChange={(next) => set({ pathStyle: next })} />
              <p className="-mt-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('clouddrive.admin.storage.path_style_hint')}</p>
              <Field label={t('clouddrive.admin.storage.custom_host')}>
                <Input value={form.customHost} onChange={(event) => set({ customHost: event.target.value })} placeholder={t('clouddrive.admin.storage.custom_host_placeholder')} />
              </Field>
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label={t('clouddrive.storage.access_key')}><Input value={form.accessKeyId} onChange={(event) => set({ accessKeyId: event.target.value })} placeholder={editing?.hasCredentials ? t('clouddrive.admin.storage.secret_keep') : ''} /></Field>
                <Field label={t('clouddrive.storage.secret_key')}><Input type="password" value={form.secretAccessKey} onChange={(event) => set({ secretAccessKey: event.target.value })} placeholder={editing?.hasCredentials ? t('clouddrive.admin.storage.secret_keep') : ''} /></Field>
              </div>
            </>
          )}

          {form.type === 'webdav' && (
            <>
              <Field label={t('clouddrive.storage.base_url')} required><Input value={form.baseUrl} onChange={(event) => set({ baseUrl: event.target.value })} placeholder="https://dav.example.com/dav" /></Field>
              <Field label={t('clouddrive.storage.root_path')}><Input value={form.rootPath} onChange={(event) => set({ rootPath: event.target.value })} placeholder={t('clouddrive.storage.root_path_placeholder')} /></Field>
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label={t('clouddrive.storage.username')}><Input value={form.username} onChange={(event) => set({ username: event.target.value })} placeholder={editing?.hasCredentials ? t('clouddrive.admin.storage.secret_keep') : ''} /></Field>
                <Field label={t('clouddrive.storage.password')}><Input type="password" value={form.password} onChange={(event) => set({ password: event.target.value })} placeholder={editing?.hasCredentials ? t('clouddrive.admin.storage.secret_keep') : ''} /></Field>
              </div>
            </>
          )}

          {(form.type === 'github' || form.type === 'huggingface') && (
            <>
              <Field label={t('clouddrive.storage.repo')} required><Input value={form.repo} onChange={(event) => set({ repo: event.target.value })} placeholder={t('clouddrive.storage.repo_placeholder')} /></Field>
              {form.type === 'github' ? (
                <Field label={t('clouddrive.storage.branch')}><Input value={form.branch} onChange={(event) => set({ branch: event.target.value })} placeholder="main" /></Field>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label={t('clouddrive.storage.repo_type')}>
                    <Select value={form.repoType} onChange={(event) => set({ repoType: event.target.value === 'dataset' ? 'dataset' : 'model' })}>
                      <option value="model">{t('clouddrive.storage.repo_type_model')}</option>
                      <option value="dataset">{t('clouddrive.storage.repo_type_dataset')}</option>
                    </Select>
                  </Field>
                  <Field label={t('clouddrive.storage.revision')}><Input value={form.revision} onChange={(event) => set({ revision: event.target.value })} placeholder="main" /></Field>
                </div>
              )}
              <Field label={t('clouddrive.storage.root_path')}><Input value={form.rootPath} onChange={(event) => set({ rootPath: event.target.value })} placeholder={t('clouddrive.storage.root_path_placeholder')} /></Field>
              <Field label={t('clouddrive.storage.token')}><Input type="password" value={form.token} onChange={(event) => set({ token: event.target.value })} placeholder={editing?.hasCredentials ? t('clouddrive.admin.storage.secret_keep') : ''} /></Field>
            </>
          )}

          {(form.type === 'discord' || form.type === 'telegram') && (
            <>
              {form.type === 'discord'
                ? <Field label={t('clouddrive.storage.channel_id')} required><Input value={form.channelId} onChange={(event) => set({ channelId: event.target.value })} /></Field>
                : <Field label={t('clouddrive.storage.chat_id')} required><Input value={form.chatId} onChange={(event) => set({ chatId: event.target.value })} /></Field>}
              <Field label={t('clouddrive.storage.bot_token')}><Input type="password" value={form.botToken} onChange={(event) => set({ botToken: event.target.value })} placeholder={editing?.hasCredentials ? t('clouddrive.admin.storage.secret_keep') : ''} /></Field>
            </>
          )}

          {(form.type === 'onedrive' || form.type === 'googledrive') && (
            <>
              {form.type === 'onedrive'
                ? <Field label={t('clouddrive.storage.drive_id')}><Input value={form.driveId} onChange={(event) => set({ driveId: event.target.value })} /></Field>
                : <Field label={t('clouddrive.storage.folder_id')}><Input value={form.folderId} onChange={(event) => set({ folderId: event.target.value })} placeholder="root" /></Field>}
              <Field label={t('clouddrive.storage.root_path')}><Input value={form.rootPath} onChange={(event) => set({ rootPath: event.target.value })} placeholder={t('clouddrive.storage.root_path_placeholder')} /></Field>
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label={t('clouddrive.storage.token')}><Input type="password" value={form.token} onChange={(event) => set({ token: event.target.value })} placeholder={editing?.hasCredentials ? t('clouddrive.admin.storage.secret_keep') : ''} /></Field>
                <Field label={t('clouddrive.storage.refresh_token')}><Input type="password" value={form.refreshToken} onChange={(event) => set({ refreshToken: event.target.value })} placeholder={editing?.hasCredentials ? t('clouddrive.admin.storage.secret_keep') : ''} /></Field>
                <Field label={t('clouddrive.storage.client_id')}><Input value={form.clientId} onChange={(event) => set({ clientId: event.target.value })} /></Field>
                <Field label={t('clouddrive.storage.client_secret')}><Input type="password" value={form.clientSecret} onChange={(event) => set({ clientSecret: event.target.value })} placeholder={editing?.hasCredentials ? t('clouddrive.admin.storage.secret_keep') : ''} /></Field>
              </div>
            </>
          )}

          <p className="pt-1 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('clouddrive.admin.storage.advanced')}</p>
          <Field label={t('clouddrive.admin.storage.default_path')}>
            <Input value={form.defaultPath} onChange={(event) => set({ defaultPath: event.target.value })} placeholder={t('clouddrive.admin.storage.default_path_placeholder')} />
          </Field>
          <Field label={t('clouddrive.admin.storage.url_proxy')}>
            <Input value={form.urlProxy} onChange={(event) => set({ urlProxy: event.target.value })} placeholder={t('clouddrive.admin.storage.url_proxy_placeholder')} />
          </Field>
          {form.type === 'webdav' && (
            <>
              <div className="space-y-1">
                <Checkbox checked={form.readQuota} label={t('clouddrive.admin.storage.read_quota')} onChange={(next) => set({ readQuota: next })} />
                <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('clouddrive.admin.storage.read_quota_hint')}</p>
              </div>
              <div className="space-y-1">
                <Checkbox checked={false} disabled label={t('clouddrive.admin.storage.tls_insecure')} onChange={() => undefined} />
                <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('clouddrive.admin.storage.tls_insecure_hint')}</p>
              </div>
            </>
          )}
          <div className="space-y-1">
            <Checkbox checked={form.apiKeyVisible} label={t('clouddrive.admin.storage.api_key_visible')} onChange={(next) => set({ apiKeyVisible: next })} />
            <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('clouddrive.admin.storage.api_key_visible_hint')}</p>
          </div>

          <Checkbox checked={form.isDefault} label={t('clouddrive.storage.set_default')} onChange={(next) => set({ isDefault: next })} />
          <p className="-mt-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('clouddrive.admin.storage.default_hint')}</p>
          <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('clouddrive.admin.storage.credentials_hint')}</p>
        </div>
      </Modal>
    </div>
  )
}


