/**
 * The composer's attachment row and the transcript's chips.
 *
 * A queued file is shown as a thumbnail or a named chip with a byte counter, because an upload that
 * only appears when it finishes reads as a dropped click. The same rows do double duty in the reader's
 * own bubble, where the file is already stored and the counter is gone.
 *
 * Pressing a chip opens it: a picture goes to the app's lightbox, a text file to a viewer that reads
 * the bytes back with its own progress bar. The X removes it — and deletes the upload, since a file the
 * reader took back out of the box should not stay in their storage.
 */
import { useEffect, useState } from 'react'
import { FileText, Image as ImageIcon, Loader, X } from 'lucide-react'
import type { ChatAttachment } from '@shared/assistant'
import type { PendingAttachment } from './assistant-store'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { Modal } from '../../components/overlay'
import { useUi } from '../../store/ui'

export function attachmentUrl(id: string): string {
  return api.assistant.chatFileUrl(id)
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function ChipFrame({ children, onOpen, label }: { children: React.ReactNode, onOpen: () => void, label: string }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={label}
      aria-label={label}
      className="relative flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] transition-colors hover:border-[var(--border-strong)]"
    >
      {children}
    </button>
  )
}

function ProgressBar({ value, failed }: { value: number, failed?: boolean }) {
  return (
    <span
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      className={cn(
        'pointer-events-none absolute inset-x-1 bottom-1 h-[3px] overflow-hidden rounded-full bg-[var(--bg-inset)]',
        failed && 'opacity-70',
      )}
    >
      <span
        className={cn('block h-full rounded-full transition-[width] duration-150', failed ? 'bg-[var(--danger)]' : 'bg-[var(--accent)]')}
        style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }}
      />
    </span>
  )
}

export function AttachmentStrip({
  items,
  onRemove,
}: {
  items: PendingAttachment[]
  onRemove: (localId: string) => void
}) {
  const setLightbox = useUi((state) => state.setLightbox)
  const [viewing, setViewing] = useState<ChatAttachment | null>(null)
  if (!items.length) return null
  return (
    <div className="flex flex-wrap gap-1.5 px-1.5 pb-1.5 pt-1">
      {items.map((entry) => {
        const ready = entry.status === 'ready' && entry.id
        const label = entry.status === 'uploading'
          ? t('assistant.attach.uploading', { percent: Math.round(entry.progress * 100) })
          : entry.status === 'error' ? entry.error ?? t('assistant.attach.failed') : `${entry.filename} · ${formatSize(entry.size)}`
        return (
          <span key={entry.localId} className="relative">
            <ChipFrame
              label={t('assistant.attach.view', { name: entry.filename })}
              onOpen={() => {
                if (!ready) return
                if (entry.kind === 'image') setLightbox({ src: attachmentUrl(entry.id), alt: entry.filename })
                else setViewing({ id: entry.id, kind: entry.kind, filename: entry.filename, mime: entry.mime, size: entry.size, key: '', createdAt: 0 })
              }}
            >
              {entry.kind === 'image' && ready ? (
                <img src={attachmentUrl(entry.id)} alt="" className="size-full object-cover" />
              ) : entry.kind === 'image' ? (
                <ImageIcon size={18} className="text-[var(--text-quaternary)]" />
              ) : (
                <span className="flex h-full w-full flex-col items-center justify-center gap-0.5 px-1">
                  <FileText size={16} className="shrink-0 text-[var(--text-tertiary)]" />
                  <span className="w-full truncate text-center text-[9.5px] text-[var(--text-tertiary)]">{entry.filename}</span>
                </span>
              )}
              {entry.status !== 'ready' && <ProgressBar value={entry.progress} failed={entry.status === 'error'} />}
              {entry.status === 'uploading' && (
                <Loader size={12} className="absolute right-1 top-1 animate-spin text-[var(--text-tertiary)]" />
              )}
            </ChipFrame>
            <button
              type="button"
              onClick={() => onRemove(entry.localId)}
              aria-label={t('assistant.attach.remove', { name: entry.filename })}
              className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--bg-overlay)] text-[var(--text-tertiary)] hover:text-[var(--danger)]"
            >
              <X size={9} />
            </button>
            <span className="sr-only">{label}</span>
          </span>
        )
      })}
      {viewing && <AttachmentViewer attachment={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}

/**
 * The whole file, on request.
 *
 * The bytes are read back with a counter rather than handed to the browser as a link, because the
 * reader asked to *see* it: a download that lands in the shelf answers a question nobody asked.
 */
export function AttachmentViewer({ attachment, onClose }: { attachment: ChatAttachment, onClose: () => void }) {
  const [text, setText] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void api.assistant.downloadChatFile(attachment.id, (received, total) => {
      if (!cancelled && total > 0) setProgress(received / total)
    }).then(async (blob) => {
      if (cancelled) return
      setProgress(1)
      setText(await blob.text())
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => {
      cancelled = true
    }
  }, [attachment.id])

  return (
    <Modal
      open
      onClose={onClose}
      title={attachment.filename}
      description={`${attachment.mime || 'file'} · ${formatSize(attachment.size)}`}
      width={720}
      bodyClassName="p-0"
      footer={(
        <a
          href={`${attachmentUrl(attachment.id)}?download=1`}
          className="inline-flex h-8 items-center gap-1.5 rounded-[var(--r-sm)] border border-[var(--border-default)] px-2.5 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
        >
          {t('assistant.attach.download')}
        </a>
      )}
    >
      <div className="h-0.5 w-full bg-[var(--bg-inset)]">
        <div className="h-full bg-[var(--accent)] transition-[width] duration-150" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      {error ? (
        <p className="p-4 text-[12.5px] text-[var(--danger)]">{error}</p>
      ) : text === null ? (
        <p className="p-4 text-[12.5px] text-[var(--text-quaternary)]">{t('common.loading')}</p>
      ) : (
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[12px] leading-relaxed text-[var(--text-primary)]">
          {text}
        </pre>
      )}
    </Modal>
  )
}

/** The chips inside a stored turn: the same rows, without a counter or an X. */
export function MessageAttachments({ ids, index }: { ids: string[], index: Record<string, ChatAttachment> }) {
  const setLightbox = useUi((state) => state.setLightbox)
  const [viewing, setViewing] = useState<ChatAttachment | null>(null)
  const rows = ids.map((id) => index[id]).filter((row): row is ChatAttachment => Boolean(row))
  if (!rows.length) return null
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          onClick={() => {
            if (row.kind === 'image') setLightbox({ src: attachmentUrl(row.id), alt: row.filename })
            else setViewing(row)
          }}
          aria-label={t('assistant.attach.view', { name: row.filename })}
          title={t('assistant.attach.view', { name: row.filename })}
          className="inline-flex max-w-[220px] items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-1.5 py-[2px] text-[11px] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
        >
          {row.kind === 'image'
            ? <img src={attachmentUrl(row.id)} alt="" className="size-4 shrink-0 rounded-[2px] object-cover" />
            : <FileText size={12} className="shrink-0" />}
          <span className="min-w-0 truncate">{row.filename}</span>
        </button>
      ))}
      {viewing && <AttachmentViewer attachment={viewing} onClose={() => setViewing(null)} />}
    </span>
  )
}
