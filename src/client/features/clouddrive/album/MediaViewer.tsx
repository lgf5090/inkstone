import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Download,
  File as FileIcon,
  Info,
  Music,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type { CloudDriveEntry } from '@shared/clouddrive/model'
import { Button, IconButton } from '../../../components/primitives'
import { Modal } from '../../../components/overlay'
import { formatBytes } from '../../../lib/time'
import { localeTag, useLocale } from '../../../lib/i18n'
import { cn } from '../../../lib/cn'
import { clouddriveApi } from '../api'
import { ct, type CloudDriveMessageKey } from '../media-i18n'

export interface MediaViewerProps {
  open: boolean
  entries: readonly CloudDriveEntry[]
  index: number
  onIndexChange(index: number): void
  onClose(): void
  /** The shell may route the download through the transfer centre; otherwise a direct link is used. */
  onDownload?(entry: CloudDriveEntry): void
}

const ZOOM_MIN = 1
const ZOOM_MAX = 4
const ZOOM_STEP = 0.5

/**
 * Full-screen album viewer. The overlay is a `Modal`, so focus enters the panel, Tab stays inside and
 * closing returns focus to the tile that opened it. Arrow keys walk the album; Esc is the Modal's.
 */
export function MediaViewer({ open, entries, index, onIndexChange, onClose, onDownload }: MediaViewerProps) {
  const entry = entries[index] ?? null
  const locale = useLocale()
  const [zoom, setZoom] = useState(1)
  const [details, setDetails] = useState(false)
  const [failed, setFailed] = useState(false)
  const [retryKey, setRetryKey] = useState(0)

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(localeTag(), { dateStyle: 'medium', timeStyle: 'short' }),
    [locale],
  )

  useEffect(() => {
    setZoom(1)
    setFailed(false)
    setRetryKey(0)
  }, [entry?.id])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return
      // A focused media element owns its own arrow keys while the reader is scrubbing.
      if (target instanceof HTMLVideoElement || target instanceof HTMLAudioElement) return
      if (event.key === 'ArrowLeft' && index > 0) {
        event.preventDefault()
        onIndexChange(index - 1)
      } else if (event.key === 'ArrowRight' && index < entries.length - 1) {
        event.preventDefault()
        onIndexChange(index + 1)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [entries.length, index, onIndexChange, open])

  if (!open || !entry) return null

  const isImage = entry.category === 'images' || entry.mime.startsWith('image/')
  const isVideo = entry.category === 'videos' || entry.mime.startsWith('video/')
  const isAudio = entry.category === 'audios' || entry.mime.startsWith('audio/')
  const contentUrl = clouddriveApi.contentUrl(entry.id)
  const downloadUrl = clouddriveApi.contentUrl(entry.id, true)
  const kindLabel = ct(`clouddrive.kind.${entry.category}` as CloudDriveMessageKey)
  const counter = ct('clouddrive.viewer.counter', { index: index + 1, count: entries.length })

  const zoomBy = (delta: number) => setZoom((value) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value + delta)))

  return (
    <Modal open onClose={onClose} variant="fullscreen" ariaLabel={entry.name}>
      <div className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]">
        <header className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border-subtle)] px-2 py-1.5">
          <IconButton label={ct('common.close')} onClick={onClose}>
            <X size={16} />
          </IconButton>
          <div className="min-w-0 flex-1 px-1">
            <h1 className="truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{entry.name}</h1>
            <p className="mt-0.5 truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {kindLabel} · {formatBytes(entry.size)} · {counter}
            </p>
          </div>
          <IconButton
            label={ct('clouddrive.viewer.details')}
            active={details}
            onClick={() => setDetails((value) => !value)}
          >
            <Info size={15} />
          </IconButton>
          {onDownload ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<Download size={13} />}
              aria-label={ct('common.download')}
              onClick={() => onDownload(entry)}
            >
              <span className="hidden sm:inline">{ct('common.download')}</span>
            </Button>
          ) : (
            <a
              href={downloadUrl}
              download={entry.name}
              rel="noopener noreferrer"
              aria-label={ct('common.download')}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-[var(--r-sm)] border border-[var(--border-default)] px-2.5 text-[length:var(--text-12)] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)] md:h-7"
            >
              <Download size={13} aria-hidden />
              <span className="hidden sm:inline">{ct('common.download')}</span>
            </a>
          )}
        </header>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-auto bg-[var(--bg-sunken)] p-2">
            {isImage && !failed && (
              <>
                <div className="absolute left-2 top-2 z-10 flex items-center gap-1 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]/95 p-0.5 shadow-[var(--shadow-pop)]">
                  <IconButton label={ct('common.zoom_out')} size="sm" disabled={zoom <= ZOOM_MIN} onClick={() => zoomBy(-ZOOM_STEP)}>
                    <ZoomOut size={14} />
                  </IconButton>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={ct('clouddrive.viewer.reset_zoom')}
                    onClick={() => setZoom(1)}
                  >
                    {Math.round(zoom * 100)}%
                  </Button>
                  <IconButton label={ct('common.zoom_in')} size="sm" disabled={zoom >= ZOOM_MAX} onClick={() => zoomBy(ZOOM_STEP)}>
                    <ZoomIn size={14} />
                  </IconButton>
                </div>
                <img
                  key={`${entry.id}-${retryKey}`}
                  src={contentUrl}
                  alt={entry.name}
                  draggable={false}
                  onError={() => setFailed(true)}
                  onDoubleClick={() => setZoom((value) => (value === 1 ? 2 : 1))}
                  className="max-h-full max-w-full rounded-[var(--r-sm)] object-contain transition-transform duration-[var(--dur-fast)] ease-[var(--ease-out)]"
                  style={{ transform: `scale(${zoom})` }}
                />
              </>
            )}

            {isVideo && !failed && (
              <video
                key={`${entry.id}-${retryKey}`}
                src={contentUrl}
                controls
                playsInline
                preload="metadata"
                onError={() => setFailed(true)}
                className="max-h-full max-w-full rounded-[var(--r-sm)] bg-black"
              >
                {ct('clouddrive.viewer.video')}
              </video>
            )}

            {isAudio && !failed && (
              <div className="flex w-full max-w-[460px] flex-col items-center gap-4 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5 text-center">
                <span className="flex size-14 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent-on-soft)]">
                  <Music size={24} aria-hidden />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{entry.name}</p>
                  <p className="mt-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{ct('clouddrive.viewer.audio')}</p>
                </div>
                <audio
                  key={`${entry.id}-${retryKey}`}
                  src={contentUrl}
                  controls
                  preload="metadata"
                  onError={() => setFailed(true)}
                  className="w-full"
                />
              </div>
            )}

            {!isImage && !isVideo && !isAudio && (
              <div className="flex max-w-[380px] flex-col items-center gap-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6 text-center">
                <FileIcon size={28} className="text-[var(--text-tertiary)]" aria-hidden />
                <p className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{entry.name}</p>
                <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{ct('clouddrive.viewer.unsupported')}</p>
              </div>
            )}

            {failed && (
              <div role="alert" className="flex max-w-[380px] flex-col items-center gap-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6 text-center">
                <AlertTriangle size={26} className="text-[var(--danger)]" aria-hidden />
                <p className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
                  {isImage ? ct('clouddrive.viewer.image_failed') : ct('clouddrive.viewer.media_failed')}
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button size="sm" variant="secondary" onClick={() => { setFailed(false); setRetryKey((key) => key + 1) }}>
                    {ct('common.retry')}
                  </Button>
                  <a
                    href={downloadUrl}
                    download={entry.name}
                    rel="noopener noreferrer"
                    className="inline-flex h-9 items-center gap-1.5 rounded-[var(--r-sm)] border border-[var(--border-default)] px-2.5 text-[length:var(--text-12)] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)] md:h-7"
                  >
                    <Download size={13} aria-hidden />
                    {ct('common.download')}
                  </a>
                </div>
              </div>
            )}

          </div>

          {details && (
            <aside
              aria-label={ct('clouddrive.viewer.details')}
              className={cn(
                'max-h-[45%] shrink-0 overflow-auto border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3',
                'md:max-h-none md:w-[280px] md:border-l md:border-t-0',
              )}
            >
              <h2 className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">{ct('clouddrive.viewer.details')}</h2>
              <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-[length:var(--text-12)]">
                <dt className="text-[var(--text-tertiary)]">{ct('clouddrive.inspector.kind')}</dt>
                <dd className="min-w-0 text-[var(--text-primary)]">{kindLabel}</dd>
                <dt className="text-[var(--text-tertiary)]">{ct('clouddrive.inspector.size')}</dt>
                <dd className="min-w-0 text-[var(--text-primary)]">{formatBytes(entry.size)}</dd>
                <dt className="text-[var(--text-tertiary)]">{ct('clouddrive.inspector.uploaded')}</dt>
                <dd className="min-w-0 text-[var(--text-primary)]">{dateFormatter.format(new Date(entry.uploadedAt))}</dd>
                <dt className="text-[var(--text-tertiary)]">{ct('clouddrive.inspector.path')}</dt>
                <dd className="min-w-0 break-all text-[var(--text-primary)]">{entry.path}</dd>
                <dt className="text-[var(--text-tertiary)]">{ct('clouddrive.inspector.tags')}</dt>
                <dd className="flex min-w-0 flex-wrap gap-1 text-[var(--text-primary)]">
                  {entry.tags.length > 0
                    ? entry.tags.map((tag) => (
                      <span key={tag.name} className="inline-flex items-center gap-1 rounded-full bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10)]">
                        <span className="size-1.5 rounded-full" style={{ backgroundColor: tag.color }} aria-hidden />
                        {tag.name}
                      </span>
                    ))
                    : <span className="text-[var(--text-tertiary)]">{ct('clouddrive.tags.none')}</span>}
                </dd>
              </dl>
            </aside>
          )}
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-center gap-2 border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-2">
          <Button
            size="sm"
            variant="secondary"
            icon={<ChevronLeft size={14} />}
            aria-label={ct('clouddrive.viewer.previous')}
            disabled={index <= 0}
            onClick={() => onIndexChange(index - 1)}
          >
            <span className="hidden sm:inline">{ct('clouddrive.viewer.previous')}</span>
          </Button>
          <span className="min-w-[72px] text-center text-[length:var(--text-11)] tabular text-[var(--text-tertiary)]" aria-live="polite">
            {counter}
          </span>
          <Button
            size="sm"
            variant="secondary"
            trailing={<ChevronRight size={14} />}
            aria-label={ct('clouddrive.viewer.next')}
            disabled={index >= entries.length - 1}
            onClick={() => onIndexChange(index + 1)}
          >
            <span className="hidden sm:inline">{ct('clouddrive.viewer.next')}</span>
          </Button>
        </footer>
      </div>
    </Modal>
  )
}
