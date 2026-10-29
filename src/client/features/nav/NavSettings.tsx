import { useEffect, useMemo, useState } from 'react'
import { Check, Loader2, Plus, Trash2 } from 'lucide-react'
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
