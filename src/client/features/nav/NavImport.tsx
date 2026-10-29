import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, FileJson, FileUp } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { exportBookmarkHtml, parseBookmarkHtml } from '@shared/nav/bookmark'
import { parseCloudNavBackup, type CloudNavParseResult } from '@shared/nav/cloudnav'
import { NavBackupSchema } from '@shared/nav/validation'
import { NAV_LIMITS, type NavBackup } from '@shared/nav/model'
import { Modal, confirm } from '../../components/overlay'
import { Button } from '../../components/primitives'
import { Checkbox } from '../../components/form'
import { t } from '../../lib/i18n'
import { downloadTextFile } from '../../lib/export-note'
import { cn } from '../../lib/cn'
import { useUi } from '../../store/ui'
import { navApi } from './api'
import { useNavStore } from './nav-store'

const MAX_IMPORT_BYTES = 10 * 1024 * 1024
const MAX_JSON_BYTES = NAV_LIMITS.restoreBytes
const IMPORT_CHUNK = NAV_LIMITS.importLinksPerRequest
const IMPORT_WIDTH = 560
const QR_WIDTH = 360
const QR_SIZE = 220

type ImportStatus = 'idle' | 'reading' | 'importing' | 'done' | 'error'
type JsonStatus = 'idle' | 'reading' | 'importing' | 'done' | 'error'
type JsonPreview =
  | { kind: 'inkstone'; backup: NavBackup }
  | { kind: 'cloudnav'; parsed: CloudNavParseResult }

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : t('nav.error.generic')
}

function isBookmarkFile(file: File): boolean {
  const name = file.name.toLowerCase()
  return name.endsWith('.html') || name.endsWith('.htm')
}

function isJsonFile(file: File): boolean {
  return file.name.toLowerCase().endsWith('.json')
}

function absoluteUrl(raw: string): string {
  if (!raw || typeof window === 'undefined') return raw
  try {
    return new URL(raw, window.location.origin).href
  } catch {
    // Nothing to resolve against: the panel still shows exactly what it was handed.
    return raw
  }
}

/**
 * Netscape bookmark import and export.
 *
 * Import is chunked so a large file never becomes one oversized request and the progress line stays
 * truthful between chunks; export walks the same format so a file this app writes can be read back by
 * this app or by a browser.
 */
export function ImportExportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const links = useNavStore((state) => state.links)
  const categories = useNavStore((state) => state.categories)
  const toast = useUi((state) => state.toast)
  const fileRef = useRef<HTMLInputElement>(null)
  const jsonRef = useRef<HTMLInputElement>(null)
  const [skipExisting, setSkipExisting] = useState(true)
  const [skipExistingJson, setSkipExistingJson] = useState(false)
  const [status, setStatus] = useState<ImportStatus>('idle')
  const [fileName, setFileName] = useState('')
  const [counts, setCounts] = useState({ imported: 0, skipped: 0 })
  const [jsonStatus, setJsonStatus] = useState<JsonStatus>('idle')
  const [jsonPreview, setJsonPreview] = useState<JsonPreview | null>(null)
  const [jsonFileName, setJsonFileName] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [jsonCounts, setJsonCounts] = useState({ imported: 0, skipped: 0 })
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (!open) return
    setStatus('idle')
    setFileName('')
    setCounts({ imported: 0, skipped: 0 })
    setJsonStatus('idle')
    setJsonPreview(null)
    setJsonFileName('')
    setJsonError(null)
    setJsonCounts({ imported: 0, skipped: 0 })
    setDragging(false)
    if (fileRef.current) fileRef.current.value = ''
    if (jsonRef.current) jsonRef.current.value = ''
  }, [open])

  const busy = status === 'reading' || status === 'importing' || jsonStatus === 'reading' || jsonStatus === 'importing'
  const lockedCount = useMemo(
    () => categories.filter((category) => category.hasPassword).length,
    [categories],
  )

  async function importFile(file: File): Promise<void> {
    if (!isBookmarkFile(file)) {
      toast({ title: t('nav.error.bad_request'), tone: 'danger' })
      return
    }
    if (file.size > MAX_IMPORT_BYTES) {
      toast({ title: t('nav.error.too_large'), tone: 'danger' })
      return
    }
    setFileName(file.name)
    setCounts({ imported: 0, skipped: 0 })
    setStatus('reading')
    let text: string
    try {
      text = await file.text()
    } catch (error) {
      setStatus('error')
      toast({ title: errorMessage(error), tone: 'danger' })
      return
    }
    let parsed: ReturnType<typeof parseBookmarkHtml>
    try {
      parsed = parseBookmarkHtml(text, { uncategorizedName: t('nav.uncategorized') })
    } catch (error) {
      setStatus('error')
      toast({ title: errorMessage(error), tone: 'danger' })
      return
    }
    if (!parsed.links.length) {
      setStatus('done')
      setCounts({ imported: 0, skipped: parsed.skipped })
      toast({
        title: t('nav.import.progress', { imported: 0, skipped: parsed.skipped }),
        tone: 'warning',
      })
      return
    }
    setStatus('importing')
    let imported = 0
    // Entries the parser had to drop (unsupported schemes, malformed hrefs) count as skipped too.
    let skipped = parsed.skipped
    setCounts({ imported, skipped })
    try {
      for (let index = 0; index < parsed.links.length; index += IMPORT_CHUNK) {
        const chunk = parsed.links.slice(index, index + IMPORT_CHUNK)
        const result = await navApi.importBookmarks({
          categories: index === 0 ? parsed.categories : [],
          links: chunk,
          skipExisting,
        })
        imported += result.imported
        skipped += result.skipped
        setCounts({ imported, skipped })
      }
      setStatus('done')
      toast({
        title: t('nav.import.done'),
        description: t('nav.import.progress', { imported, skipped }),
        tone: 'success',
      })
      useNavStore.getState().selectCategory(null)
      await useNavStore.getState().load(true)
    } catch (error) {
      setStatus('error')
      toast({ title: errorMessage(error), tone: 'danger' })
    }
  }

  function resetJson(): void {
    setJsonStatus('idle')
    setJsonPreview(null)
    setJsonFileName('')
    setJsonError(null)
    setJsonCounts({ imported: 0, skipped: 0 })
    if (jsonRef.current) jsonRef.current.value = ''
  }

  async function previewJson(file: File): Promise<void> {
    if (busy) return
    if (file.size > MAX_JSON_BYTES) {
      toast({ title: t('nav.error.too_large'), tone: 'danger' })
      return
    }
    setJsonStatus('reading')
    setJsonPreview(null)
    setJsonFileName(file.name)
    setJsonError(null)
    setJsonCounts({ imported: 0, skipped: 0 })
    let raw: unknown
    try {
      raw = JSON.parse(await file.text())
    } catch {
      setJsonStatus('error')
      setJsonError(t('nav.json.invalid'))
      return
    }
    const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null
    if (record?.format === 'inkstone-nav-backup') {
      const parsed = NavBackupSchema.safeParse(record)
      if (!parsed.success) {
        setJsonStatus('error')
        setJsonError(t('nav.json.invalid'))
        return
      }
      setJsonPreview({ kind: 'inkstone', backup: parsed.data as NavBackup })
      setJsonStatus('idle')
      return
    }
    if (record && record.format === undefined && Array.isArray(record.categories) && Array.isArray(record.links)) {
      try {
        setJsonPreview({ kind: 'cloudnav', parsed: parseCloudNavBackup(record, { uncategorizedName: t('nav.uncategorized') }) })
        setJsonStatus('idle')
      } catch {
        setJsonStatus('error')
        setJsonError(t('nav.json.invalid'))
      }
      return
    }
    setJsonStatus('error')
    setJsonError(t('nav.json.invalid'))
  }

  async function exportJson(): Promise<void> {
    setJsonStatus('reading')
    setJsonError(null)
    try {
      const backup = await navApi.exportBackup()
      const stamp = new Date().toISOString().slice(0, 19).replace('T', '-').replace(/:/g, '-')
      downloadTextFile(`inkstone-nav-backup-${stamp}.json`, JSON.stringify(backup, null, 2), 'application/json;charset=utf-8')
      setJsonStatus('idle')
      toast({ title: t('nav.export.done'), tone: 'success' })
    } catch (error) {
      setJsonStatus('error')
      setJsonError(errorMessage(error))
    }
  }

  async function restoreInkstone(backup: NavBackup): Promise<void> {
    const confirmed = await confirm({
      title: t('nav.json.replace_confirm'),
      description: t('nav.json.replace_hint', { categories: backup.categories.length, links: backup.links.length }),
      confirmLabel: t('nav.json.replace'),
      tone: 'danger',
    })
    if (!confirmed) return
    setJsonStatus('importing')
    setJsonError(null)
    try {
      const result = await navApi.restoreBackup(backup)
      setJsonStatus('done')
      setJsonPreview(null)
      toast({
        title: t('nav.json.restore_done'),
        description: result.unlockedCategoryNames.length
          ? t('nav.json.unlocked', { names: result.unlockedCategoryNames.join(', ') })
          : t('nav.json.restore_progress', { categories: result.restoredCategories, links: result.restoredLinks }),
        tone: 'success',
      })
      useNavStore.getState().selectCategory(null)
      await useNavStore.getState().load(true)
    } catch (error) {
      setJsonStatus('error')
      setJsonError(errorMessage(error))
    }
  }

  async function importCloudNav(parsed: CloudNavParseResult): Promise<void> {
    if (!parsed.links.length) {
      setJsonError(t('nav.json.empty'))
      return
    }
    setJsonStatus('importing')
    setJsonError(null)
    let imported = 0
    let skipped = parsed.stats.skippedLinks
    setJsonCounts({ imported, skipped })
    try {
      for (let index = 0; index < parsed.links.length; index += IMPORT_CHUNK) {
        const chunk = parsed.links.slice(index, index + IMPORT_CHUNK)
        const result = await navApi.importBookmarks({
          categories: index === 0 ? parsed.categories : [],
          links: chunk,
          skipExisting: skipExistingJson,
        })
        imported += result.imported
        skipped += result.skipped
        setJsonCounts({ imported, skipped })
      }
      setJsonStatus('done')
      setJsonPreview(null)
      toast({
        title: t('nav.import.done'),
        description: t('nav.import.progress', { imported, skipped }),
        tone: 'success',
      })
      useNavStore.getState().selectCategory(null)
      await useNavStore.getState().load(true)
    } catch (error) {
      setJsonStatus('error')
      setJsonError(errorMessage(error))
    }
  }

  function cloudNavWarnings(parsed: CloudNavParseResult): string[] {
    const warnings: string[] = []
    if (parsed.stats.passwordsSkipped) warnings.push(t('nav.json.warn_passwords', { count: parsed.stats.passwordsSkipped }))
    if (parsed.stats.repairedUrls) warnings.push(t('nav.json.warn_repaired', { count: parsed.stats.repairedUrls }))
    if (parsed.stats.invalidUrls) warnings.push(t('nav.json.warn_invalid', { count: parsed.stats.invalidUrls }))
    if (parsed.stats.duplicateUrls) warnings.push(t('nav.json.warn_duplicates', { count: parsed.stats.duplicateUrls }))
    if (parsed.stats.orphanLinks) warnings.push(t('nav.json.warn_orphans', { count: parsed.stats.orphanLinks }))
    if (parsed.stats.flattenedCategories) warnings.push(t('nav.json.warn_flattened', { count: parsed.stats.flattenedCategories }))
    if (parsed.stats.iconFallbacks) warnings.push(t('nav.json.warn_icons', { count: parsed.stats.iconFallbacks }))
    return warnings
  }

  function handleFile(file: File): void {
    if (busy) return
    if (isBookmarkFile(file)) void importFile(file)
    else if (isJsonFile(file)) void previewJson(file)
    else toast({ title: t('nav.error.bad_request'), tone: 'danger' })
  }

  function exportAll(): void {
    try {
      const html = exportBookmarkHtml(links, categories, {
        origin: window.location.origin,
        uncategorizedName: t('nav.uncategorized'),
      })
      downloadTextFile('bookmarks.html', html, 'text/html;charset=utf-8')
      toast({ title: t('nav.export.done'), tone: 'success' })
    } catch (error) {
      toast({ title: errorMessage(error), tone: 'danger' })
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('nav.import.title')}
      width={IMPORT_WIDTH}
      dismissible={!busy}
      footer={
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          {t('nav.close')}
        </Button>
      }
    >
      <div
        className={cn('flex flex-col gap-4 rounded-[var(--r-lg)]', dragging && 'outline outline-2 outline-offset-4 outline-[var(--accent)]')}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          const file = event.dataTransfer.files[0]
          if (file) handleFile(file)
        }}
      >
        <section className="flex flex-col gap-3 rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-3">
          <div>
            <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('nav.json.title')}</h3>
            <p className="mt-1 text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">{t('nav.json.hint')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              icon={<Download size={13} />}
              loading={jsonStatus === 'reading'}
              disabled={busy}
              onClick={() => void exportJson()}
            >
              {t('nav.json.export')}
            </Button>
            <Button
              variant="secondary"
              icon={<FileJson size={13} />}
              disabled={busy}
              onClick={() => jsonRef.current?.click()}
            >
              {t('nav.json.import')}
            </Button>
            <input
              ref={jsonRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              tabIndex={-1}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void previewJson(file)
                event.target.value = ''
              }}
            />
          </div>
          <p className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('nav.json.drop')}</p>
          {jsonPreview && (
            <div className="flex flex-col gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-2.5">
              <p className="min-w-0 truncate text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{jsonFileName}</p>
              {jsonPreview.kind === 'inkstone' ? (
                <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
                  {t('nav.json.preview_inkstone', {
                    categories: jsonPreview.backup.categories.length,
                    links: jsonPreview.backup.links.length,
                    visits: Object.keys(jsonPreview.backup.visits ?? {}).length,
                  })}
                </p>
              ) : (
                <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
                  {t('nav.json.preview_cloudnav', {
                    categories: jsonPreview.parsed.stats.categories,
                    links: jsonPreview.parsed.stats.links,
                  })}
                </p>
              )}
              <ul className="flex flex-col gap-1 text-[length:var(--text-11-5)] leading-relaxed text-[var(--warning)]">
                {jsonPreview.kind === 'inkstone' ? (
                  <>
                    <li>{t('nav.json.replace_warning')}</li>
                    {jsonPreview.backup.categories.some((category) => category.hasPassword) && (
                      <li>{t('nav.json.warn_locked', { count: jsonPreview.backup.categories.filter((category) => category.hasPassword).length })}</li>
                    )}
                  </>
                ) : (
                  cloudNavWarnings(jsonPreview.parsed).map((warning) => <li key={warning}>{warning}</li>)
                )}
              </ul>
              {jsonPreview.kind === 'cloudnav' && (
                <Checkbox
                  checked={skipExistingJson}
                  onChange={setSkipExistingJson}
                  label={t('nav.json.skip_existing')}
                  disabled={busy}
                />
              )}
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="ghost" onClick={resetJson} disabled={busy}>
                  {t('nav.cancel')}
                </Button>
                {jsonPreview.kind === 'inkstone' ? (
                  <Button variant="primary" disabled={busy} onClick={() => void restoreInkstone(jsonPreview.backup)}>
                    {t('nav.json.replace')}
                  </Button>
                ) : (
                  <Button variant="primary" disabled={busy} onClick={() => void importCloudNav(jsonPreview.parsed)}>
                    {t('nav.json.merge')}
                  </Button>
                )}
              </div>
            </div>
          )}
          {jsonStatus === 'importing' && (
            <p role="status" className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
              {jsonPreview?.kind === 'cloudnav'
                ? t('nav.import.progress', { imported: jsonCounts.imported, skipped: jsonCounts.skipped })
                : t('nav.json.importing')}
            </p>
          )}
          {jsonStatus === 'done' && (
            <p role="status" className="text-[length:var(--text-12)] text-[var(--success)]">{t('nav.json.restore_done')}</p>
          )}
          {jsonError && (
            <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{jsonError}</p>
          )}
        </section>

        <section className="flex flex-col gap-3 rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-3">
          <p className="text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">
            {t('nav.import.hint')}
          </p>
          <Checkbox
            checked={skipExisting}
            onChange={setSkipExisting}
            label={t('nav.import.skip_existing')}
            disabled={busy}
          />
          <input
            ref={fileRef}
            type="file"
            accept=".html,.htm,text/html"
            className="hidden"
            tabIndex={-1}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void importFile(file)
              event.target.value = ''
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              icon={<FileUp size={13} />}
              loading={busy}
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              {t('nav.import.choose')}
            </Button>
            {fileName && (
              <span className="min-w-0 max-w-full truncate text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
                {fileName}
              </span>
            )}
          </div>
          {(status === 'importing' || status === 'done') && (
            <p role="status" className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
              {t('nav.import.progress', { imported: counts.imported, skipped: counts.skipped })}
            </p>
          )}
          {status === 'error' && (
            <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">
              {t('nav.import.failed')}
            </p>
          )}
        </section>

        <section className="flex flex-col gap-2 border-t border-[var(--border-subtle)] pt-3">
          <Button icon={<Download size={13} />} disabled={busy} onClick={exportAll}>
            {t('nav.export')}
          </Button>
          {lockedCount > 0 && (
            <p className="text-[length:var(--text-11-5)] leading-relaxed text-[var(--warning)]">
              {t('nav.import.locked_hint', { count: lockedCount })}
            </p>
          )}
        </section>
      </div>
    </Modal>
  )
}

/**
 * The link as a code a phone camera can read. The plate stays white in both themes, because a dark
 * frame would cut into the quiet zone the scanner needs around the code.
 */
export function QrModal({ open, onClose, url, title }: {
  open: boolean
  onClose: () => void
  url: string
  title: string
}) {
  const value = useMemo(() => absoluteUrl(url), [url])
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('nav.qr.title')}
      description={title || t('nav.uncategorized')}
      width={QR_WIDTH}
    >
      <div className="flex flex-col items-center gap-3 py-2">
        <div className="rounded-[var(--r-xl)] border border-[var(--border-default)] bg-white p-4 shadow-[var(--shadow-soft)]">
          <QRCodeSVG
            value={value}
            size={QR_SIZE}
            level="M"
            marginSize={1}
            title={title || t('nav.qr.title')}
          />
        </div>
        <p className="max-w-full break-all text-center font-mono text-[length:var(--text-12)] text-[var(--text-secondary)]">
          {value}
        </p>
        <p className="max-w-xs text-center text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
          {t('nav.qr.hint')}
        </p>
      </div>
    </Modal>
  )
}
