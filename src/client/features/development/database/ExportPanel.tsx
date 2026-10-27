import { useEffect, useRef, useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import type { ExportFormat } from '@shared/development/database/types'
import { t } from '../../../lib/i18n'
import { copyText } from '../../../lib/clipboard'
import { useUi } from '../../../store/ui'
import { Button } from '../../../components/primitives'
import { Input, Segmented } from '../../../components/form'
import { ToolbarPanel } from './ToolbarPanel'
import { createExport, fetchExportBlob } from './api'
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
  } catch {
    return DEFAULTS
  }
}

function parseEscapes(value: string): string {
  return value.replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
}

export interface ExportPanelProps {
  columns: string[]
  rows: unknown[][]
  tableName: string
  selectedRows: Set<number>
}

export function ExportPanel({ columns, rows, tableName, selectedRows }: ExportPanelProps) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [settings, setSettings] = useState<ExportSettings>(loadSettings)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch {
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

  const run = async () => {
    if (selected.length === 0) {
      useUi.getState().toast({ title: t('development.database.export.no_data'), tone: 'warning' })
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
        } catch (error) {
          downloadBlob(filename, new Blob([text], { type: `${exportMimeType(formatForServer)};charset=utf-8` }))
          useUi.getState().toast({
            title: t('development.database.export.local_fallback'),
            description: error instanceof Error ? error.message : String(error),
            tone: 'warning',
          })
        }
        useUi.getState().toast({ title: t('development.database.export.downloaded', { count: selected.length }), tone: 'success' })
      }
      setOpen(false)
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
          <div className="flex justify-end gap-2 border-t border-[var(--border-subtle)] pt-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>{t('development.database.common.cancel')}</Button>
            <Button size="sm" onClick={() => void run()} disabled={busy || selected.length === 0}>
              {busy && <Loader2 size={13} className="animate-spin" />}
              {t('development.database.export.export')}
            </Button>
          </div>
        </div>
      </ToolbarPanel>
    </>
  )
}
