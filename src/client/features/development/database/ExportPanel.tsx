import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import type { DatabaseExportFile, ExportFormat } from '@shared/development/database/types'
import { t } from '../../../lib/i18n'
import { copyText } from '../../../lib/clipboard'
import { useUi } from '../../../store/ui'
import { Button, IconButton } from '../../../components/primitives'
import { Input, Segmented } from '../../../components/form'
import { ToolbarPanel } from './ToolbarPanel'
import { createExport, deleteExport, fetchExportBlob, listExports } from './api'
import { downloadBlob, exportMimeType, toCsv, toDelimited, toInsertSql, toJson } from './export-utils'

type UiFormat = 'csv' | 'delimited' | 'json' | 'sql'
type Target = 'clipboard' | 'file'
type Scope = 'all' | 'selected'

interface ExportSettings {
  format: UiFormat
  target: Target
  scope: Scope
  delimiter: string
  lineTerminator: string
  encloser: string
  nullText: string
}

const STORAGE_KEY = 'inkstone.development.database.export'

const DEFAULTS: ExportSettings = {
  format: 'csv',
  target: 'clipboard',
  scope: 'all',
  delimiter: ',',
  lineTerminator: '\\r\\n',
  encloser: '"',
  nullText: 'NULL',
}

function loadSettings(): ExportSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<ExportSettings>) } : DEFAULTS
  } catch (error) {
    console.warn('[inkstone] Development database export preferences could not be read:', error)
    return DEFAULTS
  }
}

function parseEscapes(value: string): string {
  return value.replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export interface ExportPanelProps {
  columns: string[]
  rows: unknown[][]
  tableName: string
  selectedRows: Set<number>
  truncated?: boolean
}

export function ExportPanel({ columns, rows, tableName, selectedRows, truncated = false }: ExportPanelProps) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [settings, setSettings] = useState<ExportSettings>(loadSettings)
  const [busy, setBusy] = useState(false)
  const [recent, setRecent] = useState<DatabaseExportFile[]>([])
  const [recentLoading, setRecentLoading] = useState(false)
  const [recentError, setRecentError] = useState<string | null>(null)

  const refreshRecent = useCallback(async () => {
    setRecentLoading(true)
    try {
      setRecent(await listExports())
      setRecentError(null)
    } catch (error) {
      setRecentError(error instanceof Error ? error.message : String(error))
    } finally {
      setRecentLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void refreshRecent()
  }, [open, refreshRecent])

  const downloadRecent = async (file: DatabaseExportFile) => {
    try {
      downloadBlob(file.filename, await fetchExportBlob(file.id))
    } catch (error) {
      useUi.getState().toast({
        title: t('development.database.export.download_failed'),
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      })
    }
  }

  const removeRecent = async (file: DatabaseExportFile) => {
    try {
      await deleteExport(file.id)
      setRecent((current) => current.filter((entry) => entry.id !== file.id))
      useUi.getState().toast({ title: t('development.database.export.deleted'), tone: 'success' })
    } catch (error) {
      useUi.getState().toast({
        title: t('development.database.export.delete_failed'),
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      })
    }
  }

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch (error) {
      console.warn('[inkstone] Development database export preferences could not be saved:', error)
    }
  }, [settings])

  const selected = settings.scope === 'selected'
    ? [...selectedRows].sort((left, right) => left - right).map((index) => rows[index]).filter((row): row is unknown[] => Boolean(row))
    : rows

  const content = (): string => {
    if (settings.format === 'json') return toJson(columns, selected)
    if (settings.format === 'sql') return toInsertSql(tableName || 'data', columns, selected)
    if (settings.format === 'delimited') {
      return toDelimited(columns, selected, {
        delimiter: parseEscapes(settings.delimiter),
        lineTerminator: parseEscapes(settings.lineTerminator),
        encloser: settings.encloser,
        nullText: settings.nullText,
      })
    }
    return toCsv(columns, selected, {
      lineTerminator: parseEscapes(settings.lineTerminator),
      encloser: settings.encloser,
      nullText: settings.nullText,
    })
  }

  const extension = settings.format === 'delimited' ? 'csv' : settings.format
  const filename = `${tableName || 'query_result'}.${extension}`
  const formatForServer: ExportFormat = settings.format === 'delimited' ? 'csv' : settings.format

  const invalidSettings = (settings.format === 'csv' || settings.format === 'delimited')
    && (!parseEscapes(settings.delimiter) || !parseEscapes(settings.lineTerminator) || settings.encloser.length !== 1)

  const run = async () => {
    if (selected.length === 0) {
      useUi.getState().toast({ title: t('development.database.export.no_data'), tone: 'warning' })
      return
    }
    if (invalidSettings) {
      useUi.getState().toast({ title: t('development.database.export.invalid_settings'), tone: 'danger' })
      return
    }
    setBusy(true)
    try {
      const text = content()
      if (settings.target === 'clipboard') {
        const ok = await copyText(text)
        useUi.getState().toast({
          title: ok ? t('development.database.export.copied', { count: selected.length }) : t('development.database.common.copy_failed'),
          tone: ok ? 'success' : 'danger',
        })
      } else {
        try {
          const created = await createExport({ format: formatForServer, filename, content: text })
          const blob = await fetchExportBlob(created.id)
          downloadBlob(filename, blob)
          useUi.getState().toast({ title: t('development.database.export.downloaded', { count: selected.length }), tone: 'success' })
          void refreshRecent()
        } catch (error) {
          downloadBlob(filename, new Blob([text], { type: `${exportMimeType(formatForServer)};charset=utf-8` }))
          useUi.getState().toast({
            title: t('development.database.export.local_fallback'),
            description: error instanceof Error ? error.message : String(error),
            tone: 'warning',
          })
        }
      }
      setOpen(false)
    } catch (error) {
      useUi.getState().toast({
        title: t('development.database.export.failed'),
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      })
    } finally {
      setBusy(false)
    }
  }

  const set = <K extends keyof ExportSettings>(key: K, value: ExportSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }))
  }

  return (
    <>
      <Button ref={anchor} variant="secondary" size="sm" onClick={() => setOpen((value) => !value)} aria-haspopup="dialog" aria-expanded={open}>
        <Download size={14} />
        {t('development.database.export.button')}
      </Button>
      <ToolbarPanel open={open} onClose={() => setOpen(false)} anchor={anchor} label={t('development.database.export.title')} width={380}>
        <h3 className="mb-3 text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">{t('development.database.export.title')}</h3>
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.database.export.format')}</div>
            <Segmented
              value={settings.format}
              onChange={(value) => set('format', value)}
              label={t('development.database.export.format')}
              options={[
                { value: 'csv', label: 'CSV' },
                { value: 'delimited', label: t('development.database.export.delimited') },
                { value: 'json', label: 'JSON' },
                { value: 'sql', label: 'SQL' },
              ]}
            />
          </div>
          <div>
            <div className="mb-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.database.export.scope')}</div>
            <Segmented
              value={settings.scope}
              onChange={(value) => set('scope', value)}
              label={t('development.database.export.scope')}
              options={[
                { value: 'all', label: t('development.database.export.all_rows', { count: rows.length }) },
                { value: 'selected', label: t('development.database.export.selected_rows', { count: selectedRows.size }) },
              ]}
            />
          </div>
          <div>
            <div className="mb-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.database.export.target')}</div>
            <Segmented
              value={settings.target}
              onChange={(value) => set('target', value)}
              label={t('development.database.export.target')}
              options={[
                { value: 'clipboard', label: t('development.database.export.clipboard') },
                { value: 'file', label: t('development.database.export.file') },
              ]}
            />
          </div>
          {(settings.format === 'csv' || settings.format === 'delimited') && (
            <div className="grid grid-cols-2 gap-2">
              {([
                ['delimiter', t('development.database.export.delimiter')],
                ['lineTerminator', t('development.database.export.line_terminator')],
                ['encloser', t('development.database.export.encloser')],
                ['nullText', t('development.database.export.null_value')],
              ] as const).map(([key, label]) => (
                <label key={key} className="block">
                  <span className="mb-0.5 block text-[length:var(--text-10)] text-[var(--text-tertiary)]">{label}</span>
                  <Input
                    value={settings[key]}
                    onChange={(event) => set(key, event.target.value)}
                    className="h-7 font-mono text-[length:var(--text-11)]"
                  />
                </label>
              ))}
            </div>
          )}
          {invalidSettings && (
            <p role="alert" className="rounded-[var(--r-md)] border border-[var(--danger)]/30 bg-[var(--danger-soft)] p-2 text-[length:var(--text-10)] leading-relaxed text-[var(--danger)]">
              {t('development.database.export.invalid_settings')}
            </p>
          )}
          {truncated && (
            <p className="rounded-[var(--r-md)] border border-[var(--warning)]/30 bg-[var(--warning-soft)] p-2 text-[length:var(--text-10)] leading-relaxed text-[var(--warning)]">
              {t('development.database.export.truncated_note')}
            </p>
          )}
          <div className="border-t border-[var(--border-subtle)] pt-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.database.export.recent')}</span>
              <IconButton label={t('development.database.export.refresh')} size="xs" onClick={() => void refreshRecent()} disabled={recentLoading}>
                <RefreshCw size={12} />
              </IconButton>
            </div>
            {recentError ? (
              <p role="alert" className="rounded-[var(--r-md)] border border-[var(--danger)]/30 bg-[var(--danger-soft)] p-2 text-[length:var(--text-10)] leading-relaxed text-[var(--danger)]">
                {recentError}
              </p>
            ) : recent.length === 0 ? (
              <p className="py-1 text-[length:var(--text-10)] text-[var(--text-tertiary)]">
                {recentLoading ? t('development.database.export.loading') : t('development.database.export.recent_empty')}
              </p>
            ) : (
              <ul className="max-h-40 overflow-y-auto">
                {recent.map((file) => (
                  <li key={file.id} className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-[length:var(--text-11)] text-[var(--text-secondary)]" title={file.filename}>{file.filename}</span>
                    <span className="shrink-0 text-[length:var(--text-10)] text-[var(--text-quaternary)]">{formatSize(file.size)}</span>
                    <IconButton label={t('development.database.export.download')} size="xs" onClick={() => void downloadRecent(file)}>
                      <Download size={11} />
                    </IconButton>
                    <IconButton label={t('development.database.export.delete')} size="xs" onClick={() => void removeRecent(file)}>
                      <Trash2 size={11} />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t border-[var(--border-subtle)] pt-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>{t('development.database.common.cancel')}</Button>
            <Button size="sm" onClick={() => void run()} disabled={busy || selected.length === 0 || invalidSettings}>
              {busy && <Loader2 size={13} className="animate-spin" />}
              {t('development.database.export.export')}
            </Button>
          </div>
        </div>
      </ToolbarPanel>
    </>
  )
}
