/**
 * The R2 download queue: progress, pause/resume/retry/cancel and the account's storage gauge.
 *
 * Downloads are server-side copies into the music library, not files on this device; this page
 * manages that queue and says so. A task is added from a track's menu, so there is no enqueue
 * control here.
 */
import { useEffect, useId, useState, type ReactElement } from 'react'
import { Download, Pause, Play, RotateCcw, X } from 'lucide-react'
import { MUSIC_LIMITS } from '@shared/music/constants'
import {
  formatBytes,
  musicArtistNames,
  musicQualityLabelKey,
} from '@shared/music/format'
import { Empty } from '../../../components/feedback'
import { Badge, Button, IconButton } from '../../../components/primitives'
import { confirm } from '../../../components/overlay'
import { navigateToAddress } from '../../../lib/app-history'
import { useUi } from '../../../store/ui'
import type { MusicDownloadItem } from '../store/library'
import { musicApi } from '../api'
import { musicPathFor } from '../music-address'
import { useMusicQuery } from '../query'
import { Cover } from '../components/Cover'
import { musicText } from '../components/labels'
import {
  PAGE_STACK,
  QueryError,
  toastFailure,
} from './parts/P2QueryState'

const POLL_MS = 3000

type DownloadAction = 'pause' | 'resume' | 'retry' | 'cancel'

const STATUS_TONE: Record<MusicDownloadItem['status'], 'neutral' | 'accent' | 'success' | 'warning' | 'danger'> = {
  queued: 'neutral',
  running: 'accent',
  paused: 'warning',
  done: 'success',
  failed: 'danger',
  canceled: 'neutral',
}

export function DownloadsPage(): ReactElement {
  const headingId = useId()
  const [items, setItems] = useState<MusicDownloadItem[]>([])
  const [pendingId, setPendingId] = useState<string | null>(null)
  const query = useMusicQuery(async () => {
    const [downloads, uploads] = await Promise.all([musicApi.downloads(), musicApi.uploads()])
    return { downloads: downloads.items, uploads: uploads.items }
  }, [])

  useEffect(() => {
    if (query.data) setItems(query.data.downloads)
  }, [query.data])

  const hasActive = items.some((item) => item.status === 'queued' || item.status === 'running')
  const reload = query.reload
  useEffect(() => {
    if (!hasActive) return
    const timer = window.setInterval(() => reload(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [hasActive, reload])

  const usedBytes = (query.data?.uploads ?? [])
    .filter((upload) => upload.status === 'completed')
    .reduce((sum, upload) => sum + upload.size, 0)
    + items
      .filter((item) => item.status === 'done')
      .reduce((sum, item) => sum + (item.size ?? 0), 0)
  const quotaBytes = MUSIC_LIMITS.quotaBytes
  const quotaPercent = Math.min(100, Math.round((usedBytes / quotaBytes) * 100))
  const activeCount = items.filter((item) => item.status === 'queued' || item.status === 'running').length

  const act = async (item: MusicDownloadItem, action: DownloadAction): Promise<void> => {
    if (action === 'cancel') {
      const approved = await confirm({
        title: musicText('music.downloads.cancel_confirm_title'),
        description: musicText('music.downloads.cancel_confirm_body', {
          title: item.track?.title ?? item.trackId,
        }),
        confirmLabel: musicText('music.downloads.cancel'),
        tone: 'danger',
      })
      if (!approved) return
    }
    setPendingId(item.id)
    try {
      const updated = await musicApi.updateDownload(item.id, action)
      setItems((current) => current.map((entry) => (
        entry.id === item.id ? { ...entry, ...updated, track: entry.track } : entry
      )))
      if (action === 'cancel') {
        useUi.getState().toast({ title: musicText('music.downloads.canceled'), tone: 'success' })
      }
    } catch (error) {
      toastFailure(musicText('music.downloads.action_failed'), error)
      query.reload()
    } finally {
      setPendingId(null)
    }
  }

  const discoverHref = musicPathFor({ kind: 'home' })

  return (
    <section aria-labelledby={headingId} className={PAGE_STACK}>
      <header className="music-section-header">
        <div className="music-section-header__text">
          <h1 id={headingId} className="music-section-header__title">
            {musicText('music.page.downloads')}
          </h1>
          <p className="music-section-header__description">
            {musicText('music.downloads.description', {
              active: activeCount,
              total: items.length,
            })}
          </p>
        </div>
        <IconButton label={musicText('common.refresh')} size="sm" onClick={query.reload}>
          <RotateCcw size={14} />
        </IconButton>
      </header>

      <section
        aria-label={musicText('music.downloads.quota')}
        className="flex flex-col gap-[var(--sp-2)] rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-[var(--sp-4)]"
      >
        <div className="flex flex-wrap items-center justify-between gap-[var(--sp-2)]">
          <h3 className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
            {musicText('music.downloads.quota')}
          </h3>
          <span className="text-[length:var(--text-11-5)] tabular text-[var(--text-tertiary)]">
            {musicText('music.downloads.quota_used', {
              used: formatBytes(usedBytes),
              quota: formatBytes(quotaBytes),
            })}
          </span>
        </div>
        <progress
          className="h-2 w-full accent-[var(--accent)]"
          max={100}
          value={quotaPercent}
          aria-label={musicText('music.downloads.quota_aria', {
            percent: quotaPercent,
          })}
        />
        <p className="text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">
          {musicText('music.downloads.r2_note')}
        </p>
      </section>

      {query.status === 'error' && !query.data ? (
        <QueryError
          title={musicText('music.downloads.error')}
          detail={query.error}
          onRetry={query.reload}
        />
      ) : query.status === 'loading' && !query.data ? (
        <div className="flex flex-col gap-[var(--sp-2)]" role="status" aria-busy="true" aria-label={musicText('common.loading')}>
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="h-[88px] rounded-[var(--r-md)] bg-[var(--bg-sunken)]" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <Empty
          art="archive"
          title={musicText('music.downloads.empty')}
          description={musicText('music.downloads.empty_hint')}
          action={(
            <Button variant="secondary" onClick={() => navigateToAddress(discoverHref)}>
              {musicText('music.downloads.browse')}
            </Button>
          )}
        />
      ) : (
        <>
          {query.status === 'error' && (
            <QueryError
              title={musicText('music.downloads.error')}
              detail={query.error}
              onRetry={query.reload}
            />
          )}
          <ul className="flex flex-col gap-[var(--sp-2)]">
            {items.map((item) => (
              <DownloadRow
                key={item.id}
                item={item}
                pending={pendingId === item.id}
                onAction={(action) => {
                  void act(item, action)
                }}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function DownloadRow({
  item,
  pending,
  onAction,
}: {
  item: MusicDownloadItem
  pending: boolean
  onAction: (action: DownloadAction) => void
}): ReactElement {
  const track = item.track
  const percent = Math.max(0, Math.min(100, Math.round(item.progress)))
  return (
    <li className="flex flex-col gap-[var(--sp-2)] rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-[var(--sp-3)]">
      <div className="flex items-start gap-[var(--sp-3)]">
        <Cover trackId={track?.id ?? item.trackId} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
            {track?.title ?? musicText('music.downloads.unknown_track')}
          </p>
          <p className="truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {track ? musicArtistNames(track) : item.trackId}
          </p>
          <p className="flex flex-wrap items-center gap-[var(--sp-1-5)] text-[length:var(--text-10-5)] tabular text-[var(--text-quaternary)]">
            <span>{musicText(musicQualityLabelKey(item.quality))}</span>
            <span aria-hidden="true">·</span>
            <span>{item.format.toLocaleUpperCase()}</span>
            {item.size !== null && (
              <>
                <span aria-hidden="true">·</span>
                <span>{formatBytes(item.size)}</span>
              </>
            )}
          </p>
        </div>
        <Badge tone={STATUS_TONE[item.status]}>
          {musicText(`music.downloads.status.${item.status}`)}
        </Badge>
      </div>

      <div className="flex flex-col gap-[var(--sp-1)]">
        <progress
          className="h-2 w-full accent-[var(--accent)]"
          max={100}
          value={percent}
          aria-label={musicText('music.downloads.progress_label', {
            title: track?.title ?? item.trackId,
          })}
        />
        <div className="flex items-center justify-between gap-[var(--sp-2)] text-[length:var(--text-10-5)] tabular text-[var(--text-tertiary)]">
          <span>{musicText('music.downloads.progress', { percent })}</span>
        </div>
      </div>

      {item.error && (
        <p role="alert" className="break-words text-[length:var(--text-11)] leading-relaxed text-[var(--danger)]">
          {item.error}
        </p>
      )}

      <DownloadActions item={item} pending={pending} onAction={onAction} />
    </li>
  )
}

function DownloadActions({
  item,
  pending,
  onAction,
}: {
  item: MusicDownloadItem
  pending: boolean
  onAction: (action: DownloadAction) => void
}): ReactElement | null {
  const buttons: Array<{ action: DownloadAction; label: string; icon: ReactElement }> = []
  if (item.status === 'queued' || item.status === 'running') {
    buttons.push({ action: 'pause', label: musicText('music.downloads.pause'), icon: <Pause size={13} /> })
    buttons.push({ action: 'cancel', label: musicText('music.downloads.cancel'), icon: <X size={13} /> })
  } else if (item.status === 'paused') {
    buttons.push({ action: 'resume', label: musicText('music.downloads.resume'), icon: <Play size={13} /> })
    buttons.push({ action: 'cancel', label: musicText('music.downloads.cancel'), icon: <X size={13} /> })
  } else if (item.status === 'failed') {
    buttons.push({ action: 'retry', label: musicText('common.retry'), icon: <RotateCcw size={13} /> })
    buttons.push({ action: 'cancel', label: musicText('music.downloads.cancel'), icon: <X size={13} /> })
  } else if (item.status === 'canceled') {
    buttons.push({ action: 'retry', label: musicText('common.retry'), icon: <RotateCcw size={13} /> })
  } else if (item.status === 'done') {
    return (
      <p className="flex items-center gap-[var(--sp-1-5)] text-[length:var(--text-11)] text-[var(--success)]">
        <Download size={13} aria-hidden="true" />
        {musicText('music.downloads.saved_hint')}
      </p>
    )
  }
  if (buttons.length === 0) return null
  return (
    <div className="flex flex-wrap items-center justify-end gap-[var(--sp-1)]">
      {buttons.map((button) => (
        <Button
          key={button.action}
          size="sm"
          variant={button.action === 'cancel' ? 'ghost' : 'secondary'}
          icon={button.icon}
          disabled={pending}
          onClick={() => onAction(button.action)}
        >
          {button.label}
        </Button>
      ))}
    </div>
  )
}
