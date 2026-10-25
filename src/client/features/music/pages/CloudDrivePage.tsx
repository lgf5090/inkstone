/**
 * My cloud drive: R2 objects, the WebDAV folder the backup settings hold, and Alist mounts.
 *
 * All three sources follow the same gestures — drag files in, tick rows, import or delete them in a
 * batch — while keeping their different contracts: an R2 delete removes bytes and the track row that
 * names them, a WebDAV delete leaves the imported reference behind, and an Alist delete never touches
 * the library. Importing still never moves audio.
 */
import { useEffect, useRef, useState, type DragEvent, type ReactElement } from 'react'
import { CheckSquare, ChevronLeft, Cloud, FileAudio, Folder, HardDrive, Music, Pencil, Search, Trash2, Upload, X } from 'lucide-react'
import {
  MUSIC_DRIVE_IMPORT_MAX_PATHS,
  MUSIC_DRIVE_UPLOAD_MAX_BYTES,
  type MusicDriveR2Entry,
  type MusicDriveSkipReason,
} from '@shared/music/api'
import { MUSIC_ALL_FORMATS, formatFromFilename } from '@shared/music/constants'
import type { MusicTrack } from '@shared/music/model'
import { formatBytes } from '@shared/music/format'
import { Button, IconButton } from '../../../components/primitives'
import { Checkbox, Input } from '../../../components/form'
import { Empty, LoadingBlock } from '../../../components/feedback'
import { confirm } from '../../../components/overlay'
import { navigateToAddress, useSearch } from '../../../lib/app-history'
import { useUi } from '../../../store/ui'
import { musicApi, type MusicCloudEntry } from '../api'
import { enrichImportedTracks } from '../cloud-metadata'
import { musicPathFor } from '../music-address'
import { useMusicQuery } from '../query'
import { SectionHeader } from '../components/SectionHeader'
import { MusicTabs } from '../components/Tabs'
import { SongList } from '../components/SongList'
import { EditTrackDialog } from '../components/EditTrackDialog'
import { AlistPanel } from '../components/AlistPanel'
import { musicText } from '../components/labels'
import { useMusicLibrary } from '../store/library'
import { useMusicPlayer } from '../store/player'
import { toastFailure } from './parts/P2QueryState'
import { MusicPageBody, PageError } from './parts/PageState'

type CloudSource = 'r2' | 'webdav' | 'alist'

const UPLOAD_ACCEPT = MUSIC_ALL_FORMATS.map((format) => `.${format}`).join(',')
const LIBRARY_ADDRESS = musicPathFor({ kind: 'favorites' })
const MAX_UPLOAD_LABEL = Math.round(MUSIC_DRIVE_UPLOAD_MAX_BYTES / (1024 * 1024))
const R2_DELETE_BATCH = 100

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size))
  return out
}

function parentOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
}

function skipReasonKey(reason: MusicDriveSkipReason): string {
  return `music.cloud.skip.${reason}`
}

function baseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

function uploadable(file: File): boolean {
  return file.size > 0 && file.size <= MUSIC_DRIVE_UPLOAD_MAX_BYTES && formatFromFilename(file.name) !== null
}

function toastNothingUploadable(files: readonly File[]): void {
  const tooLarge = files.some((file) => file.size > MUSIC_DRIVE_UPLOAD_MAX_BYTES)
  useUi.getState().toast({
    title: tooLarge
      ? musicText('music.cloud.upload_too_large', { size: MAX_UPLOAD_LABEL })
      : musicText('music.cloud.upload_none'),
    tone: 'warning',
  })
}

function toastImported(count: number): void {
  useUi.getState().toast({
    title: musicText('music.cloud.imported', { count }),
    tone: 'success',
    action: {
      label: musicText('music.cloud.go_library'),
      run: () => navigateToAddress(LIBRARY_ADDRESS),
    },
  })
}

function ImportedTracks({
  tracks,
  emptyTitle,
  emptyHint,
  onEditTrack,
  onRemoveTrack,
  heading = true,
}: {
  tracks: readonly MusicTrack[]
  emptyTitle: string
  emptyHint: string
  onEditTrack?: (track: MusicTrack) => void
  onRemoveTrack?: () => void
  heading?: boolean
}): ReactElement {
  return (
    <section aria-label={musicText('music.cloud.imported_tracks')} className="flex flex-col gap-2">
      {heading && (
        <h2 className="text-[length:var(--text-13)] font-medium text-[var(--text-secondary)]">
          {musicText('music.cloud.imported_tracks')}
        </h2>
      )}
      {tracks.length === 0
        ? <Empty art="folder" compact title={emptyTitle} description={emptyHint} />
        : (
          <SongList
            tracks={tracks}
            onPlay={(track, queue) => { void useMusicPlayer.getState().playTrack(track, { queue }) }}
            onEditTrack={onEditTrack}
            onRemoveTrack={onRemoveTrack}
          />
        )}
    </section>
  )
}

function CloudPane({
  title,
  count,
  actions,
  toolbar,
  children,
}: {
  title: string
  count?: number
  actions?: ReactElement
  toolbar?: ReactElement
  children: ReactElement | ReactElement[]
}): ReactElement {
  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
      <header className="flex min-h-10 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-1.5">
        <h2 className="text-[length:var(--text-13)] font-medium text-[var(--text-secondary)]">{title}</h2>
        {count !== undefined && (
          <span className="text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)]">{count}</span>
        )}
        {actions && <div className="ms-auto flex min-w-0 items-center gap-1">{actions}</div>}
      </header>
      {toolbar && <div className="shrink-0 border-b border-[var(--border-subtle)] px-2 py-1.5">{toolbar}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">{children}</div>
    </section>
  )
}

function matchesFilter(values: readonly (string | null | undefined)[], filter: string): boolean {
  if (!filter) return true
  return values.some((value) => (value ?? '').toLowerCase().includes(filter))
}

function SelectionBar({ count, importable, busy, onImport, onDelete, onClear }: {
  count: number
  importable: number
  busy: boolean
  onImport: () => void
  onDelete: () => void
  onClear: () => void
}): ReactElement {
  return (
    <div
      role="group"
      aria-label={musicText('music.cloud.selected', { count })}
      className="flex flex-wrap items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-2"
    >
      <CheckSquare size={14} className="shrink-0 text-[var(--accent)]" aria-hidden="true" />
      <span className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">
        {musicText('music.cloud.selected', { count })}
      </span>
      <span className="flex-1" />
      {importable > 0 && (
        <Button size="sm" variant="secondary" disabled={busy} onClick={onImport}>
          {musicText('music.cloud.import_selected')}
        </Button>
      )}
      <Button size="sm" variant="secondary" disabled={busy} onClick={onDelete}>
        {musicText('music.cloud.delete_selected')}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onClear}>
        {musicText('music.cloud.clear_selection')}
      </Button>
    </div>
  )
}

export function CloudDrivePage(): ReactElement {
  const search = useSearch()
  const requested = new URLSearchParams(search).get('source')
  const requestedSource: CloudSource | null = requested === 'r2' || requested === 'webdav' || requested === 'alist'
    ? requested
    : null
  const [source, setSource] = useState<CloudSource>(requestedSource ?? 'r2')
  const [path, setPath] = useState('')
  const [pendingPath, setPendingPath] = useState<string | null>(null)
  const [uploadingName, setUploadingName] = useState<string | null>(null)
  const [r2Progress, setR2Progress] = useState<{ done: number; total: number } | null>(null)
  const [selectedPaths, setSelectedPaths] = useState<ReadonlySet<string>>(new Set())
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set())
  const [editingTrack, setEditingTrack] = useState<MusicTrack | null>(null)
  const [dragging, setDragging] = useState(false)
  const [filter, setFilter] = useState('')
  const [alistFileMatches, setAlistFileMatches] = useState(0)
  const webdavInput = useRef<HTMLInputElement>(null)
  const r2Input = useRef<HTMLInputElement>(null)

  // One source, one loader. A WebDAV server that is slow or offline must not hold the R2 tab on a
  // spinner, so each tab only asks for what it is about to show.
  const r2Query = useMusicQuery(async () => {
    const [drive, r2, uploads] = await Promise.all([
      musicApi.drive(),
      musicApi.driveR2(),
      musicApi.tracks('upload'),
    ])
    return { drive, entries: r2.entries, truncated: r2.truncated, tracks: uploads.items }
  }, [], { enabled: source === 'r2' })
  const webdavQuery = useMusicQuery(async () => {
    const [tracks, listing] = await Promise.all([musicApi.tracks('webdav'), musicApi.driveWebdav(path)])
    return { tracks: tracks.items, listing }
  }, [path], { enabled: source === 'webdav' })
  const alistQuery = useMusicQuery(async () => {
    const [tracks, mounts] = await Promise.all([musicApi.tracks('alist'), musicApi.alistMounts()])
    return { tracks: tracks.items, mounts: mounts.mounts }
  }, [], { enabled: source === 'alist' })
  const r2Data = r2Query.data
  const webdavData = webdavQuery.data
  const alistData = alistQuery.data

  useEffect(() => {
    setSelectedPaths(new Set())
    setSelectedKeys(new Set())
    setFilter('')
    setAlistFileMatches(0)
  }, [source, path])

  // A settings shortcut can land on the tab it configures; later manual tab changes are not undone
  // because this effect only follows a change of the address's `source` value.
  useEffect(() => {
    if (requestedSource) setSource(requestedSource)
  }, [requestedSource])

  // Rows imported before metadata reading existed (or while the remote file was unreachable) repair
  // themselves when their tab is opened. The helper marks attempts, so a reload cannot loop.
  useEffect(() => {
    const tracks = source === 'webdav'
      ? webdavData?.tracks
      : source === 'alist'
        ? alistData?.tracks
        : undefined
    if (!tracks || tracks.length === 0) return
    // The reload callbacks belong to the app-level query hook, so finishing after navigation is safe.
    void enrichImportedTracks(tracks).then((enriched) => {
      if (enriched === 0) return
      if (source === 'webdav') webdavQuery.reload()
      else alistQuery.reload()
      void useMusicLibrary.getState().load()
    })
  }, [source, webdavData, alistData, webdavQuery.reload, alistQuery.reload])

  const importFiles = async (paths: string[]): Promise<void> => {
    if (!paths.length) return
    setPendingPath(paths[0] ?? null)
    let imported = 0
    const importedTracks: MusicTrack[] = []
    let firstReason: MusicDriveSkipReason | undefined
    try {
      for (const batch of chunks(paths, MUSIC_DRIVE_IMPORT_MAX_PATHS)) {
        const result = await musicApi.driveWebdavImport(batch)
        imported += result.tracks.length
        importedTracks.push(...result.tracks)
        firstReason ??= result.skipped[0]?.reason as MusicDriveSkipReason | undefined
      }
      if (imported > 0) {
        toastImported(imported)
        webdavQuery.reload()
        void enrichImportedTracks(importedTracks, { limit: 100 }).then((enriched) => {
          if (enriched === 0) return
          webdavQuery.reload()
          void useMusicLibrary.getState().load()
          useUi.getState().toast({
            title: musicText('music.cloud.metadata_enriched', { count: enriched }),
            tone: 'success',
          })
        })
      } else {
        useUi.getState().toast({
          title: musicText('music.cloud.import_none'),
          description: firstReason ? musicText(skipReasonKey(firstReason)) : undefined,
          tone: 'warning',
        })
      }
    } catch (error) {
      toastFailure(musicText('music.cloud.import_failed'), error)
      if (imported > 0) webdavQuery.reload()
    } finally {
      setPendingPath(null)
    }
  }

  const uploadWebdav = async (files: readonly File[]): Promise<void> => {
    const valid = files.filter(uploadable)
    if (valid.length === 0) {
      toastNothingUploadable(files)
      return
    }
    let failed = 0
    for (const [index, file] of valid.entries()) {
      setUploadingName(valid.length > 1
        ? musicText('music.cloud.upload_progress', { done: index + 1, total: valid.length })
        : musicText('music.cloud.uploading', { name: file.name }))
      try {
        const result = await musicApi.driveWebdavUpload(path, file)
        if (valid.length === 1) {
          useUi.getState().toast({
            title: musicText('music.cloud.upload_done', { name: baseName(result.path) }),
            tone: 'success',
          })
        }
      } catch (error) {
        failed += 1
        if (valid.length === 1) toastFailure(musicText('music.cloud.upload_failed'), error)
      }
    }
    setUploadingName(null)
    if (valid.length > 1) {
      useUi.getState().toast({
        title: musicText(failed === valid.length ? 'music.cloud.upload_failed' : 'music.cloud.upload_summary', {
          count: valid.length - failed,
        }),
        description: failed > 0 ? musicText('music.cloud.upload_partial', { count: failed }) : undefined,
        tone: failed > 0 ? 'warning' : 'success',
      })
    }
    webdavQuery.reload()
  }

  const uploadR2 = async (files: readonly File[]): Promise<void> => {
    const valid = files.filter(uploadable)
    if (valid.length === 0) {
      toastNothingUploadable(files)
      return
    }
    const { parseUploadMetadata } = await import('../upload-metadata')
    let failed = 0
    setR2Progress({ done: 0, total: valid.length })
    for (const [index, file] of valid.entries()) {
      try {
        const parsed = await parseUploadMetadata(file)
        const metadata = parsed.ok
          ? parsed.data
          : { title: baseName(file.name).replace(/\.[^.]+$/, ''), artists: [], album: '', durationMs: 0, bitrate: null, lyrics: '' }
        await musicApi.driveR2Upload(file, metadata)
      } catch (error) {
        failed += 1
        console.warn('[inkstone] A cloud-drive upload failed:', error)
      }
      setR2Progress({ done: index + 1, total: valid.length })
    }
    setR2Progress(null)
    useUi.getState().toast({
      title: musicText(failed === valid.length ? 'music.cloud.upload_failed' : 'music.cloud.upload_summary', {
        count: valid.length - failed,
      }),
      description: failed > 0 ? musicText('music.cloud.upload_partial', { count: failed }) : undefined,
      tone: failed > 0 ? 'warning' : 'success',
    })
    r2Query.reload()
  }

  const removeRemote = async (entry: MusicCloudEntry): Promise<void> => {
    const approved = await confirm({
      title: musicText('music.cloud.delete_confirm_title'),
      description: musicText('music.cloud.delete_confirm_body', { name: entry.name }),
      confirmLabel: musicText('music.cloud.delete_remote'),
      tone: 'danger',
    })
    if (!approved) return
    setPendingPath(entry.path)
    try {
      const result = await musicApi.driveWebdavDelete(entry.path)
      useUi.getState().toast({
        title: musicText(result.removed ? 'music.cloud.deleted' : 'music.cloud.delete_missing', {
          name: entry.name,
        }),
        tone: 'success',
      })
      webdavQuery.reload()
    } catch (error) {
      toastFailure(musicText('music.cloud.delete_failed'), error)
    } finally {
      setPendingPath(null)
    }
  }

  const deleteWebdavSelection = async (entries: readonly MusicCloudEntry[]): Promise<void> => {
    const paths = entries.filter((entry) => !entry.isDirectory).map((entry) => entry.path)
    if (paths.length === 0) return
    const approved = await confirm({
      title: musicText('music.cloud.delete_selected_title'),
      description: musicText('music.cloud.delete_selected_body', { count: paths.length }),
      confirmLabel: musicText('music.cloud.delete_selected'),
      tone: 'danger',
    })
    if (!approved) return
    setPendingPath(paths[0] ?? null)
    let removed = 0
    let skipped = 0
    try {
      for (const batch of chunks(paths, MUSIC_DRIVE_IMPORT_MAX_PATHS)) {
        const result = await musicApi.driveWebdavDeleteMany(batch)
        removed += result.removed.length
        skipped += result.skipped.length
      }
      useUi.getState().toast({
        title: musicText('music.cloud.deleted_selected', { count: removed }),
        description: skipped > 0 ? musicText('music.cloud.delete_skipped', { count: skipped }) : undefined,
        tone: skipped > 0 ? 'warning' : 'success',
      })
      setSelectedPaths(new Set())
      webdavQuery.reload()
    } catch (error) {
      toastFailure(musicText('music.cloud.delete_selected_failed'), error)
      if (removed > 0) webdavQuery.reload()
    } finally {
      setPendingPath(null)
    }
  }

  const deleteR2Selection = async (): Promise<void> => {
    const keys = [...selectedKeys]
    if (keys.length === 0) return
    const approved = await confirm({
      title: musicText('music.cloud.delete_selected_title'),
      description: musicText('music.cloud.delete_r2_selected_body', { count: keys.length }),
      confirmLabel: musicText('music.cloud.delete_selected'),
      tone: 'danger',
    })
    if (!approved) return
    let removed = 0
    let skipped = 0
    try {
      for (const batch of chunks(keys, R2_DELETE_BATCH)) {
        const result = await musicApi.driveR2Delete(batch)
        removed += result.removed.length
        skipped += result.skipped.length
      }
      useUi.getState().toast({
        title: musicText('music.cloud.deleted_selected', { count: removed }),
        description: skipped > 0 ? musicText('music.cloud.delete_skipped', { count: skipped }) : undefined,
        tone: skipped > 0 ? 'warning' : 'success',
      })
      setSelectedKeys(new Set())
      r2Query.reload()
      if (removed > 0) void useMusicLibrary.getState().load()
    } catch (error) {
      toastFailure(musicText('music.cloud.delete_selected_failed'), error)
      if (removed > 0) r2Query.reload()
    }
  }

  const toggle = <T,>(current: ReadonlySet<T>, value: T): ReadonlySet<T> => {
    const next = new Set(current)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    return next
  }

  const toggleAll = <T,>(values: readonly T[], current: ReadonlySet<T>): ReadonlySet<T> => {
    if (values.length > 0 && values.every((value) => current.has(value))) return new Set()
    return new Set(values)
  }

  const editR2Entry = async (entry: MusicDriveR2Entry): Promise<void> => {
    if (!entry.trackId) return
    try {
      const answer = await musicApi.track(entry.trackId)
      setEditingTrack(answer.track)
    } catch (error) {
      toastFailure(musicText('music.cloud.track_load_failed'), error)
    }
  }

  const dropProps = (upload: (files: readonly File[]) => Promise<void>, enabled = true) => ({
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!enabled || !event.dataTransfer.types.includes('Files')) return
      event.preventDefault()
      setDragging(true)
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
      setDragging(false)
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!enabled) return
      event.preventDefault()
      setDragging(false)
      const files = [...event.dataTransfer.files]
      if (files.length > 0) void upload(files)
    },
  })

  const normalizedFilter = filter.trim().toLowerCase()
  const r2Tracks = (r2Data?.tracks ?? []).filter((track) => matchesFilter(
    [track.title, track.album, ...track.artists.map((artist) => artist.name)],
    normalizedFilter,
  ))
  const r2Entries = (r2Data?.entries ?? []).filter((entry) => matchesFilter(
    [entry.title, entry.key, ...entry.artists],
    normalizedFilter,
  ))
  const webdavTracks = (webdavData?.tracks ?? []).filter((track) => matchesFilter(
    [track.title, track.album, ...track.artists.map((artist) => artist.name)],
    normalizedFilter,
  ))
  const webdavEntries = (webdavData?.listing.entries ?? []).filter((entry) => matchesFilter(
    [entry.name, entry.path],
    normalizedFilter,
  ))
  const alistTracks = (alistData?.tracks ?? []).filter((track) => matchesFilter(
    [track.title, track.album, ...track.artists.map((artist) => artist.name)],
    normalizedFilter,
  ))
  const webdavSelectable = webdavEntries.filter((entry) => !entry.isDirectory)
  const webdavSelectedEntries = webdavSelectable.filter((entry) => selectedPaths.has(entry.path))
  const webdavImportable = webdavSelectedEntries.filter((entry) => entry.isMedia).length
  const r2Selected = r2Entries.filter((entry) => selectedKeys.has(entry.key))
  const searchCount = source === 'r2'
    ? r2Tracks.length + r2Entries.length
    : source === 'webdav'
      ? webdavTracks.length + webdavEntries.length
      : alistTracks.length + alistFileMatches

  return (
    <MusicPageBody className="h-full min-h-0 overflow-hidden">
      <SectionHeader
        className="shrink-0"
        level={1}
        title={musicText('music.page.cloud')}
        description={musicText('music.cloud.description')}
        action={{
          label: musicText('music.cloud.manage_uploads'),
          onClick: () => navigateToAddress('/music/uploads'),
        }}
      />
      <div className="shrink-0">
        <MusicTabs<CloudSource>
          value={source}
          label={musicText('music.cloud.sources')}
          onChange={(next) => {
            setSource(next)
            setPath('')
          }}
          items={[
            { value: 'r2', label: musicText('music.cloud.source.r2') },
            { value: 'webdav', label: musicText('music.cloud.source.webdav') },
            { value: 'alist', label: musicText('music.cloud.source.alist') },
          ]}
        />
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Input
          value={filter}
          leading={<Search size={14} aria-hidden="true" />}
          trailing={filter ? (
            <button
              type="button"
              aria-label={musicText('music.cloud.clear_search')}
              className="grid h-5 w-5 place-items-center rounded-[var(--r-sm)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
              onClick={() => setFilter('')}
            >
              <X size={13} aria-hidden="true" />
            </button>
          ) : undefined}
          placeholder={musicText('music.cloud.search_placeholder')}
          aria-label={musicText('music.cloud.search_placeholder')}
          className="w-full sm:max-w-[360px]"
          onChange={(event) => setFilter(event.target.value)}
        />
        {normalizedFilter && (
          <span className="text-[length:var(--text-11)] tabular-nums text-[var(--text-tertiary)]">
            {musicText('music.cloud.search_matches', { count: searchCount })}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {source === 'r2' && r2Query.status === 'loading' && !r2Data && (
          <LoadingBlock label={musicText('music.cloud.loading')} />
        )}
        {source === 'r2' && r2Query.status === 'error' && !r2Data && (
          <PageError error={r2Query.error} onRetry={r2Query.reload} />
        )}

      {source === 'r2' && r2Data && (
        <section
          {...dropProps(uploadR2)}
          className="relative flex h-full min-h-0 flex-col gap-3"
          aria-label={musicText('music.cloud.source.r2')}
        >
          {dragging && <DropOverlay />}
          <div className="flex shrink-0 flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2">
              <HardDrive size={15} className="text-[var(--text-tertiary)]" />
              <span className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{musicText('music.cloud.r2_usage')}</span>
              <span className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{formatBytes(r2Data.drive.r2.bytes)}</span>
            </div>
            <div className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2">
              <Cloud size={15} className="text-[var(--text-tertiary)]" />
              <span className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{musicText('music.cloud.r2_objects')}</span>
              <span className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{r2Data.drive.r2.objects}</span>
            </div>
            <span className="flex-1" />
            <Button
              size="sm"
              variant="secondary"
              icon={<Upload size={13} />}
              loading={r2Progress !== null}
              onClick={() => r2Input.current?.click()}
            >
              {musicText('music.cloud.upload_files')}
            </Button>
            <input
              ref={r2Input}
              type="file"
              hidden
              multiple
              accept={UPLOAD_ACCEPT}
              onChange={(event) => {
                const files = [...(event.target.files ?? [])]
                event.target.value = ''
                void uploadR2(files)
              }}
            />
          </div>
          {r2Progress && (
            <p role="status" className="shrink-0 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {musicText('music.cloud.upload_progress', r2Progress)}
            </p>
          )}
          <div className="grid min-h-0 flex-1 grid-rows-2 gap-3 lg:grid-cols-2 lg:grid-rows-1">
            <CloudPane title={musicText('music.cloud.imported_tracks')} count={r2Tracks.length}>
              <ImportedTracks
                heading={false}
                tracks={r2Tracks}
                emptyTitle={normalizedFilter
                  ? musicText('music.cloud.no_match')
                  : musicText('music.cloud.no_imported', { source: musicText('music.cloud.source.r2') })}
                emptyHint={normalizedFilter
                  ? musicText('music.cloud.no_match_hint')
                  : musicText('music.cloud.no_imported_hint', { source: musicText('music.cloud.source.r2') })}
                onEditTrack={setEditingTrack}
                onRemoveTrack={() => { r2Query.reload(); void useMusicLibrary.getState().load() }}
              />
            </CloudPane>
            <CloudPane
              title={musicText('music.cloud.all_files')}
              count={r2Entries.length}
              actions={r2Entries.length > 0 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelectedKeys(toggleAll(r2Entries.map((entry) => entry.key), selectedKeys))}
                >
                  {selectedKeys.size > 0 && r2Selected.length === r2Entries.length
                    ? musicText('music.cloud.clear_selection')
                    : musicText('music.cloud.select_all')}
                </Button>
              ) : undefined}
            >
              <div className="flex flex-col gap-3">
                <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{musicText('music.cloud.drag_hint')}</p>
                {selectedKeys.size > 0 && (
                  <SelectionBar
                    count={selectedKeys.size}
                    importable={0}
                    busy={r2Progress !== null}
                    onImport={() => undefined}
                    onDelete={() => { void deleteR2Selection() }}
                    onClear={() => setSelectedKeys(new Set())}
                  />
                )}
                {r2Entries.length > 0
                  ? (
                      <>
                        <R2List
                          entries={r2Entries}
                          selected={selectedKeys}
                          onToggle={(key) => setSelectedKeys(toggle(selectedKeys, key))}
                          onEdit={(entry) => { void editR2Entry(entry) }}
                        />
                        {r2Data.truncated && (
                          <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{musicText('music.cloud.r2_truncated')}</p>
                        )}
                      </>
                    )
                  : (
                      <Empty
                        art={normalizedFilter ? 'search' : 'folder'}
                        compact
                        title={normalizedFilter && r2Data.entries.length > 0
                          ? musicText('music.cloud.no_match')
                          : musicText('music.cloud.r2_empty')}
                        description={normalizedFilter && r2Data.entries.length > 0
                          ? musicText('music.cloud.no_match_hint')
                          : musicText('music.cloud.r2_empty_hint')}
                      />
                    )}
              </div>
            </CloudPane>
          </div>
        </section>
      )}

      {source === 'webdav' && webdavQuery.status === 'loading' && !webdavData && (
        <LoadingBlock label={musicText('music.cloud.loading')} />
      )}
      {source === 'webdav' && webdavQuery.status === 'error' && !webdavData && (
        <PageError error={webdavQuery.error} onRetry={webdavQuery.reload} />
      )}

      {webdavData && source === 'webdav' && (
        <section
          {...dropProps(uploadWebdav, webdavData.listing.configured)}
          className="relative flex h-full min-h-0 flex-col gap-3"
          aria-label={musicText('music.cloud.source.webdav')}
        >
          {dragging && <DropOverlay />}
          {webdavData.listing.configured && (
            <div className="flex shrink-0 flex-wrap items-center gap-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              <button
                type="button"
                className="rounded-[var(--r-sm)] px-1.5 py-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                onClick={() => setPath('')}
              >
                {webdavData.listing.dir || '/'}
              </button>
              {path.split('/').filter(Boolean).map((segment, index, all) => {
                const target = all.slice(0, index + 1).join('/')
                return (
                  <span key={target} className="flex items-center gap-1">
                    <span aria-hidden>/</span>
                    <button
                      type="button"
                      className="rounded-[var(--r-sm)] px-1.5 py-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                      onClick={() => setPath(target)}
                    >
                      {segment}
                    </button>
                  </span>
                )
              })}
              {path && (
                <Button size="sm" variant="ghost" icon={<ChevronLeft size={13} />} onClick={() => setPath(parentOf(path))}>
                  {musicText('music.cloud.up')}
                </Button>
              )}
              <span className="flex-1" />
              <Button
                size="sm"
                variant="secondary"
                icon={<Upload size={13} />}
                loading={uploadingName !== null}
                onClick={() => webdavInput.current?.click()}
              >
                {musicText('music.cloud.upload')}
              </Button>
              <input
                ref={webdavInput}
                type="file"
                hidden
                multiple
                accept={UPLOAD_ACCEPT}
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])]
                  event.target.value = ''
                  void uploadWebdav(files)
                }}
              />
            </div>
          )}
          {uploadingName && (
            <p role="status" className="shrink-0 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{uploadingName}</p>
          )}
          <div className="grid min-h-0 flex-1 grid-rows-2 gap-3 lg:grid-cols-2 lg:grid-rows-1">
            <CloudPane title={musicText('music.cloud.imported_tracks')} count={webdavTracks.length}>
              <ImportedTracks
                heading={false}
                tracks={webdavTracks}
                emptyTitle={normalizedFilter
                  ? musicText('music.cloud.no_match')
                  : musicText('music.cloud.no_imported', { source: musicText('music.cloud.source.webdav') })}
                emptyHint={normalizedFilter
                  ? musicText('music.cloud.no_match_hint')
                  : musicText('music.cloud.no_imported_hint', { source: musicText('music.cloud.source.webdav') })}
                onEditTrack={setEditingTrack}
                onRemoveTrack={() => { webdavQuery.reload(); void useMusicLibrary.getState().load() }}
              />
            </CloudPane>
            <CloudPane
              title={musicText('music.cloud.all_files')}
              count={webdavData.listing.configured ? webdavEntries.length : undefined}
              toolbar={webdavData.listing.configured && (webdavSelectable.length > 0 || selectedPaths.size > 0) ? (
                <div className="flex flex-col gap-2">
                  {webdavSelectable.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setSelectedPaths(toggleAll(webdavSelectable.map((entry) => entry.path), selectedPaths))}
                      >
                        {webdavSelectedEntries.length === webdavSelectable.length
                          ? musicText('music.cloud.clear_selection')
                          : musicText('music.cloud.select_all')}
                      </Button>
                      <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{musicText('music.cloud.select_hint')}</span>
                    </div>
                  )}
                  {selectedPaths.size > 0 && (
                    <SelectionBar
                      count={selectedPaths.size}
                      importable={webdavImportable}
                      busy={pendingPath !== null}
                      onImport={() => {
                        const paths = webdavSelectedEntries.filter((entry) => entry.isMedia).map((entry) => entry.path)
                        void importFiles(paths).then(() => setSelectedPaths(new Set()))
                      }}
                      onDelete={() => { void deleteWebdavSelection(webdavSelectedEntries) }}
                      onClear={() => setSelectedPaths(new Set())}
                    />
                  )}
                </div>
              ) : undefined}
            >
              {!webdavData.listing.configured
                ? (
                  <Empty
                    art="folder"
                    title={musicText('music.cloud.not_configured')}
                    description={musicText('music.cloud.not_configured_hint')}
                  />
                )
                : webdavEntries.length === 0
                  ? (
                    <Empty
                      art={normalizedFilter && webdavData.listing.entries.length > 0 ? 'search' : 'folder'}
                      title={normalizedFilter && webdavData.listing.entries.length > 0
                        ? musicText('music.cloud.no_match')
                        : musicText('music.cloud.empty')}
                      description={normalizedFilter && webdavData.listing.entries.length > 0
                        ? musicText('music.cloud.no_match_hint')
                        : undefined}
                    />
                  )
                  : (
                    <div className="flex flex-col gap-2">
                      <ul className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
                        {webdavEntries.map((entry) => {
                          const busy = pendingPath === entry.path
                          return (
                            <li key={entry.path} className="flex min-w-0 items-center gap-2 px-3 py-1.5">
                              {!entry.isDirectory && (
                                <Checkbox
                                  checked={selectedPaths.has(entry.path)}
                                  label={<span className="sr-only">{musicText('music.cloud.select_file', { name: entry.name })}</span>}
                                  className="size-8 min-h-0 justify-center"
                                  onChange={() => setSelectedPaths(toggle(selectedPaths, entry.path))}
                                />
                              )}
                              <button
                                type="button"
                                disabled={!entry.isDirectory && !entry.isMedia}
                                onClick={() => {
                                  if (entry.isDirectory) setPath(entry.path)
                                }}
                                className="flex min-w-0 flex-1 items-center gap-3 rounded-[var(--r-sm)] py-1 text-left transition-colors hover:text-[var(--text-primary)] disabled:cursor-default disabled:opacity-50"
                              >
                                {entry.isDirectory ? <Folder size={15} className="shrink-0 text-[var(--text-tertiary)]" /> : <FileAudio size={15} className="shrink-0 text-[var(--text-tertiary)]" />}
                                <span className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)] text-[var(--text-primary)]">{entry.name}</span>
                                {!entry.isDirectory && <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{formatBytes(entry.sizeBytes)}</span>}
                              </button>
                              {!entry.isDirectory && entry.isMedia && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  loading={busy}
                                  onClick={() => void importFiles([entry.path])}
                                >
                                  {musicText('music.cloud.import')}
                                </Button>
                              )}
                              {!entry.isDirectory && (
                                <IconButton
                                  label={musicText('music.cloud.delete_remote')}
                                  size="sm"
                                  disabled={busy}
                                  onClick={() => void removeRemote(entry)}
                                >
                                  <Trash2 size={14} />
                                </IconButton>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                      {webdavData.listing.truncated && (
                        <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{musicText('music.cloud.truncated')}</p>
                      )}
                    </div>
                  )}
            </CloudPane>
          </div>
        </section>
      )}

      {source === 'alist' && alistQuery.status === 'loading' && !alistData && (
        <LoadingBlock label={musicText('music.cloud.loading')} />
      )}
      {source === 'alist' && alistQuery.status === 'error' && !alistData && (
        <PageError error={alistQuery.error} onRetry={alistQuery.reload} />
      )}

      {alistData && source === 'alist' && (
        <div
          className="grid h-full min-h-0 grid-rows-2 gap-3 lg:grid-cols-2 lg:grid-rows-1"
          aria-label={musicText('music.cloud.source.alist')}
        >
          <CloudPane title={musicText('music.cloud.imported_tracks')} count={alistTracks.length}>
            <ImportedTracks
              heading={false}
              tracks={alistTracks}
              emptyTitle={normalizedFilter
                ? musicText('music.cloud.no_match')
                : musicText('music.cloud.no_imported', { source: musicText('music.cloud.source.alist') })}
              emptyHint={normalizedFilter
                ? musicText('music.cloud.no_match_hint')
                : musicText('music.cloud.no_imported_hint', { source: musicText('music.cloud.source.alist') })}
              onEditTrack={setEditingTrack}
              onRemoveTrack={() => { alistQuery.reload(); void useMusicLibrary.getState().load() }}
            />
          </CloudPane>
          <CloudPane title={musicText('music.cloud.all_files')}>
            <AlistPanel
              mounts={alistData.mounts}
              onChanged={alistQuery.reload}
              filter={normalizedFilter}
              onMatchesChange={setAlistFileMatches}
            />
          </CloudPane>
        </div>
      )}
      </div>

      <EditTrackDialog
        track={editingTrack}
        open={editingTrack !== null}
        onClose={() => setEditingTrack(null)}
        onSaved={() => {
          setEditingTrack(null)
          r2Query.reload()
          webdavQuery.reload()
          alistQuery.reload()
          void useMusicLibrary.getState().load()
        }}
      />
    </MusicPageBody>
  )
}

function R2List({ entries, selected, onToggle, onEdit }: {
  entries: readonly MusicDriveR2Entry[]
  selected: ReadonlySet<string>
  onToggle: (key: string) => void
  onEdit: (entry: MusicDriveR2Entry) => void
}): ReactElement {
  return (
    <ul
      aria-label={musicText('music.cloud.r2_files')}
      className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]"
    >
      {entries.map((entry) => (
        <li key={entry.key} className="flex min-w-0 items-center gap-2 px-3 py-1.5">
          <Checkbox
            checked={selected.has(entry.key)}
            label={<span className="sr-only">{musicText('music.cloud.select_file', { name: entry.title })}</span>}
            className="size-8 min-h-0 justify-center"
            onChange={() => onToggle(entry.key)}
          />
          <Music size={15} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
          <span className="flex min-w-0 flex-1 flex-col gap-px">
            <span className="truncate text-[length:var(--text-12-5)] text-[var(--text-primary)]">{entry.title}</span>
            <span className="truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {[entry.artists.join(' / '), entry.format.toUpperCase(), formatBytes(entry.size)].filter(Boolean).join(' · ')}
            </span>
          </span>
          {entry.trackId && (
            <IconButton label={musicText('music.cloud.edit_track')} size="sm" onClick={() => onEdit(entry)}>
              <Pencil size={14} />
            </IconButton>
          )}
        </li>
      ))}
    </ul>
  )
}

function DropOverlay(): ReactElement {
  return (
    <div className="pointer-events-none absolute inset-0 z-[var(--z-popover)] flex items-center justify-center rounded-[var(--r-lg)] border-2 border-dashed border-[var(--accent)] bg-[var(--bg-base)]">
      <span className="flex items-center gap-2 text-[length:var(--text-13)] font-medium text-[var(--accent)]">
        <Upload size={16} aria-hidden="true" />
        {musicText('music.cloud.drop_here')}
      </span>
    </div>
  )
}
