/**
 * The files linked to one saved task.
 *
 * The task route owns upload validation and the link rows; this shelf only asks for those links,
 * refreshes after the shared upload helper finishes, and removes one link at a time. Preview and
 * download use the same file-preview modal and stored-file URL as the attachment hub.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, File as FileIcon, Paperclip, Unlink, Upload } from 'lucide-react'
import type { Attachment } from '@shared/types'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { formatBytes } from '../../lib/time'
import { useUi } from '../../store/ui'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { FilePreviewModal, type FilePreviewTarget } from '../file-preview'
import { attachFilesToTask } from './task-attachments'

type AttachmentState =
  | { status: 'loading' }
  | { status: 'ready', attachments: Attachment[] }
  | { status: 'error', message: string }

const EMPTY_PREVIEW: FilePreviewTarget = { url: '', filename: '', mime: '' }

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

export function TaskAttachments({ taskId }: { taskId: string }) {
  const [state, setState] = useState<AttachmentState>({ status: 'loading' })
  const [uploading, setUploading] = useState(false)
  const [detachingId, setDetachingId] = useState<string | null>(null)
  const [preview, setPreview] = useState<FilePreviewTarget | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  const loadVersion = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const version = ++loadVersion.current
    setState({ status: 'loading' })
    try {
      const answer = await api.todos.attachments(taskId)
      if (mounted.current && version === loadVersion.current) {
        setState({ status: 'ready', attachments: answer.attachments })
      }
    } catch (error) {
      if (mounted.current && version === loadVersion.current) {
        setState({ status: 'error', message: errorMessage(error) })
      }
    }
  }, [taskId])

  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
      loadVersion.current += 1
    }
  }, [load])

  const upload = async (files: readonly File[]): Promise<void> => {
    if (files.length === 0 || uploading) return
    setUploading(true)
    try {
      await attachFilesToTask(taskId, files)
    } catch (error) {
      if (mounted.current) {
        useUi.getState().toast({
          title: t('common.action_failed'),
          description: errorMessage(error),
          tone: 'danger',
        })
      }
    } finally {
      if (mounted.current) {
        setUploading(false)
        await load()
      }
    }
  }

  const detach = async (attachment: Attachment): Promise<void> => {
    if (detachingId) return
    setDetachingId(attachment.id)
    try {
      await api.todos.removeAttachment(taskId, attachment.id)
      if (mounted.current) {
        setState((current) => current.status === 'ready'
          ? { ...current, attachments: current.attachments.filter((entry) => entry.id !== attachment.id) }
          : current)
      }
    } catch (error) {
      if (mounted.current) {
        useUi.getState().toast({
          title: t('common.action_failed'),
          description: errorMessage(error),
          tone: 'danger',
        })
      }
    } finally {
      if (mounted.current) setDetachingId(null)
    }
  }

  return (
    <>
      <section
        aria-label={t('attachments.all_files')}
        aria-busy={state.status === 'loading' || uploading}
        className="flex flex-col gap-1.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2.5 py-2"
      >
        <div className="flex items-center gap-1.5">
          <Paperclip size={12} className="shrink-0 text-[var(--text-quaternary)]" aria-hidden="true" />
          <h3 className="min-w-0 flex-1 text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">
            {t('attachments.all_files')}
          </h3>
          <Button
            size="sm"
            variant="ghost"
            icon={<Upload size={13} aria-hidden="true" />}
            loading={uploading}
            disabled={state.status === 'loading' || detachingId !== null}
            onClick={() => { fileInputRef.current?.click() }}
          >
            {t('attachments.upload_file')}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const files = Array.from(event.target.files ?? [])
              event.target.value = ''
              if (files.length) void upload(files)
            }}
          />
        </div>

        {state.status === 'loading' && (
          <p role="status" className="flex min-h-9 items-center gap-1.5 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            <Spinner size={13} />
            {t('common.loading')}
          </p>
        )}
        {state.status === 'error' && (
          <div role="alert" className="flex flex-col items-start gap-1.5">
            <p className="text-[length:var(--text-11-5)] text-[var(--danger)]">{t('attachments.load_failed')}</p>
            <p className="max-w-full break-words text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{state.message}</p>
            <Button size="sm" variant="secondary" onClick={() => { void load() }}>{t('common.retry')}</Button>
          </div>
        )}
        {state.status === 'ready' && state.attachments.length === 0 && (
          <p className="py-1 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('attachments.empty_files')}</p>
        )}
        {state.status === 'ready' && state.attachments.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {state.attachments.map((attachment) => (
              <li
                key={attachment.id}
                className="flex min-w-0 items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5"
              >
                <button
                  type="button"
                  aria-label={`${t('common.preview')}: ${attachment.filename}`}
                  onClick={() => setPreview({
                    url: attachment.url,
                    filename: attachment.filename,
                    mime: attachment.mime,
                    size: attachment.size,
                  })}
                  className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-[var(--r-sm)] py-1 text-left hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] md:min-h-9"
                >
                  <FileIcon size={14} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-[length:var(--text-11-5)] text-[var(--text-primary)]" title={attachment.filename}>
                    {attachment.filename}
                  </span>
                  <span className="shrink-0 text-[length:var(--text-10-5)] tabular-nums text-[var(--text-quaternary)]">
                    {formatBytes(attachment.size)}
                  </span>
                </button>
                <a
                  href={attachment.url}
                  download={attachment.filename}
                  rel="noopener noreferrer"
                  aria-label={`${t('common.download')}: ${attachment.filename}`}
                  className="inline-flex size-11 shrink-0 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] md:size-7"
                >
                  <Download size={13} aria-hidden="true" />
                </a>
                <IconButton
                  label={`${t('common.remove')}: ${attachment.filename}`}
                  size="sm"
                  className="size-11 md:size-7"
                  disabled={detachingId !== null || uploading}
                  onClick={() => { void detach(attachment) }}
                >
                  <Unlink size={13} aria-hidden="true" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </section>
      <FilePreviewModal
        open={preview !== null}
        onClose={() => setPreview(null)}
        file={preview ?? EMPTY_PREVIEW}
      />
    </>
  )
}
