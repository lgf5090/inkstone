/**
 * My cloud drive: what this account stores in R2, and the WebDAV folder the backup settings already
 * hold. The WebDAV side can import a file as a library reference, upload into the folder on screen
 * and delete a remote file; an import never moves the audio, and a remote delete never touches the
 * library row that still names it.
 */
import { useRef, useState, type ChangeEvent, type ReactElement } from 'react'
import { ChevronLeft, Cloud, FileAudio, Folder, HardDrive, Trash2, Upload } from 'lucide-react'
import { MUSIC_DRIVE_UPLOAD_MAX_BYTES, type MusicDriveSkipReason } from '@shared/music/api'
import { MUSIC_ALL_FORMATS } from '@shared/music/constants'
import type { MusicTrack } from '@shared/music/model'
import { formatBytes } from '@shared/music/format'
import { Button, IconButton } from '../../../components/primitives'
import { Empty, LoadingBlock } from '../../../components/feedback'
import { confirm } from '../../../components/overlay'
import { navigateToAddress } from '../../../lib/app-history'
import { useUi } from '../../../store/ui'
import { musicApi, type MusicCloudEntry } from '../api'
import { musicPathFor } from '../music-address'
import { useMusicQuery } from '../query'
import { SectionHeader } from '../components/SectionHeader'
import { MusicTabs } from '../components/Tabs'
import { SongList } from '../components/SongList'
import { AlistPanel } from '../components/AlistPanel'
import { musicText } from '../components/labels'
import { useMusicPlayer } from '../store/player'
import { toastFailure } from './parts/P2QueryState'
import { MusicPageBody, PageError } from './parts/PageState'

type CloudSource = 'r2' | 'webdav' | 'alist'

const UPLOAD_ACCEPT = MUSIC_ALL_FORMATS.map((format) => `.${format}`).join(',')
const LIBRARY_ADDRESS = musicPathFor({ kind: 'favorites' })

function parentOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
}

function skipReasonKey(reason: MusicDriveSkipReason): string {
  return `music.cloud.skip.${reason}`
}

function baseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
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
}: {
  tracks: readonly MusicTrack[]
  emptyTitle: string
  emptyHint: string
}): ReactElement {
  return (
    <section aria-label={musicText('music.cloud.imported_tracks')} className="flex flex-col gap-2">
      <h2 className="text-[length:var(--text-13)] font-medium text-[var(--text-secondary)]">
        {musicText('music.cloud.imported_tracks')}
      </h2>
      {tracks.length === 0
        ? <Empty art="folder" compact title={emptyTitle} description={emptyHint} />
        : (
          <SongList
            tracks={tracks}
            onPlay={(track, queue) => { void useMusicPlayer.getState().playTrack(track, { queue }) }}
          />
        )}
    </section>
  )
}

export function CloudDrivePage(): ReactElement {
  const [source, setSource] = useState<CloudSource>('webdav')
  const [path, setPath] = useState('')
  const [pendingPath, setPendingPath] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const query = useMusicQuery(async () => {
    const [drive, localTracks, webdavTracks, alistTracks, webdav, alist] = await Promise.all([
      musicApi.drive(),
      musicApi.tracks('upload'),
      musicApi.tracks('webdav'),
      musicApi.tracks('alist'),
      musicApi.driveWebdav(path),
      musicApi.alistMounts(),
    ])
    return {
      drive,
      localTracks: localTracks.items,
      webdavTracks: webdavTracks.items,
      alistTracks: alistTracks.items,
      webdav,
      alist: alist.mounts,
    }
  }, [path])
  const data = query.data
  const reload = query.reload

  const importFiles = async (paths: string[]): Promise<void> => {
    if (!paths.length) return
    setPendingPath(paths[0] ?? null)
    try {
      const result = await musicApi.driveWebdavImport(paths)
      if (result.tracks.length > 0) {
        toastImported(result.tracks.length)
        reload()
      } else {
        const reason = result.skipped[0]?.reason
        useUi.getState().toast({
          title: musicText('music.cloud.import_none'),
          description: reason ? musicText(skipReasonKey(reason)) : undefined,
          tone: 'warning',
        })
      }
    } catch (error) {
      toastFailure(musicText('music.cloud.import_failed'), error)
    } finally {
      setPendingPath(null)
    }
  }

  const uploadFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    // Clear the picker so choosing the same file again still fires a change.
    event.target.value = ''
    if (!file) return
    if (file.size > MUSIC_DRIVE_UPLOAD_MAX_BYTES) {
      useUi.getState().toast({
        title: musicText('music.cloud.upload_too_large', {
          size: Math.round(MUSIC_DRIVE_UPLOAD_MAX_BYTES / (1024 * 1024)),
        }),
        tone: 'warning',
      })
      return
    }
    setUploading(true)
    try {
      const result = await musicApi.driveWebdavUpload(path, file)
      useUi.getState().toast({
        title: musicText('music.cloud.upload_done', { name: baseName(result.path) }),
        tone: 'success',
      })
      reload()
    } catch (error) {
      toastFailure(musicText('music.cloud.upload_failed'), error)
    } finally {
      setUploading(false)
    }
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
      reload()
    } catch (error) {
      toastFailure(musicText('music.cloud.delete_failed'), error)
    } finally {
      setPendingPath(null)
    }
  }

  return (
    <MusicPageBody>
      <SectionHeader
        level={1}
        title={musicText('music.page.cloud')}
        description={musicText('music.cloud.description')}
        action={{
          label: musicText('music.cloud.manage_uploads'),
          onClick: () => navigateToAddress('/music/uploads'),
        }}
      />
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

      {query.status === 'loading' && !data && <LoadingBlock label={musicText('music.cloud.loading')} />}
      {query.status === 'error' && !data && <PageError error={query.error} onRetry={reload} />}
      {data && source === 'r2' && (
        <section className="flex flex-col gap-4" aria-label={musicText('music.cloud.source.r2')}>
          <div className="flex flex-wrap gap-3">
            <div className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2">
              <HardDrive size={15} className="text-[var(--text-tertiary)]" />
              <span className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{musicText('music.cloud.r2_usage')}</span>
              <span className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{formatBytes(data.drive.r2.bytes)}</span>
            </div>
            <div className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2">
              <Cloud size={15} className="text-[var(--text-tertiary)]" />
              <span className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{musicText('music.cloud.r2_objects')}</span>
              <span className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{data.drive.r2.objects}</span>
            </div>
          </div>
          <ImportedTracks
            tracks={data.localTracks}
            emptyTitle={musicText('music.cloud.r2_empty')}
            emptyHint={musicText('music.cloud.r2_empty_hint')}
          />
        </section>
      )}

      {data && source === 'webdav' && (
        <section className="flex flex-col gap-3" aria-label={musicText('music.cloud.source.webdav')}>
          <ImportedTracks
            tracks={data.webdavTracks}
            emptyTitle={musicText('music.cloud.no_imported', { source: musicText('music.cloud.source.webdav') })}
            emptyHint={musicText('music.cloud.no_imported_hint', { source: musicText('music.cloud.source.webdav') })}
          />
          {!data.webdav.configured
            ? (
              <Empty
                art="folder"
                title={musicText('music.cloud.not_configured')}
                description={musicText('music.cloud.not_configured_hint')}
              />
            )
            : (
              <>
                <div className="flex flex-wrap items-center gap-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                  <button
                    type="button"
                    className="rounded-[var(--r-sm)] px-1.5 py-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                    onClick={() => setPath('')}
                  >
                    {data.webdav.dir || '/'}
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
                    loading={uploading}
                    onClick={() => fileInput.current?.click()}
                  >
                    {musicText('music.cloud.upload')}
                  </Button>
                  <input
                    ref={fileInput}
                    type="file"
                    hidden
                    accept={UPLOAD_ACCEPT}
                    onChange={(event) => void uploadFile(event)}
                  />
                </div>
                {data.webdav.entries.length === 0
                  ? <Empty art="folder" title={musicText('music.cloud.empty')} />
                  : (
                    <ul className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
                      {data.webdav.entries.map((entry) => {
                        const busy = pendingPath === entry.path
                        return (
                          <li key={entry.path} className="flex min-w-0 items-center gap-2 px-3 py-1.5">
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
                  )}
                {data.webdav.truncated && (
                  <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{musicText('music.cloud.truncated')}</p>
                )}
              </>
            )}
        </section>
      )}

      {data && source === 'alist' && (
        <section className="flex flex-col gap-3" aria-label={musicText('music.cloud.source.alist')}>
          <ImportedTracks
            tracks={data.alistTracks}
            emptyTitle={musicText('music.cloud.no_imported', { source: musicText('music.cloud.source.alist') })}
            emptyHint={musicText('music.cloud.no_imported_hint', { source: musicText('music.cloud.source.alist') })}
          />
          <AlistPanel mounts={data.alist} onChanged={query.reload} />
        </section>
      )}
    </MusicPageBody>
  )
}
