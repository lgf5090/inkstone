import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Check, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { NavAiModel } from '@shared/nav/api'
import {
  NAV_LIMITS,
  isHttpUrl,
  normalizeSearchSource,
  type NavDisplaySettings,
  type NavSearchSettings,
  type NavSearchSource,
} from '@shared/nav/model'
import { Modal, confirm } from '../../components/overlay'
import { Button, IconButton } from '../../components/primitives'
import { Checkbox, Field, Input, Select, Segmented } from '../../components/form'
import { Tabs } from '../../components/tabs'
import { useUi } from '../../store/ui'
import { t } from '../../lib/i18n'
import { navApi } from './api'
import { useNavStore } from './nav-store'

interface ModalProps {
  open: boolean
  onClose: () => void
}

type SettingsTab = 'display' | 'search' | 'ai'

export function NavSettingsModal({ open, onClose }: ModalProps) {
  const settings = useNavStore((state) => state.settings)
  const saveDisplay = useNavStore((state) => state.saveDisplay)
  const saveSearch = useNavStore((state) => state.saveSearch)
  const saveAiModel = useNavStore((state) => state.saveAiModel)
  const toast = useUi((state) => state.toast)
  const [tab, setTab] = useState<SettingsTab>('display')
  const [display, setDisplay] = useState<NavDisplaySettings>(settings.display)
  const [search, setSearch] = useState<NavSearchSettings>(settings.search)
  const [modelId, setModelId] = useState(settings.ai.modelId)
  const [models, setModels] = useState<NavAiModel[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const initial = useMemo(() => JSON.stringify({ display: settings.display, search: settings.search, modelId: settings.ai.modelId }), [settings])
  const dirty = JSON.stringify({ display, search, modelId }) !== initial

  useEffect(() => {
    if (!open) return
    setDisplay(settings.display)
    setSearch(settings.search)
    setModelId(settings.ai.modelId)
    setTab('display')
    setModelsLoading(true)
    navApi.aiModels().then((result) => setModels(result.models)).catch(() => setModels([])).finally(() => setModelsLoading(false))
  }, [open])

  async function requestClose() {
    if (dirty && !(await confirm({ title: t('nav.settings.dirty'), tone: 'danger', confirmLabel: t('nav.close') }))) return
    onClose()
  }

  async function save() {
    setSaving(true)
    try {
      if (tab === 'display') {
        await saveDisplay({ ...display, navTitle: display.navTitle.trim() })
      } else if (tab === 'search') {
        const sourceIds = new Set<string>()
        const sources: NavSearchSource[] = []
        for (const raw of search.sources) {
          const normalized = normalizeSearchSource(raw)
          if (!normalized) {
            toast({ title: t('nav.settings.source_url'), tone: 'danger' })
            return
          }
          if (sourceIds.has(normalized.id)) normalized.id = `${normalized.id}-${sources.length}`
          if (sources.length >= NAV_LIMITS.searchSources) break
          sourceIds.add(normalized.id)
          sources.push(normalized)
        }
        const selectedSourceId = sources.some((source) => source.id === search.selectedSourceId)
          ? search.selectedSourceId
          : sources.find((source) => source.enabled)?.id ?? null
        await saveSearch({ ...search, sources, selectedSourceId })
      } else {
        await saveAiModel(modelId)
      }
      toast({ title: t('nav.settings.saved'), tone: 'success' })
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : t('nav.error.generic'), tone: 'danger' })
    } finally {
      setSaving(false)
    }
  }

  function addSource() {
    setSearch((current) => ({
      ...current,
      sources: [...current.sources, { id: `custom-${Date.now().toString(36)}`, name: '', url: '', icon: null, enabled: true, createdAt: Date.now() }],
    }))
  }

  function patchSource(id: string, patch: Partial<NavSearchSource>): void {
    setSearch((current) => ({ ...current, sources: current.sources.map((source) => source.id === id ? { ...source, ...patch } : source) }))
  }

  function removeSource(id: string): void {
    setSearch((current) => {
      const sources = current.sources.filter((source) => source.id !== id)
      return {
        ...current,
        sources,
        selectedSourceId: current.selectedSourceId === id ? sources.find((source) => source.enabled)?.id ?? null : current.selectedSourceId,
      }
    })
  }

  return (
    <Modal open={open} onClose={() => void requestClose()} title={t('nav.settings.title')} width={640}>
      <div className="flex flex-col gap-4">
        <Tabs
          value={tab}
          label={t('nav.settings.title')}
          onChange={(value) => setTab(value as SettingsTab)}
          items={[
            { id: 'display', label: t('nav.settings.display') },
            { id: 'search', label: t('nav.settings.search') },
            { id: 'ai', label: t('nav.settings.ai') },
          ]}
        />
        {tab === 'display' && (
          <div className="flex flex-col gap-3">
            <Field label={t('nav.settings.nav_title')}>
              <Input value={display.navTitle} onChange={(event) => setDisplay({ ...display, navTitle: event.target.value })} placeholder={t('nav.title')} maxLength={60} />
            </Field>
            <Field label={t('nav.settings.card_style')}>
              <Segmented value={display.cardStyle} onChange={(value) => setDisplay({ ...display, cardStyle: value as NavDisplaySettings['cardStyle'] })} options={[{ value: 'detailed', label: t('nav.card_detailed') }, { value: 'simple', label: t('nav.card_simple') }]} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('nav.settings.recent_count')}>
                <Input type="number" min={0} max={NAV_LIMITS.recentLinks} value={display.recentLinksCount} onChange={(event) => setDisplay({ ...display, recentLinksCount: Math.max(0, Math.min(NAV_LIMITS.recentLinks, Number(event.target.value) || 0)) })} />
              </Field>
              <Field label={t('nav.settings.frequent_count')}>
                <Input type="number" min={0} max={NAV_LIMITS.frequentLinks} value={display.frequentLinksCount} onChange={(event) => setDisplay({ ...display, frequentLinksCount: Math.max(0, Math.min(NAV_LIMITS.frequentLinks, Number(event.target.value) || 0)) })} />
              </Field>
            </div>
            <Checkbox checked={display.autoFetchIcon} onChange={(checked) => setDisplay({ ...display, autoFetchIcon: checked })} label={t('nav.settings.auto_icon')} />
          </div>
        )}
        {tab === 'search' && (
          <div className="flex flex-col gap-3">
            <Field label={t('nav.settings.mode')}>
              <Segmented value={search.mode} onChange={(value) => setSearch({ ...search, mode: value as NavSearchSettings['mode'] })} options={[{ value: 'internal', label: t('nav.search.internal') }, { value: 'external', label: t('nav.search.external') }]} />
            </Field>
            <Field label={t('nav.settings.selected_source')}>
              <Select value={search.selectedSourceId ?? ''} onChange={(event) => setSearch({ ...search, selectedSourceId: event.target.value || null })}>
                <option value="">—</option>
                {search.sources.filter((source) => source.enabled).map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
              </Select>
            </Field>
            <div className="flex items-center justify-between">
              <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('nav.settings.sources')}</span>
              <Button size="sm" variant="secondary" icon={<Plus size={13} />} onClick={addSource}>{t('nav.settings.add_source')}</Button>
            </div>
            <div className="flex flex-col gap-2">
              {search.sources.map((source) => (
                <div key={source.id} className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2">
                  <div className="grid gap-2 sm:grid-cols-[1fr_1.6fr_auto]">
                    <Input value={source.name} onChange={(event) => patchSource(source.id, { name: event.target.value })} placeholder={t('nav.settings.source_name')} maxLength={NAV_LIMITS.searchSourceName} aria-label={t('nav.settings.source_name')} />
                    <Input value={source.url} onChange={(event) => patchSource(source.id, { url: event.target.value })} placeholder="https://example.com/search?q={query}" aria-label={t('nav.settings.source_url')} />
                    <div className="flex items-center gap-1">
                      <Checkbox checked={source.enabled} onChange={(checked) => patchSource(source.id, { enabled: checked })} ariaLabel={t('nav.settings.source_name')} />
                      <IconButton label={t('nav.settings.remove_source')} onClick={() => removeSource(source.id)}><Trash2 size={14} /></IconButton>
                    </div>
                  </div>
                  <Input className="mt-2" value={source.icon ?? ''} onChange={(event) => patchSource(source.id, { icon: event.target.value || null })} placeholder={t('nav.settings.source_icon')} aria-label={t('nav.settings.source_icon')} />
                  {source.url && !(isHttpUrl(source.url) && source.url.includes('{query}')) && (
                    <p className="mt-1 text-[length:var(--text-11)] text-[var(--danger)]">{t('nav.settings.source_url')}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        {tab === 'ai' && (
          <div className="flex flex-col gap-3">
            <Field label={t('nav.settings.ai_model')} hint={t('nav.settings.ai_hint')}>
              <Select value={modelId} onChange={(event) => setModelId(event.target.value)} disabled={modelsLoading || models.length === 0}>
                <option value="">{modelsLoading ? '…' : t('nav.settings.ai_model')}</option>
                {models.filter((model) => model.available).map((model) => <option key={model.id} value={model.id}>{model.label}{model.providerLabel ? ` · ${model.providerLabel}` : ''}</option>)}
              </Select>
            </Field>
            {!modelsLoading && models.filter((model) => model.available).length === 0 && (
              <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('nav.settings.no_model')}</p>
            )}
            {modelsLoading && <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('nav.loading')}</p>}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => void requestClose()}>{t('nav.close')}</Button>
          <Button onClick={() => void save()} loading={saving} icon={saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}>{t('nav.save')}</Button>
        </div>
      </div>
    </Modal>
  )
}

const WEBDAV_PRESETS = [
  { label: 'Jianguoyun', url: 'https://dav.jianguoyun.com/dav/' },
  { label: 'InfiniCLOUD', url: 'https://domi.teracloud.jp/dav/' },
  { label: 'Nextcloud', url: 'https://your-host/remote.php/dav/files/username/' },
  { label: 'Synology', url: 'https://your-host:5006/' },
  { label: 'Box', url: 'https://dav.box.com/dav/' },
]

type WebdavStatus = { kind: 'idle' } | { kind: 'loading'; text: string } | { kind: 'success'; text: string } | { kind: 'error'; text: string }

export function NavBackupModal({ open, onClose }: ModalProps) {
  const webdav = useNavStore((state) => state.webdav)
  const toast = useUi((state) => state.toast)
  const [url, setUrl] = useState(webdav.url)
  const [username, setUsername] = useState(webdav.username)
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(webdav.hasPassword)
  const [status, setStatus] = useState<WebdavStatus>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setUrl(webdav.url)
    setUsername(webdav.username)
    setPassword('')
    setRemember(webdav.hasPassword)
    setStatus({ kind: 'idle' })
  }, [open])

  function config() {
    return { url: url.trim(), username: username.trim(), ...(password.trim() ? { password: password.trim() } : {}) }
  }

  async function persistConfig(): Promise<void> {
    if (!url.trim() || !username.trim()) throw new Error(t('nav.webdav.required'))
    await navApi.saveWebdavConfig({ url: url.trim(), username: username.trim() })
    if (remember && password.trim()) {
      await navApi.saveWebdavSecret(password.trim())
    } else if (!remember && !password.trim() && webdav.hasPassword) {
      await navApi.saveWebdavSecret(null)
    }
    useNavStore.setState((state) => ({
      webdav: {
        ...state.webdav,
        url: url.trim(),
        username: username.trim(),
        hasPassword: remember ? Boolean(password.trim()) || state.webdav.hasPassword : state.webdav.hasPassword,
      },
    }))
  }

  async function run(kind: 'test' | 'backup' | 'timestamp' | 'restore'): Promise<void> {
    setBusy(true)
    try {
      await persistConfig()
      if (kind === 'test') {
        setStatus({ kind: 'loading', text: t('nav.webdav.test') })
        const result = await navApi.webdavTest(config())
        setStatus(result.ok ? { kind: 'success', text: t('nav.webdav.test_ok') } : { kind: 'error', text: result.error ?? t('nav.webdav.failed') })
      } else if (kind === 'restore') {
        if (!(await confirm({ title: t('nav.webdav.restore_confirm'), tone: 'danger', confirmLabel: t('nav.webdav.restore') }))) return
        setStatus({ kind: 'loading', text: t('nav.webdav.restore') })
        const result = await navApi.webdavRestore(config())
        setStatus({ kind: 'success', text: t('nav.webdav.restore_ok') })
        toast({ title: t('nav.webdav.restore_ok'), description: result.unlockedCategoryNames.length ? t('nav.webdav.unlocked', { names: result.unlockedCategoryNames.join(', ') }) : undefined, tone: 'success' })
        await useNavStore.getState().load(true)
      } else {
        setStatus({ kind: 'loading', text: t('nav.webdav.backup') })
        const result = await navApi.webdavBackup({ ...config(), timestamped: kind === 'timestamp' })
        setStatus(result.verified
          ? { kind: 'success', text: `${t('nav.webdav.backup_ok')}: ${result.filename} · ${t('nav.webdav.verified')}` }
          : { kind: 'error', text: `${t('nav.webdav.backup_ok')}: ${result.filename} · ${t('nav.webdav.unverified')}` })
      }
    } catch (error) {
      setStatus({ kind: 'error', text: error instanceof Error ? error.message : t('nav.webdav.failed') })
    } finally {
      setBusy(false)
    }
  }

  async function forget(): Promise<void> {
    setBusy(true)
    try {
      await navApi.webdavForget()
      setPassword('')
      setRemember(false)
      useNavStore.setState((state) => ({ webdav: { ...state.webdav, url: '', username: '', hasPassword: false } }))
      setUrl('')
      setUsername('')
      setStatus({ kind: 'success', text: t('nav.webdav.never') })
    } catch (error) {
      setStatus({ kind: 'error', text: error instanceof Error ? error.message : t('nav.webdav.failed') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('nav.webdav.title')} width={620}>
      <div className="flex flex-col gap-3">
        <Field label={t('nav.webdav.url')}>
          <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://dav.example.com/" />
        </Field>
        <div className="flex flex-wrap gap-1.5">
          <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('nav.webdav.preset')}</span>
          {WEBDAV_PRESETS.map((preset) => (
            <Button key={preset.label} size="sm" variant="ghost" onClick={() => setUrl(preset.url)}>{preset.label}</Button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('nav.webdav.username')}><Input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></Field>
          <Field label={t('nav.webdav.password')}>
            <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" placeholder={webdav.hasPassword ? t('nav.webdav.saved_password') : ''} />
          </Field>
        </div>
        <Checkbox checked={remember} onChange={setRemember} label={t('nav.webdav.remember')} />
        <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('nav.webdav.includes_locked')}</p>
        {!webdav.hasPassword && remember && <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('nav.webdav.no_vault')}</p>}
        {status.kind !== 'idle' && (
          <div className={`flex items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-[length:var(--text-12)] ${status.kind === 'error' ? 'bg-[var(--danger-soft)] text-[var(--danger)]' : status.kind === 'success' ? 'bg-[var(--success-soft)] text-[var(--success)]' : 'bg-[var(--bg-hover)] text-[var(--text-secondary)]'}`}>
            {status.kind === 'loading' && <Loader2 size={13} className="animate-spin" />}
            {status.kind === 'success' && <Check size={13} />}
            {status.kind === 'error' && <AlertCircle size={13} />}
            <span className="min-w-0 flex-1">{status.text}</span>
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => void forget()} disabled={busy} icon={<RefreshCw size={13} />}>{t('nav.webdav.forget')}</Button>
          <Button variant="secondary" onClick={() => void run('restore')} disabled={busy}>{t('nav.webdav.restore')}</Button>
          <Button variant="secondary" onClick={() => void run('timestamp')} disabled={busy}>{t('nav.webdav.timestamp')}</Button>
          <Button variant="secondary" onClick={() => void run('backup')} disabled={busy}>{t('nav.webdav.backup')}</Button>
          <Button onClick={() => void run('test')} disabled={busy} loading={busy}>{t('nav.webdav.test')}</Button>
        </div>
      </div>
    </Modal>
  )
}
