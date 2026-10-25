/**
 * Local music uploads.
 *
 * A file is read in the browser for its tags, then sent whole when small (or as 8 MiB parts) into the Worker's multipart
 * upload. Nothing is trusted from the browser: the server sniffs the container and trims the tags.
 * The queue is this tab's own state; completed tasks come back from `/api/music/uploads` so a
 * reload still shows what reached the library.
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactElement,
} from 'react'
import { FileAudio, Pencil, Play, RotateCcw, Upload, X } from 'lucide-react'
import {
  MUSIC_ALL_FORMATS,
  MUSIC_FORMAT_EXTENSIONS,
  MUSIC_LIMITS,
  MUSIC_MIME_BY_FORMAT,
  formatFromFilename,
  type MusicFormat,
} from '@shared/music/constants'
import { formatBytes } from '@shared/music/format'
import type { MusicTrack, MusicUpload, MusicUploadStatus } from '@shared/music/model'
import { Empty } from '../../../components/feedback'
import { Badge, Button, IconButton } from '../../../components/primitives'
import { Field, Input } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import { useUi } from '../../../store/ui'
import { musicApi } from '../api'
import { useMusicQuery } from '../query'
import { useMusicLibrary } from '../store/library'
import { useMusicPlayer } from '../store/player'
import { musicText } from '../components/labels'
import { Pager } from '../components/Pager'
import { BlobCover } from './parts/P2MediaCard'
import { Cover } from '../components/Cover'
import {
  PAGE_STACK,
  QueryError,
  describeError,
  formatDateTime,
  toastFailure,
} from './parts/P2QueryState'

type QueueStatus = 'parsing' | 'ready' | 'uploading' | 'cover' | 'completing' | 'done' | 'failed' | 'aborted'

interface QueueItem {
  id: string
  file: File
  format: MusicFormat
  title: string
  artists: string[]
  album: string
  durationMs: number
  bitrate: number | null
  cover: Blob | null
  lyrics: string
  status: QueueStatus
  progress: number
  error: string | null
  note: string | null
  duplicate: boolean
  uploadId: string | null
  track: MusicTrack | null
  controller: AbortController | null
}

const ACCEPT = MUSIC_ALL_FORMATS
  .flatMap((format) => MUSIC_FORMAT_EXTENSIONS[format].map((extension) => `.${extension}`))
  .join(',')

const COVER_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'])
const COVER_ACCEPT = Array.from(COVER_TYPES).join(',')

const PART_LABEL = `${Math.round(MUSIC_LIMITS.uploadPartBytes / (1024 * 1024))} MiB`

const QUEUE_TONE: Record<QueueStatus, 'neutral' | 'accent' | 'success' | 'danger'> = {
  parsing: 'neutral',
  ready: 'neutral',
  uploading: 'accent',
  cover: 'accent',
  completing: 'accent',
  done: 'success',
  failed: 'danger',
  aborted: 'neutral',
}

export function UploadsPage(): ReactElement {
  const headingId = useId()
  const constraintsId = useId()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const itemsRef = useRef<QueueItem[]>([])
  const [items, setItems] = useState<QueueItem[]>([])
  const [dragging, setDragging] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [bulkRunning, setBulkRunning] = useState(false)
  const [serverPage, setServerPage] = useState(1)
  const uploadsQuery = useMusicQuery(
    () => musicApi.uploads(serverPage, MUSIC_LIMITS.taskListMax),
    [serverPage],
  )
  const serverUploads = uploadsQuery.data?.items ?? []
  const serverPageCount = Math.max(
    1,
    Math.ceil((uploadsQuery.data?.total ?? serverUploads.length) / MUSIC_LIMITS.taskListMax),
  )
  const serverUploadsRef = useRef<MusicUpload[]>([])

  useEffect(() => {
    serverUploadsRef.current = serverUploads
  }, [serverUploads])

  // Leaving the page stops this tab's transfers and tells the server to discard their tasks; a
  // half-written multipart upload is paid for by nobody after the page that owned it is gone.
  useEffect(() => () => {
    for (const item of itemsRef.current) {
      const active = item.status === 'uploading' || item.status === 'cover' || item.status === 'completing'
      if (!active) continue
      item.controller?.abort()
      if (item.uploadId) {
        void musicApi.abortUpload(item.uploadId).catch((error) => {
          console.warn('[inkstone] Music upload could not be aborted while leaving the page:', error)
        })
      }
    }
  }, [])

  const mutate = (updater: (current: QueueItem[]) => QueueItem[]): void => {
    const next = updater(itemsRef.current)
    itemsRef.current = next
    setItems(next)
  }

  const patchItem = (id: string, patch: Partial<QueueItem>): void => {
    mutate((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  const uploading = items.some(
    (item) => item.status === 'uploading' || item.status === 'cover' || item.status === 'completing',
  )
  const readyCount = items.filter((item) => item.status === 'ready').length
  const editingItem = editingId ? items.find((item) => item.id === editingId) ?? null : null

  const addFiles = async (fileList: FileList | readonly File[]): Promise<void> => {
    const files = Array.from(fileList)
    if (files.length === 0) return
    const seen = new Set(itemsRef.current.map((item) => fileKey(item.file.name, item.file.size)))
    const parseQueue: Array<{ id: string; file: File }> = []

    for (const file of files) {
      const id = localId()
      const format = formatFromFilename(file.name)
      if (!format) {
        mutate((current) => [...current, failedItem(id, file, musicText('music.upload.invalid_type', { name: file.name }))])
        continue
      }
      if (file.size <= 0) {
        mutate((current) => [...current, failedItem(id, file, musicText('music.upload.empty_file', { name: file.name }), format)])
        continue
      }
      if (file.size > MUSIC_LIMITS.uploadMaxBytes) {
        mutate((current) => [...current, failedItem(id, file, musicText('music.upload.too_large', {
          name: file.name,
          max: formatBytes(MUSIC_LIMITS.uploadMaxBytes),
        }), format)])
        continue
      }
      const key = fileKey(file.name, file.size)
      if (seen.has(key)) {
        useUi.getState().toast({ title: musicText('music.upload.duplicate_skip'), tone: 'warning' })
        continue
      }
      seen.add(key)
      const duplicate = serverUploadsRef.current.some(
        (entry) => entry.status === 'completed'
          && entry.filename.toLocaleLowerCase() === file.name.toLocaleLowerCase()
          && entry.size === file.size,
      )
      mutate((current) => [...current, parsingItem(id, file, format, duplicate)])
      parseQueue.push({ id, file })
    }

    if (parseQueue.length === 0) return
    let parseUploadMetadata: typeof import('../upload-metadata').parseUploadMetadata
    try {
      ({ parseUploadMetadata } = await import('../upload-metadata'))
    } catch (error) {
      toastFailure(musicText('music.upload.metadata_failed'), error)
      for (const entry of parseQueue) {
        patchItem(entry.id, {
          status: 'failed',
          title: titleFromFilename(entry.file.name),
          error: describeError(error),
        })
      }
      return
    }

    for (const entry of parseQueue) {
      try {
        const parsed = await parseUploadMetadata(entry.file)
        if (!parsed.ok) {
          patchItem(entry.id, {
            status: 'ready',
            title: titleFromFilename(entry.file.name),
            note: musicText('music.upload.metadata_failed'),
          })
          continue
        }
        const cover = acceptableCover(parsed.data.cover)
        patchItem(entry.id, {
          status: 'ready',
          title: parsed.data.title,
          artists: parsed.data.artists,
          album: parsed.data.album,
          durationMs: parsed.data.durationMs,
          bitrate: parsed.data.bitrate,
          cover: cover.blob,
          lyrics: parsed.data.lyrics,
          note: cover.note,
        })
      } catch (error) {
        patchItem(entry.id, {
          status: 'failed',
          title: titleFromFilename(entry.file.name),
          error: describeError(error),
        })
      }
    }
  }

  const parsedLyrics = (item: QueueItem): string => item.lyrics

  const uploadItem = async (id: string): Promise<void> => {
    const item = itemsRef.current.find((entry) => entry.id === id)
    if (!item || item.status === 'uploading' || item.status === 'cover' || item.status === 'completing') return
    const controller = new AbortController()
    patchItem(id, {
      status: 'uploading',
      progress: 0,
      error: null,
      uploadId: null,
      track: null,
      controller,
    })

    let uploadId: string | null = null
    try {
      const init = await musicApi.initUpload({
        filename: item.file.name,
        mime: MUSIC_MIME_BY_FORMAT[item.format],
        size: item.file.size,
        format: item.format,
        metadata: {
          title: item.title,
          artists: item.artists,
          album: item.album,
          durationMs: item.durationMs,
          bitrate: item.bitrate,
          lyrics: parsedLyrics(item),
        },
      })
      uploadId = init.uploadId
      patchItem(id, { uploadId })
      if (controller.signal.aborted) {
        await musicApi.abortUpload(uploadId).catch((error) => {
          console.warn('[inkstone] An upload canceled before its first part could not be aborted:', error)
        })
        throw abortError()
      }

      const partSize = init.partSize > 0 ? init.partSize : MUSIC_LIMITS.uploadPartBytes
      const totalParts = Math.ceil(item.file.size / partSize)
      let lastProgress = -1
      for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
        if (controller.signal.aborted) throw abortError()
        const start = (partNumber - 1) * partSize
        const chunk = item.file.slice(start, Math.min(start + partSize, item.file.size))
        await musicApi.uploadPart(uploadId, partNumber, chunk, (sent) => {
          const loaded = start + Math.min(sent, chunk.size)
          const percent = Math.min(99, Math.round((loaded / item.file.size) * 100))
          if (percent <= lastProgress) return
          lastProgress = percent
          patchItem(id, { progress: percent })
        }, controller.signal)
      }

      if (item.cover) {
        patchItem(id, { status: 'cover' })
        await musicApi.uploadCover(uploadId, item.cover, undefined, controller.signal)
      }
      patchItem(id, { status: 'completing', progress: 100 })
      const completed = await musicApi.completeUpload(uploadId)
      useMusicLibrary.getState().upsertUpload(completed.upload)
      patchItem(id, {
        status: 'done',
        progress: 100,
        track: completed.track,
        controller: null,
        error: null,
        uploadId,
      })
      useUi.getState().toast({
        title: musicText('music.upload.done_toast', { name: item.file.name }),
        tone: 'success',
      })
      void uploadsQuery.reload()
    } catch (error) {
      if (controller.signal.aborted || isAbort(error)) {
        patchItem(id, { status: 'aborted', controller: null, error: null, uploadId })
        if (uploadId) {
          try {
            await musicApi.abortUpload(uploadId)
          } catch (abortError) {
            patchItem(id, { error: describeError(abortError) })
            toastFailure(musicText('music.upload.cancel_failed'), abortError)
          }
        }
        return
      }
      patchItem(id, {
        status: 'failed',
        controller: null,
        error: describeError(error),
        uploadId,
      })
      toastFailure(musicText('music.upload.failed_toast', { name: item.file.name }), error)
    }
  }

  const uploadAll = async (): Promise<void> => {
    const ids = itemsRef.current.filter((item) => item.status === 'ready').map((item) => item.id)
    if (ids.length === 0) return
    setBulkRunning(true)
    try {
      for (const id of ids) {
        const current = itemsRef.current.find((item) => item.id === id)
        if (!current || current.status !== 'ready') continue
        await uploadItem(id)
      }
    } finally {
      setBulkRunning(false)
    }
  }

  const cancel = (item: QueueItem): void => {
    item.controller?.abort()
  }

  const retry = (item: QueueItem): void => {
    const previous = item.uploadId
    patchItem(item.id, { status: 'ready', progress: 0, error: null, uploadId: null })
    if (previous) {
      void musicApi.abortUpload(previous).catch((error) => {
        console.warn('[inkstone] A failed music upload task could not be discarded before retrying:', error)
      })
    }
    void uploadItem(item.id)
  }

  const remove = (item: QueueItem): void => {
    if (item.status === 'uploading' || item.status === 'cover' || item.status === 'completing') return
    if (item.uploadId && item.status !== 'done') {
      void musicApi.abortUpload(item.uploadId).catch((error) => {
        console.warn('[inkstone] A removed music upload task could not be aborted:', error)
      })
    }
    mutate((current) => current.filter((entry) => entry.id !== item.id))
  }

  const onFilesChosen = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = event.target.files
    if (files) void addFiles(files)
    // The same file may be chosen again after it was removed from the queue.
    event.target.value = ''
  }

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDragging(false)
    if (event.dataTransfer.files.length > 0) void addFiles(event.dataTransfer.files)
  }

  return (
    <section aria-labelledby={headingId} className={PAGE_STACK}>
      <header className="music-section-header">
        <div className="music-section-header__text">
          <h1 id={headingId} className="music-section-header__title">
            {musicText('music.page.uploads')}
          </h1>
          <p className="music-section-header__description">
            {musicText('music.upload.description')}
          </p>
        </div>
        <Button
          variant="primary"
          icon={<Upload size={14} />}
          loading={bulkRunning}
          disabled={readyCount === 0 || uploading}
          onClick={() => {
            void uploadAll()
          }}
        >
          {musicText('music.upload.upload_all')}
        </Button>
      </header>

      <div
        role="group"
        aria-label={musicText('music.upload.drop')}
        aria-describedby={constraintsId}
        onDragEnter={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
          setDragging(false)
        }}
        onDrop={onDrop}
        className={[
          'flex flex-col items-center justify-center gap-[var(--sp-2)] rounded-[var(--r-lg)] border border-dashed p-[var(--sp-6)] text-center transition-colors duration-[var(--dur-fast)]',
          dragging
            ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
            : 'border-[var(--border-default)] bg-[var(--bg-sunken)]',
        ].join(' ')}
      >
        <FileAudio size={28} aria-hidden="true" className="text-[var(--text-quaternary)]" />
        <p className="text-[length:var(--text-13-5)] font-medium text-[var(--text-secondary)]">
          {musicText('music.upload.drop')}
        </p>
        <p id={constraintsId} className="max-w-[560px] text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-quaternary)]">
          {musicText('music.upload.hint', {
            formats: MUSIC_ALL_FORMATS.map((format) => format.toLocaleUpperCase()).join(', '),
          })}
          {' '}
          {musicText('music.upload.limits', {
            part: PART_LABEL,
            max: formatBytes(MUSIC_LIMITS.uploadMaxBytes),
            quota: formatBytes(MUSIC_LIMITS.quotaBytes),
          })}
        </p>
        <Button
          variant="secondary"
          onClick={() => fileInputRef.current?.click()}
        >
          {musicText('music.upload.choose')}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPT}
          onChange={onFilesChosen}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
        />
      </div>

      <section aria-label={musicText('music.upload.queue')} className="flex flex-col gap-[var(--sp-3)]">
        <h3 className="font-[family-name:var(--font-display)] text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
          {musicText('music.upload.queue')}
        </h3>
        {items.length === 0 ? (
          <Empty
            art="folder"
            compact
            title={musicText('music.upload.empty')}
            description={musicText('music.upload.empty_hint')}
          />
        ) : (
          <ul className="flex flex-col gap-[var(--sp-2)]">
            {items.map((item) => (
              <UploadQueueRow
                key={item.id}
                item={item}
                onEdit={() => setEditingId(item.id)}
                onUpload={() => {
                  void uploadItem(item.id)
                }}
                onRetry={() => retry(item)}
                onCancel={() => cancel(item)}
                onRemove={() => remove(item)}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-label={musicText('music.upload.existing')} className="flex flex-col gap-[var(--sp-3)]">
        <h3 className="font-[family-name:var(--font-display)] text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
          {musicText('music.upload.existing')}
        </h3>
        {uploadsQuery.status === 'error' && !uploadsQuery.data ? (
          <QueryError
            title={musicText('music.upload.existing_error')}
            detail={uploadsQuery.error}
            onRetry={uploadsQuery.reload}
          />
        ) : uploadsQuery.status === 'loading' && !uploadsQuery.data ? (
          <div className="flex flex-col gap-[var(--sp-1)]" role="status" aria-busy="true" aria-label={musicText('common.loading')}>
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className="h-[52px] rounded-[var(--r-sm)] bg-[var(--bg-sunken)]" />
            ))}
          </div>
        ) : serverUploads.length === 0 ? (
          <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {musicText('music.upload.existing_empty_hint')}
          </p>
        ) : (
          <ul className="flex flex-col gap-[var(--sp-1)]">
            {serverUploads.map((upload) => (
              <ServerUploadRow
                key={upload.id}
                upload={upload}
                onAbort={() => {
                  void (async () => {
                    try {
                      await musicApi.abortUpload(upload.id)
                      useUi.getState().toast({ title: musicText('music.upload.aborted_toast'), tone: 'success' })
                      uploadsQuery.reload()
                    } catch (error) {
                      toastFailure(musicText('music.upload.cancel_failed'), error)
                    }
                  })()
                }}
              />
            ))}
          </ul>
        )}
        {serverPageCount > 1 && (
          <Pager page={serverPage} pageCount={serverPageCount} onChange={setServerPage} />
        )}
      </section>

      {editingItem && (
        <MetadataDialog
          key={editingItem.id}
          item={editingItem}
          onClose={() => setEditingId(null)}
          onSave={(patch) => {
            patchItem(editingItem.id, patch)
            setEditingId(null)
          }}
        />
      )}

      {uploading && (
        <p role="status" className="sr-only">
          {musicText('music.upload.uploading_status')}
        </p>
      )}
    </section>
  )
}

function UploadQueueRow({
  item,
  onEdit,
  onUpload,
  onRetry,
  onCancel,
  onRemove,
}: {
  item: QueueItem
  onEdit: () => void
  onUpload: () => void
  onRetry: () => void
  onCancel: () => void
  onRemove: () => void
}): ReactElement {
  const busy = item.status === 'uploading' || item.status === 'cover' || item.status === 'completing'
  const editable = item.status === 'ready' || item.status === 'failed' || item.status === 'aborted'
  return (
    <li className="flex flex-col gap-[var(--sp-2)] rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-[var(--sp-3)]">
      <div className="flex items-start gap-[var(--sp-3)]">
        <BlobCover blob={item.cover} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
            {item.title}
          </p>
          <p className="truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {item.file.name} · {formatBytes(item.file.size)} · {item.format.toLocaleUpperCase()}
          </p>
          {item.artists.length > 0 && (
            <p className="truncate text-[length:var(--text-11)] text-[var(--text-quaternary)]">
              {item.artists.join(' / ')}
            </p>
          )}
        </div>
        <Badge tone={QUEUE_TONE[item.status]}>
          {musicText(`music.upload.status.${item.status}`)}
        </Badge>
      </div>

      {busy && (
        <div className="flex flex-col gap-[var(--sp-1)]">
          <progress
            className="h-2 w-full accent-[var(--accent)]"
            max={100}
            value={item.progress}
            aria-label={musicText('music.upload.progress_label', { name: item.file.name })}
          />
          <span className="text-[length:var(--text-10-5)] tabular text-[var(--text-tertiary)]">
            {musicText('music.upload.progress', { percent: item.progress })}
          </span>
        </div>
      )}

      {item.duplicate && (
        <p className="text-[length:var(--text-11)] leading-relaxed text-[var(--warning)]">
          {musicText('music.upload.duplicate')}
        </p>
      )}
      {item.note && (
        <p className="text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">
          {item.note}
        </p>
      )}
      {item.error && (
        <p role="alert" className="break-words text-[length:var(--text-11)] leading-relaxed text-[var(--danger)]">
          {item.error}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-[var(--sp-1)]">
        {editable && (
          <IconButton label={musicText('common.edit')} size="sm" onClick={onEdit}>
            <Pencil size={14} />
          </IconButton>
        )}
        {item.status === 'ready' && (
          <Button size="sm" variant="primary" icon={<Upload size={13} />} onClick={onUpload}>
            {musicText('music.upload.upload')}
          </Button>
        )}
        {item.status === 'done' && item.track && (
          <Button
            size="sm"
            variant="secondary"
            icon={<Play size={13} />}
            onClick={() => {
              const track = item.track
              if (!track) return
              void useMusicPlayer.getState().playTrack(track)
            }}
          >
            {musicText('music.common.play')}
          </Button>
        )}
        {(item.status === 'failed' || item.status === 'aborted') && (
          <Button size="sm" variant="secondary" icon={<RotateCcw size={13} />} onClick={onRetry}>
            {musicText('common.retry')}
          </Button>
        )}
        {busy && item.status !== 'completing' && (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {musicText('music.upload.cancel')}
          </Button>
        )}
        {!busy && (
          <IconButton label={musicText('music.upload.remove')} size="sm" onClick={onRemove}>
            <X size={14} />
          </IconButton>
        )}
      </div>
    </li>
  )
}

function ServerUploadRow({
  upload,
  onAbort,
}: {
  upload: MusicUpload
  onAbort: () => void
}): ReactElement {
  return (
    <li className="flex flex-wrap items-center gap-[var(--sp-2)] rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-[var(--sp-3)] py-[var(--sp-2)]">
      <Cover trackId={upload.trackId ?? undefined} size="sm" radius="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">
          {upload.filename}
        </p>
        <p className="truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          {formatBytes(upload.size)} · {upload.format.toLocaleUpperCase()} · {formatDateTime(upload.createdAt)}
        </p>
        {upload.error && (
          <p className="break-words text-[length:var(--text-11)] text-[var(--danger)]">{upload.error}</p>
        )}
      </div>
      <Badge tone={serverUploadTone(upload.status)}>{serverUploadLabel(upload.status)}</Badge>
      {upload.status === 'completed' && upload.trackId && (
        <Button
          size="sm"
          variant="ghost"
          icon={<Play size={13} />}
          onClick={() => {
            void musicApi.track(upload.trackId!).then(({ track }) => {
              void useMusicPlayer.getState().playTrack(track, { queue: [track] })
            }).catch((error: unknown) => toastFailure(musicText('music.upload.play_failed'), error))
          }}
        >
          {musicText('music.upload.play')}
        </Button>
      )}
      {upload.status === 'uploading' && (
        <Button size="sm" variant="ghost" onClick={onAbort}>
          {musicText('music.upload.cancel')}
        </Button>
      )}
    </li>
  )
}

function MetadataDialog({
  item,
  onClose,
  onSave,
}: {
  item: QueueItem
  onClose: () => void
  onSave: (patch: Pick<QueueItem, 'title' | 'artists' | 'album' | 'cover'>) => void
}): ReactElement {
  const [title, setTitle] = useState(item.title)
  const [artists, setArtists] = useState(item.artists.join(', '))
  const [album, setAlbum] = useState(item.album)
  const [cover, setCover] = useState<Blob | null>(item.cover)
  const [coverNote, setCoverNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const coverInputRef = useRef<HTMLInputElement>(null)
  const errorId = useId()

  const chooseCover = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const next = acceptableCover(file)
    if (next.blob) setCover(next.blob)
    setCoverNote(next.note)
  }

  const save = (): void => {
    const nextTitle = title.trim()
    if (!nextTitle) {
      setError(musicText('music.upload.title_required'))
      return
    }
    setError(null)
    onSave({
      title: nextTitle,
      artists: artists.split(',').map((name) => name.trim()).filter(Boolean),
      album: album.trim(),
      cover,
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={musicText('music.upload.edit_title')}
      description={item.file.name}
      width={480}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{musicText('common.cancel')}</Button>
          <Button variant="primary" onClick={save}>{musicText('common.save')}</Button>
        </>
      )}
    >
      <div className="flex flex-col gap-[var(--sp-3)]">
        <div className="flex items-center gap-[var(--sp-3)]">
          <BlobCover blob={cover} size="md" />
          <div className="flex flex-wrap items-center gap-[var(--sp-2)]">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => coverInputRef.current?.click()}
            >
              {musicText('music.upload.cover_choose')}
            </Button>
            {cover && (
              <Button size="sm" variant="ghost" onClick={() => {
                setCover(null)
                setCoverNote(null)
              }}>
                {musicText('music.upload.cover_remove')}
              </Button>
            )}
          </div>
          <input
            ref={coverInputRef}
            type="file"
            accept={COVER_ACCEPT}
            onChange={chooseCover}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
          />
        </div>
        {coverNote && <p className="text-[length:var(--text-11)] text-[var(--warning)]">{coverNote}</p>}

        <Field label={musicText('music.upload.field_title')} required>
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            invalid={Boolean(error)}
            aria-describedby={error ? errorId : undefined}
          />
        </Field>
        <Field label={musicText('music.upload.field_artists')} hint={musicText('music.upload.field_artists_hint')}>
          <Input value={artists} onChange={(event) => setArtists(event.target.value)} />
        </Field>
        <Field label={musicText('music.upload.field_album')}>
          <Input value={album} onChange={(event) => setAlbum(event.target.value)} />
        </Field>
        {error && (
          <p id={errorId} role="alert" className="text-[length:var(--text-11-5)] text-[var(--danger)]">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}

function parsingItem(id: string, file: File, format: MusicFormat, duplicate: boolean): QueueItem {
  return {
    id,
    file,
    format,
    title: titleFromFilename(file.name),
    artists: [],
    album: '',
    durationMs: 0,
    bitrate: null,
    cover: null,
    lyrics: '',
    status: 'parsing',
    progress: 0,
    error: null,
    note: null,
    duplicate,
    uploadId: null,
    track: null,
    controller: null,
  }
}

function failedItem(
  id: string,
  file: File,
  error: string,
  format: MusicFormat = 'mp3',
): QueueItem {
  return {
    ...parsingItem(id, file, format, false),
    status: 'failed',
    error,
  }
}

function acceptableCover(blob: Blob | null): { blob: Blob | null; note: string | null } {
  if (!blob || blob.size === 0) return { blob: null, note: null }
  const type = blob.type.split(';', 1)[0]?.trim().toLocaleLowerCase() ?? ''
  if (!COVER_TYPES.has(type)) {
    return { blob: null, note: musicText('music.upload.cover_invalid') }
  }
  if (blob.size > MUSIC_LIMITS.coverMaxBytes) {
    return { blob: null, note: musicText('music.upload.cover_too_large') }
  }
  return { blob, note: null }
}

function serverUploadTone(status: MusicUploadStatus): 'neutral' | 'accent' | 'success' | 'danger' {
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'uploading') return 'accent'
  return 'neutral'
}

function serverUploadLabel(status: MusicUploadStatus): string {
  if (status === 'completed') return musicText('music.upload.status.done')
  return musicText(`music.upload.status.${status}`)
}

function titleFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '').trim()
  return base || filename
}

function fileKey(name: string, size: number): string {
  return `${name.toLocaleLowerCase()}:${size}`
}

function localId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TransferAborted')
}
