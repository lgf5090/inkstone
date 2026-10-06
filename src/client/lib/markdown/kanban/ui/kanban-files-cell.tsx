import { createContext, useContext, useRef, useState } from 'react'
import { File as FileIcon, FileText, Image as ImageIcon, Loader2, Plus, Trash2 } from 'lucide-react'
import { confirm } from '../../../../components/overlay'
import { LIMITS } from '@shared/constants'
import { t } from '../../../i18n'
import { deleteKanbanFile, uploadKanbanFile } from '../upload'
import { useUi } from '../../../../store/ui'
import { kanbanFileId } from '../url'
import type { KanbanFile } from '../types'
import { KanbanFilePreviewModal } from './kanban-file-preview-modal'

// Which note new uploads are filed under. Deletions ignore it and address each file's
// own stored location, so files uploaded before a namespace change still clear.
export const KanbanFilesScope = createContext('default')

interface KanbanFilesCellProps {
  files?: KanbanFile[]
  readonly?: boolean
  onChangeFiles?: (nextFiles: KanbanFile[]) => void
  /** The card's explicit cover, if it has one. Absent means the gallery picks the first image file. */
  cover?: string
  /** Absent means the host has nowhere to store a cover, and no row offers the action. */
  onChangeCover?: (cover: string | undefined) => void
}

/** A cover must be something the gallery can paint, so only image files are offered. */
function isImageFile(file: KanbanFile): boolean {
  return file.mime?.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg)$/i.test(file.name)
}

function resolveFileIcon(mime: string) {
  if (mime.startsWith('image/')) return <ImageIcon size={13} className='text-[var(--accent)]' />
  if (mime === 'application/pdf') return <FileText size={13} className='text-[var(--danger)]' />
  return <FileIcon size={13} className='text-[var(--text-tertiary)]' />
}

function FileItemRow({
  file,
  readonly,
  isCover,
  onPreview,
  onDelete,
  onToggleCover,
}: {
  file: KanbanFile
  readonly?: boolean
  isCover: boolean
  onPreview: () => void
  onDelete: () => void
  onToggleCover?: () => void
}) {
  return (
    <div className='group/file flex items-center gap-1.5 rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1 text-[length:var(--text-11)]'>
      {resolveFileIcon(file.mime)}
      <button
        type='button'
        onClick={onPreview}
        title={file.name}
        className='max-w-32 truncate text-left font-medium text-[var(--text-primary)] hover:underline'
      >
        {file.name}
      </button>
      <span className='text-[length:var(--text-10)] text-[var(--text-tertiary)]'>
        {`${(file.size / 1024).toFixed(0)}K`}
      </span>
      {!readonly && onToggleCover && (
        <button
          type='button'
          onClick={onToggleCover}
          aria-pressed={isCover}
          aria-label={t(isCover ? 'preview.kanban_remove_cover' : 'preview.kanban_set_cover', { value0: file.name })}
          title={t(isCover ? 'preview.kanban_remove_cover' : 'preview.kanban_set_cover', { value0: file.name })}
          className={`rounded-[var(--r-xs)] p-0.5 transition-opacity hover:text-[var(--accent)] ${
            isCover ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]'
          }`}
        >
          <ImageIcon size={11} />
        </button>
      )}
      {!readonly && (
        <button
          type='button'
          onClick={onDelete}
          title={t('preview.kanban_delete_file')}
          className='ml-auto opacity-0 transition-opacity p-0.5 text-[var(--text-tertiary)] hover:text-[var(--danger)] group-hover/file:opacity-100 focus-visible:opacity-100 pointer-coarse:!opacity-100'
        >
          <Trash2 size={11} />
        </button>
      )}
    </div>
  )
}

/**
 * The split happens before a single byte is sent, against the limit the server enforces
 * (`LIMITS.attachmentMaxBytes`): the same number on both sides, so an over-limit file is refused here
 * instead of after a 25 MB round trip. The server still checks it — this is a courtesy, that is the
 * trust boundary. A file exactly at the limit fits (the server refuses only what is greater).
 */
function splitByUploadLimit(chosen: File[]): { accepted: File[]; tooLarge: File[] } {
  return {
    accepted: chosen.filter((file) => file.size <= LIMITS.attachmentMaxBytes),
    tooLarge: chosen.filter((file) => file.size > LIMITS.attachmentMaxBytes),
  }
}

function reportTooLarge(tooLarge: File[]): void {
  useUi.getState().toast({
    title: t('preview.kanban_file_too_large', {
      value1: String(LIMITS.attachmentMaxBytes / (1024 * 1024)),
    }),
    description: tooLarge.map((file) => file.name).join(', '),
    tone: 'danger',
  })
}

function FileUploadButton({
  kanbanName,
  files,
  onChangeFiles,
}: {
  kanbanName: string
  files: KanbanFile[]
  onChangeFiles?: (next: KanbanFile[]) => void
}) {
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files
    if (!fileList || fileList.length === 0) return
    setUploading(true)
    try {
      const { accepted, tooLarge } = splitByUploadLimit(Array.from(fileList))
      const uploaded: KanbanFile[] = []
      for (const file of accepted) {
        const result = await uploadKanbanFile(file, kanbanName)
        uploaded.push(result)
      }
      if (uploaded.length > 0) onChangeFiles?.([...files, ...uploaded])
      if (tooLarge.length > 0) reportTooLarge(tooLarge)
    } catch (err: unknown) {
      console.error('[kanban] file upload failed', err)
      useUi.getState().toast({
        title: t('preview.kanban_file_upload_failed'),
        tone: 'danger',
      })
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <>
      <input ref={inputRef} type='file' multiple onChange={handleUpload} aria-label={t('preview.kanban_upload_file')} className='hidden' />
      <button
        type='button'
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
        title={t('preview.kanban_upload_file')}
        className='flex items-center gap-1 rounded-[var(--r-sm)] border border-dashed border-[var(--border-default)] px-2 py-1 text-[length:var(--text-11)] text-[var(--text-tertiary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]'
      >
        {uploading ? <Loader2 size={12} className='animate-spin' /> : <Plus size={12} />}
        <span>{t('preview.kanban_upload_file')}</span>
      </button>
    </>
  )
}

/**
 * The rows, and which of them offers the cover action. A cover has to be something the gallery can
 * paint, so only image files carry the toggle; a host with nowhere to store one passes no
 * `onChangeCover` and no row shows it at all.
 */
function FileRows({
  files,
  readonly,
  cover,
  onChangeCover,
  onPreview,
  onDelete,
}: {
  files: KanbanFile[]
  readonly: boolean
  cover?: string
  onChangeCover?: (cover: string | undefined) => void
  onPreview: (file: KanbanFile) => void
  onDelete: (file: KanbanFile) => void
}) {
  return (
    <>
      {files.map((file) => (
        <FileItemRow
          key={file.id}
          file={file}
          readonly={readonly}
          isCover={cover === file.url}
          {...(onChangeCover && isImageFile(file)
            ? { onToggleCover: () => onChangeCover(cover === file.url ? undefined : file.url) }
            : {})}
          onPreview={() => onPreview(file)}
          onDelete={() => onDelete(file)}
        />
      ))}
    </>
  )
}

export function KanbanFilesCell({
  files = [],
  readonly = false,
  onChangeFiles,
  cover,
  onChangeCover,
}: KanbanFilesCellProps) {
  const [previewFile, setPreviewFile] = useState<KanbanFile | null>(null)
  const kanbanName = useContext(KanbanFilesScope)

  // A stored file leaves the bucket for good, so it asks first — the reference in the note is
  // undoable, the bytes are not. A file hosted elsewhere has nothing here to delete.
  const handleDelete = async (file: KanbanFile) => {
    const stored = kanbanFileId(file)
    if (stored && !(await confirm({
      title: t('preview.kanban_delete_file_value0', { value0: file.name }),
      description: t('preview.kanban_delete_file_confirm_description'),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    }))) return

    onChangeFiles?.(files.filter((f) => f.id !== file.id))
    if (!stored) return
    try {
      await deleteKanbanFile(file)
      useUi.getState().toast({ title: t('preview.kanban_file_deleted'), tone: 'success' })
    } catch (err: unknown) {
      console.error('[kanban] file delete failed', err)
      onChangeFiles?.(files)
      useUi.getState().toast({
        title: t('preview.kanban_file_delete_failed'),
        tone: 'danger',
      })
    }
  }

  return (
    <div className='flex flex-wrap items-center gap-1.5'>
      <FileRows
        files={files}
        readonly={readonly}
        {...(cover !== undefined ? { cover } : {})}
        {...(onChangeCover ? { onChangeCover } : {})}
        onPreview={setPreviewFile}
        onDelete={(file) => { void handleDelete(file) }}
      />

      {!readonly && (
        <FileUploadButton kanbanName={kanbanName} files={files} onChangeFiles={onChangeFiles} />
      )}

      <KanbanFilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />
    </div>
  )
}
