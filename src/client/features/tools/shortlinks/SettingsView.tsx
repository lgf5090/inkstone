import { useEffect, useState } from 'react'
import {
  Archive,
  Copy,
  Database,
  FileSpreadsheet,
  FileText,
  Key,
  Plus,
  RotateCcw,
  Sliders,
  Trash2,
  Upload,
} from 'lucide-react'
import { Button, IconButton } from '../../../components/primitives'
import { FIELD_BASE, Input } from '../../../components/form'
import { confirm } from '../../../components/overlay'
import { t } from '../../../lib/i18n'
import { copyText } from '../../../lib/clipboard'
import { useUiStore } from '../../../lib/ui-store'
import type { TimelineRange } from '@shared/tools/shortlinks/types'
import { useShortlinksStore } from './store'
import { shortlinksApi } from './api'

function formatCombinations(length: number): string {
  const combos = Math.pow(62, length)
  if (combos >= 1e18) return `${(combos / 1e18).toFixed(1)} quintillion`
  if (combos >= 1e15) return `${(combos / 1e15).toFixed(1)} quadrillion`
  if (combos >= 1e12) return `${(combos / 1e12).toFixed(1)} trillion`
  if (combos >= 1e9) return `${(combos / 1e9).toFixed(1)} billion`
  if (combos >= 1e6) return `${(combos / 1e6).toFixed(1)} million`
  return combos.toLocaleString()
}

export function SettingsView() {
  const settings = useShortlinksStore((s) => s.settings)
  const apiKeys = useShortlinksStore((s) => s.apiKeys)
  const backups = useShortlinksStore((s) => s.backups)
  const fetchSettings = useShortlinksStore((s) => s.fetchSettings)
  const fetchApiKeys = useShortlinksStore((s) => s.fetchApiKeys)
  const fetchBackups = useShortlinksStore((s) => s.fetchBackups)
  const setImportModalOpen = useShortlinksStore((s) => s.setImportModalOpen)
  const fetchLinks = useShortlinksStore((s) => s.fetchLinks)
  const fetchDashboard = useShortlinksStore((s) => s.fetchDashboard)

  // Local state for settings form
  const [slugLength, setSlugLength] = useState(6)
  const [defaultRange, setDefaultRange] = useState<TimelineRange>('30d')
  const [ignoreBots, setIgnoreBots] = useState(true)
  const [ignoreSelf, setIgnoreSelf] = useState(true)
  const [savingSettings, setSavingSettings] = useState(false)

  // New API key form
  const [keyName, setKeyName] = useState('')
  const [keyScope, setKeyScope] = useState<'read' | 'write' | 'admin'>('write')
  const [creatingKey, setCreatingKey] = useState(false)
  const [generatedKey, setGeneratedKey] = useState<string | null>(null)

  // Backup action
  const [backingUp, setBackingUp] = useState(false)

  useEffect(() => {
    void fetchSettings()
    void fetchApiKeys()
    void fetchBackups()
  }, [fetchSettings, fetchApiKeys, fetchBackups])

  useEffect(() => {
    if (settings) {
      setSlugLength(settings.slug_default_length)
      setDefaultRange(settings.default_range)
      setIgnoreBots(settings.filter_bots)
      setIgnoreSelf(settings.filter_self_referrers)
    }
  }, [settings])

  const handleSaveSettings = async () => {
    setSavingSettings(true)
    try {
      await shortlinksApi.updateSettings({
        slug_default_length: slugLength,
        default_range: defaultRange,
        filter_bots: ignoreBots,
        filter_self_referrers: ignoreSelf,
      })
      useUiStore.getState().toast(t('tools.shortlinks.settings.save_success'), 'success')
      void fetchSettings()
    } catch (err) {
      useUiStore.getState().toast((err as Error).message, 'error')
    } finally {
      setSavingSettings(false)
    }
  }

  const handleCreateApiKey = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = keyName.trim()
    if (!trimmed) return

    setCreatingKey(true)
    try {
      const res = await shortlinksApi.createApiKey({
        title: trimmed,
        scope: keyScope as 'read' | 'read,write' | 'admin',
      })
      setKeyName('')
      const returnedKey = res.api_key || null
      setGeneratedKey(returnedKey)
      useUiStore.getState().toast(t('tools.shortlinks.settings.save_success'), 'success')
      void fetchApiKeys()
    } catch (err) {
      useUiStore.getState().toast((err as Error).message, 'error')
    } finally {
      setCreatingKey(false)
    }
  }

  const handleRevokeApiKey = async (id: number, name: string) => {
    const ok = await confirm({
      title: t('tools.shortlinks.settings.revoke_key'),
      description: t('tools.shortlinks.settings.revoke_confirm', { name }),
      tone: 'danger',
      confirmLabel: t('tools.shortlinks.settings.revoke_key'),
      cancelLabel: t('common.cancel'),
    })
    if (!ok) return

    try {
      await shortlinksApi.deleteApiKey(id)
      useUiStore.getState().toast(t('tools.shortlinks.settings.save_success'), 'success')
      void fetchApiKeys()
    } catch (err) {
      useUiStore.getState().toast((err as Error).message, 'error')
    }
  }

  const handleExportTxt = async () => {
    try {
      const res = await shortlinksApi.exportTxt()
      if (res.url) {
        window.open(res.url, '_blank')
      } else {
        useUiStore.getState().toast('Exported: ' + (res.r2_key || 'success'), 'success')
      }
    } catch (err) {
      useUiStore.getState().toast((err as Error).message, 'error')
    }
  }

  const handleExportCsv = async () => {
    try {
      const res = await shortlinksApi.exportCsv()
      if (res.url) {
        window.open(res.url, '_blank')
      } else {
        useUiStore.getState().toast('Exported: ' + (res.r2_key || 'success'), 'success')
      }
    } catch (err) {
      useUiStore.getState().toast((err as Error).message, 'error')
    }
  }

  const handleCreateBackup = async () => {
    setBackingUp(true)
    try {
      const backup = await shortlinksApi.createBackup()
      useUiStore.getState().toast(
        t('tools.shortlinks.settings.backup_result', { count: backup.link_count ?? 0 }),
        'success',
      )
      void fetchBackups()
    } catch (err) {
      useUiStore.getState().toast((err as Error).message, 'error')
    } finally {
      setBackingUp(false)
    }
  }

  const handleRestoreBackup = async (backupId: string | number) => {
    const ok = await confirm({
      title: t('tools.shortlinks.settings.restore_backup'),
      description: t('tools.shortlinks.settings.restore_confirm'),
      tone: 'danger',
      confirmLabel: t('tools.shortlinks.settings.restore_backup'),
      cancelLabel: t('common.cancel'),
    })
    if (!ok) return

    try {
      const res = await shortlinksApi.restoreBackup(backupId)
      useUiStore.getState().toast(
        t('tools.shortlinks.settings.restore_result', {
          imported: res.imported,
          total: res.total,
        }),
        'success',
      )
      if (res.protectedWithoutPassword > 0) {
        useUiStore.getState().toast(
          t('tools.shortlinks.settings.restore_protected_warn', {
            count: res.protectedWithoutPassword,
          }),
          'error',
        )
      }
      void fetchLinks()
      void fetchDashboard()
    } catch (err) {
      useUiStore.getState().toast((err as Error).message, 'error')
    }
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8 space-y-8 max-w-4xl mx-auto w-full">
      <div>
        <h2 className="text-xl font-bold text-[var(--text-primary)]">
          {t('tools.shortlinks.settings.title')}
        </h2>
      </div>

      {/* Preferences Section */}
      <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-6 space-y-5">
        <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] pb-3">
          <Sliders size={18} className="text-[var(--accent)]" />
          <h3 className="font-semibold text-[length:var(--text-14)] text-[var(--text-primary)]">
            {t('tools.shortlinks.settings.title')}
          </h3>
        </div>

        {/* Slug length */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
              {t('tools.shortlinks.settings.slug_length')}:{' '}
              <span className="font-mono font-bold text-[var(--accent)]">{slugLength}</span>
            </label>
            <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)] font-mono">
              {'62^'}{slugLength}{' = '}{formatCombinations(slugLength)}
            </span>
          </div>
          <input
            type="range"
            min={3}
            max={12}
            value={slugLength}
            onChange={(e) => setSlugLength(Number(e.target.value))}
            className="w-full accent-[var(--accent)] cursor-pointer"
          />
          <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('tools.shortlinks.settings.slug_length_desc', {
              combos: formatCombinations(slugLength),
            })}
          </p>
        </div>

        {/* Default range */}
        <div className="space-y-1.5 pt-2">
          <label className="block text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
            {t('tools.shortlinks.settings.default_range')}
          </label>
          <select
            value={defaultRange}
            onChange={(e) => setDefaultRange(e.target.value as TimelineRange)}
            className={`${FIELD_BASE} h-9 max-w-xs`}
          >
            <option value="24h">{t('tools.shortlinks.detail.range_24h')}</option>
            <option value="7d">{t('tools.shortlinks.detail.range_7d')}</option>
            <option value="30d">{t('tools.shortlinks.detail.range_30d')}</option>
            <option value="90d">{t('tools.shortlinks.detail.range_90d')}</option>
            <option value="all">{t('tools.shortlinks.detail.range_all')}</option>
          </select>
        </div>

        {/* Bot filter toggle */}
        <div className="pt-2 flex items-center justify-between">
          <div>
            <div className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
              {t('tools.shortlinks.settings.ignore_bots')}
            </div>
            <div className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('tools.shortlinks.settings.ignore_bots_desc')}
            </div>
          </div>
          <input
            type="checkbox"
            checked={ignoreBots}
            onChange={(e) => setIgnoreBots(e.target.checked)}
            className="size-4 rounded accent-[var(--accent)] cursor-pointer"
          />
        </div>

        {/* Self-referrer filter toggle */}
        <div className="pt-2 flex items-center justify-between">
          <div>
            <div className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
              {t('tools.shortlinks.settings.ignore_self')}
            </div>
            <div className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('tools.shortlinks.settings.ignore_self_desc')}
            </div>
          </div>
          <input
            type="checkbox"
            checked={ignoreSelf}
            onChange={(e) => setIgnoreSelf(e.target.checked)}
            className="size-4 rounded accent-[var(--accent)] cursor-pointer"
          />
        </div>

        <div className="pt-3">
          <Button
            variant="primary"
            onClick={handleSaveSettings}
            disabled={savingSettings}
          >
            {t('tools.shortlinks.settings.save')}
          </Button>
        </div>
      </div>

      {/* API Keys Section */}
      <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-6 space-y-5">
        <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] pb-3">
          <Key size={18} className="text-[var(--accent)]" />
          <h3 className="font-semibold text-[length:var(--text-14)] text-[var(--text-primary)]">
            {t('tools.shortlinks.settings.api_keys')}
          </h3>
        </div>

        {/* Create Key Form */}
        <form onSubmit={handleCreateApiKey} className="flex flex-col sm:flex-row items-end gap-3">
          <div className="flex-1 w-full space-y-1">
            <label className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
              {t('tools.shortlinks.settings.key_name')}
            </label>
            <Input
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder={t('tools.shortlinks.settings.key_name_placeholder')}
              required
            />
          </div>

          <div className="w-full sm:w-44 space-y-1">
            <label className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
              {t('tools.shortlinks.settings.key_scope')}
            </label>
            <select
              value={keyScope}
              onChange={(e) => setKeyScope(e.target.value as any)}
              className={`${FIELD_BASE} h-9`}
            >
              <option value="read">{t('tools.shortlinks.settings.scope_read')}</option>
              <option value="write">{t('tools.shortlinks.settings.scope_write')}</option>
              <option value="admin">{t('tools.shortlinks.settings.scope_admin')}</option>
            </select>
          </div>

          <Button
            type="submit"
            variant="secondary"
            disabled={creatingKey || !keyName.trim()}
            className="h-9 shrink-0"
          >
            <Plus size={14} className="mr-1" />
            {t('tools.shortlinks.settings.new_key')}
          </Button>
        </form>

        {/* Generated Key Alert Box */}
        {generatedKey && (
          <div className="rounded-[var(--r-md)] border border-[var(--warning,#ca8a04)] bg-[var(--warning-soft,#fef9c3)] p-4 space-y-2">
            <div className="text-[length:var(--text-12)] font-semibold text-[var(--warning,#a16207)]">
              {t('tools.shortlinks.settings.copy_key_warn')}
            </div>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={generatedKey}
                className={`${FIELD_BASE} h-9 font-mono text-[length:var(--text-12)] bg-white`}
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void copyText(generatedKey)
                  useUiStore.getState().toast(t('tools.shortlinks.links.copied'), 'success')
                }}
              >
                <Copy size={14} className="mr-1" />
                {t('tools.shortlinks.links.copy_shortlink')}
              </Button>
            </div>
          </div>
        )}

        {/* Keys List */}
        <div className="divide-y divide-[var(--border-subtle)] border border-[var(--border-subtle)] rounded-[var(--r-md)] overflow-hidden">
          {apiKeys.length === 0 ? (
            <div className="py-6 text-center text-[var(--text-tertiary)] text-[length:var(--text-12)]">
              {t('tools.shortlinks.dashboard.no_data')}
            </div>
          ) : (
            apiKeys.map((k) => (
              <div
                key={k.id}
                className="p-3.5 flex items-center justify-between gap-4 bg-[var(--bg-base)] text-[length:var(--text-13)]"
              >
                <div>
                  <div className="flex items-center gap-2 font-medium text-[var(--text-primary)]">
                    <span>{k.title}</span>
                    <span className="rounded bg-[var(--accent-soft)] px-1.5 py-0.2 text-[length:var(--text-10)] font-mono text-[var(--accent-on-soft)] uppercase">
                      {k.scope}
                    </span>
                  </div>
                  <div className="font-mono text-[length:var(--text-11)] text-[var(--text-tertiary)] mt-0.5">
                    {k.key_prefix}••••••••
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)] font-mono">
                    {new Date(k.created_at * 1000).toLocaleDateString()}
                  </span>
                  <IconButton
                    label={t('tools.shortlinks.settings.revoke_key')}
                    size="sm"
                    onClick={() => handleRevokeApiKey(k.id, k.title)}
                  >
                    <Trash2 size={13} className="text-[var(--danger)]" />
                  </IconButton>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Data Import, Export & Cloud Backups */}
      <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-6 space-y-5">
        <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] pb-3">
          <Database size={18} className="text-[var(--accent)]" />
          <h3 className="font-semibold text-[length:var(--text-14)] text-[var(--text-primary)]">
            {t('tools.shortlinks.settings.data_management')}
          </h3>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={handleExportTxt}>
            <FileText size={15} className="mr-1.5" />
            {t('tools.shortlinks.settings.export_txt')}
          </Button>
          <Button variant="secondary" onClick={handleExportCsv}>
            <FileSpreadsheet size={15} className="mr-1.5" />
            {t('tools.shortlinks.settings.export_csv')}
          </Button>
          <Button variant="secondary" onClick={() => setImportModalOpen(true)}>
            <Upload size={15} className="mr-1.5" />
            {t('tools.shortlinks.settings.import_data')}
          </Button>
          <Button
            variant="primary"
            onClick={handleCreateBackup}
            disabled={backingUp}
          >
            <Archive size={15} className="mr-1.5" />
            {t('tools.shortlinks.settings.backup_now')}
          </Button>
        </div>

        {/* History Backups */}
        <div className="pt-3 space-y-2">
          <h4 className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
            {t('tools.shortlinks.settings.backups_history')}
          </h4>
          <div className="divide-y divide-[var(--border-subtle)] border border-[var(--border-subtle)] rounded-[var(--r-md)] overflow-hidden">
            {backups.length === 0 ? (
              <div className="py-6 text-center text-[var(--text-tertiary)] text-[length:var(--text-12)]">
                {t('tools.shortlinks.dashboard.no_data')}
              </div>
            ) : (
              backups.map((b) => (
                <div
                  key={b.id}
                  className="p-3 flex items-center justify-between gap-4 bg-[var(--bg-base)] text-[length:var(--text-12)]"
                >
                  <div className="flex items-center gap-2 font-mono text-[var(--text-secondary)]">
                    <Archive size={14} className="text-[var(--accent)]" />
                    <span>{new Date(b.created_at * 1000).toLocaleString()}</span>
                    <span className="text-[var(--text-tertiary)]">
                      {'('}{(b.size / 1024).toFixed(1)}{' KB)'}
                    </span>
                  </div>

                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRestoreBackup(b.id)}
                    className="h-7 px-2 text-[length:var(--text-11)] text-[var(--accent)]"
                  >
                    <RotateCcw size={12} className="mr-1" />
                    {t('tools.shortlinks.settings.restore_backup')}
                  </Button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
