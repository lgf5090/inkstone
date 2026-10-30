import { useMemo, useRef, useState } from 'react'
import { Loader2, Upload } from 'lucide-react'
import type { ParsedTable } from '@shared/development/database/types'
import { quoteIdent } from '@shared/development/database/sql-utils'
import { t } from '../../../lib/i18n'
import { Button } from '../../../components/primitives'
import { Checkbox, Input, Segmented } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import { SelectMenu } from '../../../components/select-menu'
import { useUi } from '../../../store/ui'
import type { StudioDriver } from './drivers'
import { inferColumnType, parseCsv, type ParsedCsv } from './csv-parse'
import { insertRowsInChunks } from './transfer-ops'

const MAX_IMPORT_ROWS = 5000

export interface CsvImportDialogProps {
  open: boolean
  table: ParsedTable
  driver: StudioDriver
  ensureWritable?: () => Promise<boolean>
  onClose: () => void
  onImported: () => void
  onSchemaChanged?: () => void
  onError: (message: string) => void
}

export function CsvImportDialog({ open, table, driver, ensureWritable, onClose, onImported, onSchemaChanged, onError }: CsvImportDialogProps) {
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState('')
  const [hasHeader, setHasHeader] = useState(true)
  const [nullText, setNullText] = useState('')
  const [mode, setMode] = useState<'existing' | 'new'>('existing')
  const [newName, setNewName] = useState('')
  const [mapping, setMapping] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const parsed = useMemo<ParsedCsv | null>(() => {
    if (!text) return null
    try {
      return parseCsv(text, { hasHeader })
    } catch {
      return null
    }
  }, [text, hasHeader])

  const targetColumns = table.columns.map((column) => column.name)

  const reset = () => {
    setText('')
    setFileName('')
    setMapping([])
    setProgress(null)
    setHasHeader(true)
    setNullText('')
    setMode('existing')
    setNewName('')
  }

  const chooseFile = async (file: File | null) => {
    if (!file) return
    setFileName(file.name)
    setText(await file.text())
    setMapping([])
  }

  const effectiveMapping = useMemo(() => {
    if (!parsed) return []
    if (mode === 'new') return parsed.headers.map((header) => header)
    return parsed.headers.map((header, index) => {
      const chosen = mapping[index]
      if (chosen !== undefined) return chosen
      return targetColumns.includes(header) ? header : ''
    })
  }, [mapping, mode, parsed, targetColumns])

  const run = async () => {
    if (!parsed || running) return
    if (parsed.rows.length > MAX_IMPORT_ROWS) {
      onError(t('development.database.import.too_many', { max: MAX_IMPORT_ROWS }))
      return
    }
    const targets = effectiveMapping.filter(Boolean)
    if (targets.length === 0) {
      onError(t('development.database.import.no_columns'))
      return
    }
    if (mode === 'new' && !newName.trim()) {
      onError(t('development.database.import.new_name_required'))
      return
    }
    if (ensureWritable && !(await ensureWritable())) return
    setRunning(true)
    const targetTable = mode === 'new' ? newName.trim() : table.name
    try {
      if (mode === 'new') {
        const columns = parsed.headers.map((header, index) => {
          const values = parsed.rows.map((row) => row[index] ?? '')
          return `${quoteIdent(header)} ${inferColumnType(values)}`
        })
        await driver.query(`CREATE TABLE ${quoteIdent(targetTable)} (${columns.join(', ')})`)
      }
      const indexes = effectiveMapping.map((target, index) => target ? index : -1).filter((index) => index >= 0)
      const rows = parsed.rows.map((row) => indexes.map((sourceIndex) => {
        const value = row[sourceIndex] ?? ''
        return nullText !== '' && value === nullText ? null : value
      }))
      const outcome = await insertRowsInChunks(driver, targetTable, targets, rows, (done) => {
        setProgress({ done, total: rows.length })
      })
      const done = outcome.inserted
      const failed = outcome.failed
      useUi.getState().toast({
        title: t('development.database.import.done', { count: done }),
        ...(failed > 0 ? { description: t('development.database.import.failed', { count: failed }), tone: 'warning' as const } : { tone: 'success' as const }),
      })
      if (mode === 'new') onSchemaChanged?.()
      onImported()
      reset()
      onClose()
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => { if (!running) onClose() }}
      title={t('development.database.import.title', { table: table.name })}
      description={t('development.database.import.hint', { max: MAX_IMPORT_ROWS })}
      width={620}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={running}>{t('development.database.common.cancel')}</Button>
          <Button size="sm" onClick={() => void run()} disabled={!parsed || running || parsed.rows.length === 0}>
            {running && <Loader2 size={13} className="animate-spin" />}
            {t('development.database.import.run')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => fileInput.current?.click()} disabled={running}>
            <Upload size={13} />
            {t('development.database.import.choose_file')}
          </Button>
          <span className="min-w-0 flex-1 truncate text-[length:var(--text-11)] text-[var(--text-secondary)]">{fileName || t('development.database.import.no_file')}</span>
          <input ref={fileInput} type="file" accept=".csv,.tsv,.txt" className="hidden" onChange={(event) => void chooseFile(event.target.files?.[0] ?? null)} />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Checkbox checked={hasHeader} onChange={setHasHeader} ariaLabel={t('development.database.import.has_header')} />
          <span className="text-[length:var(--text-11)] text-[var(--text-secondary)]">{t('development.database.import.has_header')}</span>
          <span className="text-[length:var(--text-11)] text-[var(--text-secondary)]">{t('development.database.import.null_text')}</span>
          <Input value={nullText} onChange={(event) => setNullText(event.target.value)} className="h-7 w-24 text-[length:var(--text-11)]" />
          <Segmented
            value={mode}
            onChange={setMode}
            label={t('development.database.import.mode')}
            options={[
              { value: 'existing', label: t('development.database.import.mode_existing') },
              { value: 'new', label: t('development.database.import.mode_new') },
            ]}
          />
        </div>

        {mode === 'new' && (
          <label className="flex items-center gap-2">
            <span className="text-[length:var(--text-11)] text-[var(--text-secondary)]">{t('development.database.import.new_name')}</span>
            <Input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="imported_table" className="h-8 max-w-64" />
          </label>
        )}

        {parsed && (
          <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)]">
            <div className="flex items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              <span>{t('development.database.import.preview', { rows: parsed.rows.length, columns: parsed.headers.length })}</span>
              <span>{t('development.database.import.delimiter', { delimiter: parsed.delimiter === '\t' ? 'TAB' : parsed.delimiter })}</span>
            </div>
            <div className="max-h-64 overflow-auto">
              <table className="w-full border-collapse text-[length:var(--text-11)]">
                <thead className="sticky top-0 bg-[var(--bg-sunken)] text-left text-[var(--text-tertiary)]">
                  <tr>
                    {parsed.headers.map((header, index) => (
                      <th key={`${header}-${index}`} className="min-w-32 px-2 py-1 font-medium">
                        <span className="mb-1 block truncate font-mono text-[var(--text-primary)]">{header}</span>
                        {mode === 'existing' ? (
                          <SelectMenu
                            label={`${header} →`}
                            value={effectiveMapping[index] ?? ''}
                            options={[{ value: '', label: t('development.database.import.skip') }, ...targetColumns.map((column) => ({ value: column, label: column }))]}
                            onChange={(value) => setMapping((current) => {
                              const next = [...current]
                              next[index] = value
                              return next
                            })}
                            width={180}
                            size="sm"
                          />
                        ) : (
                          <span className="block text-[length:var(--text-11)] text-[var(--text-quaternary)]">{inferColumnType(parsed.rows.map((row) => row[index] ?? ''))}</span>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {parsed.rows.slice(0, 6).map((row, rowIndex) => (
                    <tr key={rowIndex} className="border-t border-[var(--border-subtle)]">
                      {parsed.headers.map((_, columnIndex) => (
                        <td key={columnIndex} className="max-w-40 truncate px-2 py-1 font-mono text-[var(--text-secondary)]" title={row[columnIndex] ?? ''}>{row[columnIndex] ?? ''}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {progress && (
          <div className="flex items-center gap-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]" role="status">
            <Loader2 size={12} className="animate-spin" />
            {t('development.database.import.progress', { done: progress.done, total: progress.total })}
          </div>
        )}
      </div>
    </Modal>
  )
}
