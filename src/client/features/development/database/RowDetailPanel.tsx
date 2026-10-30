import { useEffect, useMemo, useState } from 'react'
import { Download, Eye, Loader2, Pencil, Save, X } from 'lucide-react'
import { INKSTONE_BLOB_KEY } from '@shared/development/database/types'
import { t } from '../../../lib/i18n'
import { Button, IconButton } from '../../../components/primitives'
import { Input } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import { RowJsonTree } from './RowJsonTree'
import { blobBytes, blobFileName, hexDump, imageSource } from './blob-view'
import { downloadBlob } from './export-utils'

type DetailExtra =
  | { column: string; kind: 'blob'; bytes: Uint8Array }
  | { column: string; kind: 'image'; src: string }

export interface RowDetailPanelProps {
  columns: string[]
  row: unknown[]
  title: string
  editable?: boolean
  readOnlyColumns?: Set<string>
  onSave?: (values: Record<string, string>) => Promise<void> | void
  onClose: () => void
}

function displayValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return `[BLOB ${value.byteLength} bytes]`
  if (value && typeof value === 'object' && INKSTONE_BLOB_KEY in value) return '[BLOB]'
  return value
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function ImageThumb({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.database.detail.image_failed')}</p>
  return <img src={src} alt={alt} onError={() => setFailed(true)} className="max-h-32 rounded-[var(--r-sm)] border border-[var(--border-subtle)] object-contain" />
}

function parseJsonString(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!text.startsWith('{') && !text.startsWith('[')) return value
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' ? parsed : value
  } catch {
    return value
  }
}

export function RowDetailPanel({
  columns,
  row,
  title,
  editable = false,
  readOnlyColumns,
  onSave,
  onClose,
}: RowDetailPanelProps) {
  const [editing, setEditing] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [hexView, setHexView] = useState<{ column: string; bytes: Uint8Array } | null>(null)

  useEffect(() => {
    setEditing(false)
    const next: Record<string, string> = {}
    columns.forEach((column, index) => {
      const value = row[index]
      next[column] = value === null || value === undefined ? '' : String(value)
    })
    setValues(next)
  }, [row, columns])

  const data = useMemo(() => {
    const object: Record<string, unknown> = {}
    columns.forEach((column, index) => {
      object[column] = displayValue(parseJsonString(row[index] ?? null))
    })
    return object
  }, [columns, row])

  const extras = useMemo<DetailExtra[]>(() => {
    const out: DetailExtra[] = []
    columns.forEach((column, index) => {
      const raw = row[index]
      const bytes = blobBytes(raw)
      if (bytes) {
        out.push({ column, kind: 'blob', bytes })
        return
      }
      const src = imageSource(raw)
      if (src) out.push({ column, kind: 'image', src })
    })
    return out
  }, [columns, row])

  const save = async () => {
    if (!onSave) return
    setSaving(true)
    try {
      await onSave(values)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full w-full flex-col border-l border-[var(--border-subtle)] bg-[var(--bg-base)] shadow-[var(--shadow-pop)]">
      <header className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] px-2">
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{title}</span>
        {editable && !editing && (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            <Pencil size={12} />
            {t('development.database.detail.edit')}
          </Button>
        )}
        <IconButton label={t('development.database.detail.close')} size="sm" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </header>

      {editing ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          <div className="space-y-2">
            {columns.map((column) => {
              const readOnly = readOnlyColumns?.has(column)
              return (
                <label key={column} className="grid grid-cols-[minmax(80px,1fr)_2fr] items-center gap-2">
                  <span className="truncate text-[length:var(--text-11)] text-[var(--text-secondary)]" title={column}>
                    {column}
                  </span>
                  <Input
                    value={values[column] ?? ''}
                    disabled={readOnly}
                    placeholder={t('development.database.detail.null_placeholder')}
                    onChange={(event) => setValues((current) => ({ ...current, [column]: event.target.value }))}
                    className="h-8 text-[length:var(--text-12)]"
                  />
                </label>
              )
            })}
          </div>
          <div className="sticky bottom-0 mt-3 flex gap-1.5 bg-[var(--bg-base)] pt-1">
            <Button variant="secondary" size="sm" className="h-8 flex-1" onClick={() => setEditing(false)}>
              {t('development.database.detail.cancel')}
            </Button>
            <Button size="sm" className="h-8 flex-1" onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              {t('development.database.detail.save')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          {extras.length > 0 && (
            <div className="shrink-0 space-y-2 border-b border-[var(--border-subtle)] p-2">
              {extras.map((extra) => (
                <div key={extra.column} className="space-y-1">
                  <div className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-11)] text-[var(--text-secondary)]" title={extra.column}>{extra.column}</span>
                    {extra.kind === 'blob' ? (
                      <>
                        <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.database.detail.blob_size', { size: formatBytes(extra.bytes.length) })}</span>
                        <Button variant="ghost" size="sm" onClick={() => setHexView({ column: extra.column, bytes: extra.bytes })}>
                          <Eye size={12} />
                          {t('development.database.detail.hex')}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => downloadBlob(blobFileName(extra.column, extra.bytes), new Blob([new Uint8Array(extra.bytes)], { type: 'application/octet-stream' }))}>
                          <Download size={12} />
                          {t('development.database.detail.download')}
                        </Button>
                      </>
                    ) : (
                      <a className="shrink-0 text-[length:var(--text-11)] text-[var(--accent)] underline" href={extra.src} target="_blank" rel="noopener noreferrer">{t('development.database.detail.open_image')}</a>
                    )}
                  </div>
                  {extra.kind === 'image' && <ImageThumb src={extra.src} alt={extra.column} />}
                </div>
              ))}
            </div>
          )}
          <RowJsonTree data={data} className="min-h-0 flex-1" />
        </>
      )}

      <Modal
        open={hexView !== null}
        onClose={() => setHexView(null)}
        title={t('development.database.detail.hex_title', { column: hexView?.column ?? '' })}
        width={600}
        footer={<Button variant="ghost" size="sm" onClick={() => setHexView(null)}>{t('development.database.common.cancel')}</Button>}
      >
        {hexView && (() => {
          const dump = hexDump(hexView.bytes)
          return (
            <div className="space-y-1">
              <pre className="max-h-80 overflow-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2 font-mono text-[length:var(--text-11)] leading-relaxed text-[var(--text-secondary)]">{dump.text || '—'}</pre>
              {dump.truncated && <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.database.detail.hex_truncated')}</p>}
            </div>
          )
        })()}
      </Modal>
    </div>
  )
}
