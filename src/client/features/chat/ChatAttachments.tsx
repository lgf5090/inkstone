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
 *
 * Two sentences are drawn here rather than hidden, because both are worth knowing before something is
 * paid for. A recording or a clip cannot reach a model at all, so the row says that in words the moment it
 * appears — a `title` is not read before a click, and the click is the turn.
 */
import { useEffect, useState } from 'react'
import { FileText, Image as ImageIcon, Loader, RotateCcw, X } from 'lucide-react'
import { attachmentModality, type AssistantModelModality, type ChatAttachment } from '@shared/assistant'
import type { PendingAttachment } from './assistant-store'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { Modal } from '../../components/overlay'
import { useUi } from '../../store/ui'

export function attachmentUrl(id: string): string {
  return api.assistant.chatFileUrl(id)
}

/** What a reader calls the two senses a model would need, in their own language. */
const MODALITY_LABEL_KEYS: Record<AssistantModelModality, Parameters<typeof t>[0]> = {
  audio: 'assistant.model.modality.audio',
  video: 'assistant.model.modality.video',
}

/**
 * What a picker may hand back, as one list the composer's file and folder inputs both point at.
 *
 * A turn can only use a file it can read: a picture it sees, text the worker decodes into the prompt, and a
 * PDF whose words the browser extracts before uploading. Anything else arrives as bytes the model is merely
 * told the name of, so an unfiltered picker offers a choice the turn cannot keep — and a folder picked
 * without a filter uploads every thumbnail and lock file beside the document. The list is the worker's own
 * textual set plus images and PDFs, kept here rather than at each call site so the two pickers cannot
 * drift apart from each other or from what the server actually reads.
 *
 * A filter is not an answer, though: a file that comes in through a door with none — dragged onto the box,
 * pasted, named by an address — is told to the reader in the row below, not quietly left out of the list.
 */
export const CHAT_ATTACHMENT_ACCEPT = [
  'image/*',
  'text/*',
  'application/pdf',
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/x-csv',
  'application/csv',
  'application/javascript',
  'application/typescript',
  'application/x-sh',
  'application/markdown',
  'application/toml',
  '.md', '.markdown', '.txt', '.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml', '.toml',
  '.ts', '.tsx', '.js', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp',
  '.sh', '.sql', '.css', '.html', '.htm', '.xml', '.ini', '.conf', '.log', '.srt', '.vtt', '.pdf',
].join(',')

/**
 * The folder picker's directory attributes, typed once instead of cast at the call site.
 *
 * React's own JSX types stop at the standard attributes, so `webkitdirectory` has nowhere to go — spread
 * from a typed object rather than through `as Record<string, string>`, which tells the compiler to stop
 * checking the element entirely.
 */
export const CHAT_FOLDER_PICKER_ATTRS: { webkitdirectory: string, directory: string } = {
  webkitdirectory: '',
  directory: '',
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
  onRetry,
}: {
  items: PendingAttachment[]
  onRemove: (localId: string) => void
  /** Tries a failed upload again with the file the browser still holds; absent where there is none. */
  onRetry?: (localId: string) => void
}) {
  const setLightbox = useUi((state) => state.setLightbox)
  const [viewing, setViewing] = useState<ChatAttachment | null>(null)
  // A thumbnail that will not load is said with the picture glyph rather than left as a browser's broken
  // image: the file is still there and still removable, and a torn icon claims nothing about either.
  const [brokenThumb, setBrokenThumb] = useState<Record<string, boolean>>({})
  if (!items.length) return null
  return (
    <div className="flex flex-wrap gap-1.5 px-1.5 pb-1.5 pt-1">
      {items.map((entry) => {
        const ready = entry.status === 'ready' && entry.id
        // Whether any model could be handed these bytes is known the moment the name and the type are, which
        // is before the reader decides to press send — and the row is the only place that gets to say it.
        const modality = attachmentModality(entry.mime, entry.filename)
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
              {entry.kind === 'image' && ready && !brokenThumb[entry.localId] ? (
                <img
                  src={attachmentUrl(entry.id)}
                  alt=""
                  className="size-full object-cover"
                  onError={() => setBrokenThumb((current) => ({ ...current, [entry.localId]: true }))}
                />
              ) : entry.kind === 'image' ? (
                <ImageIcon size={18} className="text-[var(--text-quaternary)]" />
              ) : (
                <span className="flex h-full w-full flex-col items-center justify-center gap-0.5 px-1">
                  <FileText size={16} className="shrink-0 text-[var(--text-tertiary)]" />
                  <span className="w-full truncate text-center text-[length:var(--text-9-5)] text-[var(--text-tertiary)]">{entry.filename}</span>
                </span>
              )}
              {entry.status !== 'ready' && <ProgressBar value={entry.progress} failed={entry.status === 'error'} />}
              {entry.status === 'uploading' && (
                <Loader size={12} className="absolute right-1 top-1 animate-spin text-[var(--text-tertiary)]" />
              )}
            </ChipFrame>
            {entry.status === 'error' && onRetry && (
              <button
                type="button"
                onClick={() => onRetry(entry.localId)}
                aria-label={t('assistant.attach.retry', { name: entry.filename })}
                className="ink-tap-pad absolute -left-1 -top-1 flex size-4 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--bg-overlay)] text-[var(--text-tertiary)] hover:text-[var(--accent)]"
              >
                <RotateCcw size={9} />
              </button>
            )}
            <button
              type="button"
              onClick={() => onRemove(entry.localId)}
              aria-label={t('assistant.attach.remove', { name: entry.filename })}
              className="ink-tap-pad absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--bg-overlay)] text-[var(--text-tertiary)] hover:text-[var(--danger)]"
            >
              <X size={9} />
            </button>
            <span className="sr-only">{label}</span>
            {modality && (
              <span
                data-attachment-unreadable="true"
                className="mt-1 block max-w-[240px] text-[length:var(--text-11)] leading-snug text-[var(--danger)]"
              >
                {t('assistant.attach.unreadable', { kind: t(MODALITY_LABEL_KEYS[modality]), name: entry.filename })}
              </span>
            )}
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
 *
 * A recording and a clip are not shown, and not fetched to be shown: decoding their bytes as text is how a
 * three-minute voice note used to land as a wall of replacement characters, which claims a reading the panel
 * cannot do. They are told what they are, and the download in the footer is left as the door that still
 * works.
 */
export function AttachmentViewer({ attachment, onClose }: { attachment: ChatAttachment, onClose: () => void }) {
  const modality = attachmentModality(attachment.mime, attachment.filename)
  const [text, setText] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Nothing to read back: the panel already said so, and the byte counter would only be a bar over a box
    // that will never hold anything.
    if (modality) return
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
  }, [attachment.id, modality])

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
          className="inline-flex h-8 items-center gap-1.5 rounded-[var(--r-sm)] border border-[var(--border-default)] px-2.5 text-[length:var(--text-12)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
        >
          {t('assistant.attach.download')}
        </a>
      )}
    >
      <div className="h-0.5 w-full bg-[var(--bg-inset)]">
        <div className="h-full bg-[var(--accent)] transition-[width] duration-150" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      {modality ? (
        <p data-attachment-unreadable="true" className="p-4 text-[length:var(--text-12-5)] text-[var(--text-secondary)]">
          {t('assistant.attach.unreadable_view', { kind: t(MODALITY_LABEL_KEYS[modality]) })}
        </p>
      ) : error ? (
        <p className="p-4 text-[length:var(--text-12-5)] text-[var(--danger)]">{error}</p>
      ) : text === null ? (
        <p className="p-4 text-[length:var(--text-12-5)] text-[var(--text-quaternary)]">{t('common.loading')}</p>
      ) : (
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[length:var(--text-12)] leading-relaxed text-[var(--text-primary)]">
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
  // An attachment the row says it carried but this app cannot show stays on screen and says so. Dropping
  // the id was the old reading, and it dropped the row with it: a turn that once carried a picture then
  // rendered as though nothing had ever been attached, which leaves the reader no way to tell a deleted
  // file from a thread that never had one.
  const [brokenBytes, setBrokenBytes] = useState<Record<string, boolean>>({})
  if (!ids.length) return null
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {ids.map((id) => {
        const row = index[id]
        if (!row || brokenBytes[id]) return <AttachmentGap key={id} name={row?.filename} />
        return (
          <button
            key={row.id}
            type="button"
            onClick={() => {
              if (row.kind === 'image') setLightbox({ src: attachmentUrl(row.id), alt: row.filename })
              else setViewing(row)
            }}
            aria-label={t('assistant.attach.view', { name: row.filename })}
            title={t('assistant.attach.view', { name: row.filename })}
            className="inline-flex max-w-[220px] items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-1.5 py-[2px] text-[length:var(--text-11)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
          >
            {row.kind === 'image'
              ? (
                <img
                  src={attachmentUrl(row.id)}
                  alt=""
                  className="size-4 shrink-0 rounded-[2px] object-cover"
                  onError={() => setBrokenBytes((current) => ({ ...current, [id]: true }))}
                />
              )
              : <FileText size={12} className="shrink-0" />}
            <span className="min-w-0 truncate">{row.filename}</span>
          </button>
        )
      })}
      {viewing && <AttachmentViewer attachment={viewing} onClose={() => setViewing(null)} />}
    </span>
  )
}

/**
 * The trace a carried attachment leaves when its bytes are gone.
 *
 * Not a button: there is nothing to open, and a control that answers a press with nothing is the failure
 * this row exists to avoid repeating. The name is kept where it is known, because a reader with three
 * chips needs to know which one is missing.
 */
function AttachmentGap({ name }: { name?: string }) {
  return (
    <span
      data-attachment-unavailable="true"
      className="inline-flex max-w-[240px] items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-1.5 py-[2px] text-[length:var(--text-11)] text-[var(--text-tertiary)]"
    >
      <FileText size={12} className="shrink-0 text-[var(--text-quaternary)]" />
      {name && <span className="min-w-0 truncate">{name}</span>}
      <span className="min-w-0 truncate">{t('assistant.attach.unavailable')}</span>
    </span>
  )
}
