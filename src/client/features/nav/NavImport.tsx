import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, FileUp } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { exportBookmarkHtml, parseBookmarkHtml } from '@shared/nav/bookmark'
import { NAV_LIMITS } from '@shared/nav/model'
import { Modal } from '../../components/overlay'
import { Button } from '../../components/primitives'
import { Checkbox } from '../../components/form'
import { t } from '../../lib/i18n'
import { downloadTextFile } from '../../lib/export-note'
import { useUi } from '../../store/ui'
import { navApi } from './api'
import { useNavStore } from './nav-store'

const MAX_IMPORT_BYTES = 10 * 1024 * 1024
const IMPORT_CHUNK = NAV_LIMITS.importLinksPerRequest
const IMPORT_WIDTH = 560
const QR_WIDTH = 360
const QR_SIZE = 220

type ImportStatus = 'idle' | 'reading' | 'importing' | 'done' | 'error'

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : t('nav.error.generic')
}

function isBookmarkFile(file: File): boolean {
  const name = file.name.toLowerCase()
  return name.endsWith('.html') || name.endsWith('.htm')
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
  const [skipExisting, setSkipExisting] = useState(true)
  const [status, setStatus] = useState<ImportStatus>('idle')
  const [fileName, setFileName] = useState('')
  const [counts, setCounts] = useState({ imported: 0, skipped: 0 })

  useEffect(() => {
    if (!open) return
    setStatus('idle')
    setFileName('')
    setCounts({ imported: 0, skipped: 0 })
    if (fileRef.current) fileRef.current.value = ''
  }, [open])

  const busy = status === 'reading' || status === 'importing'
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
      <div className="flex flex-col gap-4">
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
