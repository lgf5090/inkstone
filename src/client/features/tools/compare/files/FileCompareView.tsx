/**
 * Two files compared as files.
 *
 * The verdict is the hash: equal bytes are the same file whatever their names, and different bytes
 * are different files however similar they read. When both sides decode as text the screen offers the
 * text comparison, which is where the interesting part of a code file change actually lives.
 */
import { useCallback, useRef, useState } from 'react'
import { FileText, Hash, Image as ImageIcon, Upload, X } from 'lucide-react'
import type { TextEncoding } from '@shared/tools/compare/encoding'
import { ASSET_LIMITS } from '@shared/tools/compare/types'
import { Button, IconButton } from '../../../../components/primitives'
import { Tooltip } from '../../../../components/overlay'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { compareApi } from '../api'
import { useCompareStore, type CompareSide } from '../store'
import { SaveDialog } from '../components/SaveDialog'
import { decodeFile, fileLooksBinary, sha256Hex, UnreadableTextError } from '../lib/files'
import { detectEncoding } from '@shared/tools/compare/encoding'

interface FileSide {
  file: File
  sha256: string
  binary: boolean
  text: string | null
  encoding: TextEncoding | null
}

export function FileCompareView({ onOpenText, onOpenImage }: { onOpenText: () => void, onOpenImage: () => void }) {
  const [left, setLeft] = useState<FileSide | null>(null)
  const [right, setRight] = useState<FileSide | null>(null)
  const [busy, setBusy] = useState<'left' | 'right' | null>(null)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const loadSides = useCompareStore((s) => s.loadSides)

  const read = useCallback(async (side: 'left' | 'right', file: File) => {
    setBusy(side)
    try {
      if (file.size > ASSET_LIMITS.binary) throw new Error('too-large')
      const bytes = new Uint8Array(await file.arrayBuffer())
      const sha256 = await sha256Hex(bytes)
      const detected = detectEncoding(bytes.subarray(0, 64 * 1024))
      // A UTF-16 file is full of null bytes and would look binary to the heuristic; the detection
      // above runs first so a wide-encoded text file still opens as text.
      const binary = !detected.encoding && await fileLooksBinary(file)
      const encoding = detected.encoding
      let text: string | null = null
      if (!binary && encoding) {
        try {
          text = (await decodeFile(file, encoding)).text
        } catch (error) {
          if (!(error instanceof UnreadableTextError)) throw error
        }
      }
      const value: FileSide = { file, sha256, binary, text, encoding }
      if (side === 'left') setLeft(value)
      else setRight(value)
    } catch (error) {
      useUi.getState().toast({
        title: error instanceof Error && error.message === 'too-large' ? t('tools.compare.text.file_too_large') : t('tools.compare.files.read_failed'),
        tone: 'danger',
      })
    } finally {
      setBusy(null)
    }
  }, [])

  const openText = () => {
    if (!left?.text || !right?.text) return
    loadSides(
      { text: left.text, name: left.file.name, bytes: left.file.size, encoding: left.encoding } as CompareSide,
      { text: right.text, name: right.file.name, bytes: right.file.size, encoding: right.encoding } as CompareSide,
      undefined,
      'text',
    )
    onOpenText()
  }

  const save = async (name: string) => {
    if (!left || !right) return
    setSaving(true)
    try {
      const [leftAsset, rightAsset] = await Promise.all([
        compareApi.uploadAsset('binary', left.file),
        compareApi.uploadAsset('binary', right.file),
      ])
      await compareApi.createProject({
        name,
        kind: 'binary',
        left_label: left.file.name,
        right_label: right.file.name,
        summary: { binary: { same: left.sha256 === right.sha256, leftSize: left.file.size, rightSize: right.file.size } },
        left_asset_id: leftAsset.id,
        right_asset_id: rightAsset.id,
      })
      useUi.getState().toast({ title: t('tools.compare.save.saved'), tone: 'success' })
      setSaveOpen(false)
    } catch {
      useUi.getState().toast({ title: t('tools.compare.save.failed'), tone: 'danger' })
    } finally {
      setSaving(false)
    }
  }

  const both = left && right
  const identical = both && left.sha256 === right.sha256
  const canText = Boolean(left?.text && right?.text)
  const canImage = Boolean(left && right && left.file.type.startsWith('image/') && right.file.type.startsWith('image/'))

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-3 overflow-y-auto p-3 sm:p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">{t('tools.compare.files.title')}</h2>
          <p className="mt-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('tools.compare.files.desc')}</p>
        </div>
        <Button size="sm" variant="secondary" disabled={!both} onClick={() => setSaveOpen(true)}>
          {t('tools.compare.save.open')}
        </Button>
      </header>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <FileCard
          label={t('tools.compare.text.left')}
          side={left}
          busy={busy === 'left'}
          onFile={(file) => void read('left', file)}
          onClear={() => setLeft(null)}
        />
        <FileCard
          label={t('tools.compare.text.right')}
          side={right}
          busy={busy === 'right'}
          onFile={(file) => void read('right', file)}
          onClear={() => setRight(null)}
        />
      </div>

      {both ? (
        <section className="flex flex-col gap-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                'rounded-full border px-2 py-0.5 text-[length:var(--text-12)] font-medium',
                identical
                  ? 'border-[var(--success)]/40 bg-[var(--success)]/10 text-[var(--success)]'
                  : 'border-[var(--danger)]/40 bg-[var(--danger)]/10 text-[var(--danger)]',
              )}
            >
              {identical ? t('tools.compare.files.identical') : t('tools.compare.files.different')}
            </span>
            <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('tools.compare.files.size_delta', {
                left: formatBytes(left.file.size),
                right: formatBytes(right.file.size),
              })}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {canText && (
              <Button size="sm" variant="secondary" onClick={openText}>
                <span className="flex items-center gap-1"><FileText size={13} aria-hidden="true" />{t('tools.compare.files.open_as_text')}</span>
              </Button>
            )}
            {canImage && (
              <Button size="sm" variant="secondary" onClick={onOpenImage}>
                <span className="flex items-center gap-1"><ImageIcon size={13} aria-hidden="true" />{t('tools.compare.files.open_as_image')}</span>
              </Button>
            )}
          </div>
          {!canText && (
            <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('tools.compare.files.binary_note')}</p>
          )}
        </section>
      ) : (
        <p className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {t('tools.compare.files.need_both')}
        </p>
      )}

      <SaveDialog
        open={saveOpen}
        defaultName={left && right ? `${left.file.name} ↔ ${right.file.name}` : t('tools.compare.save.default_name')}
        busy={saving}
        onClose={() => setSaveOpen(false)}
        onSave={(name) => void save(name)}
      />
    </div>
  )
}

function FileCard({ label, side, busy, onFile, onClear }: {
  label: string
  side: FileSide | null
  busy?: boolean
  onFile: (file: File) => void
  onClear: () => void
}) {
  const [over, setOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <section
      aria-label={label}
      onDragOver={(event) => {
        event.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault()
        setOver(false)
        const file = event.dataTransfer.files?.[0]
        if (file) onFile(file)
      }}
      className={cn(
        'flex flex-col gap-2 rounded-[var(--r-md)] border-2 border-dashed p-3 transition-colors',
        over ? 'border-[var(--accent)] bg-[var(--bg-hover)]' : 'border-[var(--border-subtle)] bg-[var(--bg-sunken)]',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{label}</h3>
        {side && (
          <Tooltip label={t('tools.compare.text.clear')}>
            <IconButton size="sm" label={t('tools.compare.text.clear')} onClick={onClear}><X size={13} /></IconButton>
          </Tooltip>
        )}
      </div>
      {side ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[length:var(--text-11)]">
          <dt className="text-[var(--text-tertiary)]">{t('tools.compare.files.name')}</dt>
          <dd className="truncate font-mono text-[var(--text-secondary)]" title={side.file.name}>{side.file.name}</dd>
          <dt className="text-[var(--text-tertiary)]">{t('tools.compare.files.size')}</dt>
          <dd className="font-mono text-[var(--text-secondary)]">{formatBytes(side.file.size)}</dd>
          <dt className="text-[var(--text-tertiary)]">{t('tools.compare.files.type')}</dt>
          <dd className="truncate text-[var(--text-secondary)]">{side.encoding ?? (side.binary ? t('tools.compare.files.binary') : '—')}</dd>
          <dt className="flex items-center gap-1 text-[var(--text-tertiary)]"><Hash size={11} aria-hidden="true" />{'sha256'}</dt>
          <dd className="truncate font-mono text-[var(--text-secondary)]" title={side.sha256}>{side.sha256.slice(0, 24)}…</dd>
        </dl>
      ) : (
        <>
          <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('tools.compare.files.hint')}</p>
          <Button size="sm" variant="secondary" loading={busy} onClick={() => inputRef.current?.click()}>
            <span className="flex items-center gap-1"><Upload size={13} aria-hidden="true" />{t('tools.compare.text.import_file')}</span>
          </Button>
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            aria-label={label}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) onFile(file)
              event.target.value = ''
            }}
          />
        </>
      )}
    </section>
  )
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}
