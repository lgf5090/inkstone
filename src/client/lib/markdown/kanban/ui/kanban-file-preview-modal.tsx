import { useEffect, useState } from 'react'
import { Download, ExternalLink, FileText, FileWarning, Loader2 } from 'lucide-react'
import { Button } from '../../../../components/primitives'
import { Modal } from '../../../../components/overlay'
import { t } from '../../../i18n'
import { isCrossOriginUrl } from '../../external-images'
import type { KanbanFile } from '../types'

const PREVIEW_MODAL_WIDTH = 768

/**
 * How long a text attachment is given before the panel admits the read is not coming. A board is a note
 * that may name an object on somebody else's server: without a deadline the spinner is the answer to
 * an unreachable host, and the reader has no way to tell a slow read from a stuck one (there would be
 * no failure state and so no retry either).
 */
export const KANBAN_FILE_READ_TIMEOUT_MS = 10_000

function isPdfFile(file: KanbanFile): boolean {
  return file.mime === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
}

function isTextFile(file: KanbanFile): boolean {
  return (
    file.mime.startsWith('text/') ||
    file.name.toLowerCase().endsWith('.txt') ||
    file.name.toLowerCase().endsWith('.md') ||
    file.name.toLowerCase().endsWith('.json') ||
    file.name.toLowerCase().endsWith('.csv')
  )
}

type ReadState = 'loading' | 'ready' | 'failed' | 'tooLarge'

/**
 * A text preview is a glance, not a download: past this many bytes the panel says so instead of
 * reading on. The cap is what keeps a fence from naming an enormous response and making the tab
 * buffer it whole — the same-host case is already bounded by the upload limit, so this is the
 * cross-origin read's own ceiling.
 */
export const KANBAN_FILE_TEXT_MAX_BYTES = 2_000_000

/** The read hit the size ceiling; retrying cannot help, so the panel does not offer it. */
class TextPreviewTooLargeError extends Error {}

/**
 * Reads the body as text, refusing to buffer more than `maxBytes` of it. A response that declares its
 * size up front is refused before the body is touched; one that does not is read streamingly, so a
 * body beyond the ceiling is dropped as soon as it shows itself.
 */
async function readTextCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers?.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > maxBytes) throw new TextPreviewTooLargeError()
  const reader = res.body?.getReader()
  if (!reader) return await res.text()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxBytes) {
      // A cancel that itself fails changes nothing: the reader is told the size, not the cancel.
      await reader.cancel().catch(() => {})
      throw new TextPreviewTooLargeError()
    }
    chunks.push(value)
  }
  const body = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/**
 * What the reader gets when a read did not produce the document: the reason, and the one action that
 * can still help. Both surfaces below need it, and neither may leave the space blank — a board's
 * attachment can point at an object somebody deleted, and a blank panel reads as "the file is empty"
 * when the truth is "the file is gone".
 */
function ReadFailed({ onRetry }: { onRetry?: () => void }) {
  return (
    <div data-kanban-file-failed className='flex h-[var(--empty-h-md)] flex-col items-center justify-center gap-[var(--sp-2)] p-[var(--sp-6)] text-center'>
      <FileWarning size={24} className='text-[var(--text-tertiary)]' aria-hidden='true' />
      <div className='text-[length:var(--text-13)] font-medium text-[var(--text-primary)]'>
        {t('preview.kanban_file_load_failed')}
      </div>
      <p className='max-w-[38ch] text-[length:var(--text-12)] text-[var(--text-tertiary)]'>
        {t('preview.kanban_file_load_failed_hint')}
      </p>
      {onRetry && (
        <Button variant='secondary' size='sm' onClick={onRetry}>
          {t('preview.kanban_file_retry')}
        </Button>
      )}
    </div>
  )
}

/**
 * The read itself, kept out of the component so the failure path stays one place: a stored object
 * that is gone answers 404 with a body, and reading that body as the file would print the server's
 * error page into the panel and call it the document.
 *
 * The read is cancellable and bounded. Cancellable because the panel closes, the reader switches to
 * another attachment and the retry button starts a second read over the first — a read nobody is
 * waiting for any more must not keep holding a connection, nor write its answer over the file the
 * reader moved on to. Bounded because a host that never answers otherwise leaves a spinner forever:
 * the abort lands in the same `catch` the 404 does, so the reader gets the one action that helps.
 */
function useKanbanTextRead(url: string): { state: ReadState; content: string; retry: () => void } {
  const [content, setContent] = useState<string>('')
  const [state, setState] = useState<ReadState>('loading')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), KANBAN_FILE_READ_TIMEOUT_MS)
    setState('loading')
    fetch(url, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`kanban file read failed: HTTP ${res.status}`)
        return readTextCapped(res, KANBAN_FILE_TEXT_MAX_BYTES)
      })
      .then((text) => {
        if (!active) return
        setContent(text)
        setState('ready')
      })
      .catch((error: unknown) => {
        if (!active) return
        setState(error instanceof TextPreviewTooLargeError ? 'tooLarge' : 'failed')
        console.warn('[inkstone] kanban file preview failed', url, error)
      })
      .finally(() => clearTimeout(deadline))
    return () => {
      active = false
      clearTimeout(deadline)
      controller.abort()
    }
  }, [url, attempt])

  return { state, content, retry: () => setAttempt((current) => current + 1) }
}

function TextFileRead({ url }: { url: string }) {
  const { state, content, retry } = useKanbanTextRead(url)

  if (state === 'loading') {
    return (
      <div className='flex h-[var(--empty-h-sm)] items-center justify-center text-[var(--text-tertiary)]'>
        <Loader2 size={16} className='animate-spin' />
      </div>
    )
  }

  if (state === 'failed') {
    return <ReadFailed onRetry={retry} />
  }

  if (state === 'tooLarge') {
    return (
      <div data-kanban-file-too-large className='flex h-[var(--empty-h-md)] flex-col items-center justify-center gap-[var(--sp-2)] p-[var(--sp-6)] text-center'>
        <FileWarning size={24} className='text-[var(--text-tertiary)]' aria-hidden='true' />
        <div className='text-[length:var(--text-13)] font-medium text-[var(--text-primary)]'>
          {t('preview.kanban_file_too_large', { value1: String(KANBAN_FILE_TEXT_MAX_BYTES / (1024 * 1024)) })}
        </div>
      </div>
    )
  }

  if (content.trim() === '') {
    return (
      <div className='flex h-[var(--empty-h-sm)] items-center justify-center text-[length:var(--text-12)] text-[var(--text-tertiary)]'>
        {t('preview.kanban_file_empty')}
      </div>
    )
  }

  return (
    <div className='max-h-[65vh] overflow-auto p-[var(--sp-4)]'>
      <pre className='whitespace-pre-wrap break-words rounded-[var(--r-md)] bg-[var(--bg-inset)] p-[var(--sp-3)] text-[length:var(--text-12)] font-mono text-[var(--text-primary)]'>
        {content}
      </pre>
    </div>
  )
}

/**
 * An image the reader is allowed to load, which the browser may still fail to fetch — the note can
 * name a file whose object was deleted, which is exactly the state a restored undo leaves behind.
 * Keyed by URL at the call site, so opening another attachment clears the failure instead of showing
 * one file's error over another file's name.
 */
function ImagePreview({ file }: { file: KanbanFile }) {
  const [failed, setFailed] = useState(false)

  if (failed) return <ReadFailed />

  return (
    <div className='flex max-h-[70vh] items-center justify-center overflow-auto p-[var(--sp-4)]'>
      <img
        src={file.url}
        alt={file.name}
        referrerPolicy='no-referrer'
        onError={() => setFailed(true)}
        className='max-h-[65vh] max-w-full rounded-[var(--r-md)] object-contain'
      />
    </div>
  )
}

// CSP sets `object-src 'none'` and `frame-src 'none'`, so any embedded PDF
// document is guaranteed blank; offer the file as an explicit new-tab action.
function fileMetaLabel(file: KanbanFile): string {
  return `${(file.size / 1024).toFixed(1)} KB · ${file.mime}`
}

function PdfPreview({ file }: { file: KanbanFile }) {
  return (
    <div className='flex flex-col items-center justify-center gap-[var(--sp-3)] p-[var(--sp-8)] text-center'>
      <FileText size={28} className='text-[var(--text-tertiary)]' />
      <div className='text-[length:var(--text-14)] font-medium text-[var(--text-primary)]'>{file.name}</div>
      <div className='text-[length:var(--text-12)] text-[var(--text-tertiary)]'>{fileMetaLabel(file)}</div>
      <a
        href={file.url}
        target='_blank'
        rel='noopener noreferrer'
        className='inline-flex items-center gap-1.5 rounded-[var(--r-md)] bg-[var(--accent)] px-[var(--sp-3)] py-1.5 text-[length:var(--text-12)] font-medium text-[var(--accent-contrast)] transition-colors hover:bg-[var(--accent-hover)]'
      >
        <ExternalLink size={13} />
        <span>{t('preview.open_in_new_tab')}</span>
      </a>
    </div>
  )
}

function PreviewContent({ file }: { file: KanbanFile }) {
  const isImage = file.mime.startsWith('image/')
  const isText = isTextFile(file)

  if (isImage) {
    return <ImagePreview key={file.url} file={file} />
  }

  if (isPdfFile(file)) {
    return <PdfPreview file={file} />
  }

  if (isText) {
    return <TextFileRead url={file.url} />
  }

  return (
    <div className='flex flex-col items-center justify-center gap-[var(--sp-3)] p-[var(--sp-8)] text-center'>
      <div className='text-[length:var(--text-14)] font-medium text-[var(--text-primary)]'>{file.name}</div>
      <div className='text-[length:var(--text-12)] text-[var(--text-tertiary)]'>
        {fileMetaLabel(file)}
      </div>
    </div>
  )
}

interface KanbanFilePreviewModalProps {
  file: KanbanFile | null
  onClose: () => void
}

export function KanbanFilePreviewModal({ file, onClose }: KanbanFilePreviewModalProps) {
  if (!file) return null
  // A note can name a file on another origin (an imported board, a pasted URL). `download` means
  // nothing there — browsers ignore it and follow the link — so that link is not offered at all and
  // the new-tab action stands alone; a stored file keeps its download button, where it works.
  const storedHere = !isCrossOriginUrl(file.url)

  return (
    <Modal
      open={Boolean(file)}
      onClose={onClose}
      title={file.name}
      width={PREVIEW_MODAL_WIDTH}
      footer={
        <div className='flex w-full items-center justify-between'>
          <a
            href={file.url}
            target='_blank'
            rel='noopener noreferrer'
            className='inline-flex items-center gap-1.5 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-[var(--sp-3)] py-1.5 text-[length:var(--text-12)] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]'
          >
            <ExternalLink size={14} />
            <span>{t('preview.open_in_new_tab')}</span>
          </a>
          {storedHere && (
            <a
              href={file.url}
              download={file.name}
              className='inline-flex items-center gap-1.5 rounded-[var(--r-md)] bg-[var(--accent)] px-[var(--sp-3)] py-1.5 text-[length:var(--text-12)] font-medium text-[var(--accent-contrast)] transition-opacity hover:opacity-90'
            >
              <Download size={14} />
              <span>{t('preview.kanban_download_file')}</span>
            </a>
          )}
        </div>
      }
    >
      <PreviewContent file={file} />
    </Modal>
  )
}
