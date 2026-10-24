/**
 * My cloud drive: what this account stores in R2, and one folder of the WebDAV target the backup
 * settings already hold. The page is a reader, not an importer yet: it shows the shape of the drive
 * and says honestly when a source has not been configured.
 */
import { useState, type ReactElement } from 'react'
import { ChevronLeft, Cloud, FileAudio, Folder, HardDrive } from 'lucide-react'
import { formatBytes } from '@shared/music/format'
import { Badge, Button } from '../../../components/primitives'
import { Empty, LoadingBlock } from '../../../components/feedback'
import { navigateToAddress } from '../../../lib/app-history'
import { musicApi } from '../api'
import { useMusicQuery } from '../query'
import { SectionHeader } from '../components/SectionHeader'
import { MusicTabs } from '../components/Tabs'
import { musicText } from '../components/labels'
import { MusicPageBody, PageError } from './parts/PageState'

type CloudSource = 'r2' | 'webdav' | 'alist'

function parentOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
}

function uploadStatusKey(status: 'uploading' | 'completed' | 'failed' | 'aborted'): string {
  if (status === 'completed') return 'music.upload.status.done'
  return `music.upload.status.${status}`
}

export function CloudDrivePage(): ReactElement {
  const [source, setSource] = useState<CloudSource>('webdav')
  const [path, setPath] = useState('')
  const query = useMusicQuery(async () => {
    const [drive, uploads, webdav] = await Promise.all([
      musicApi.drive(),
      musicApi.uploads(),
      musicApi.driveWebdav(path),
    ])
    return { drive, uploads: uploads.items, webdav }
  }, [path])
  const data = query.data

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
      {query.status === 'error' && !data && <PageError error={query.error} onRetry={query.reload} />}
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
          {data.uploads.length === 0
            ? <Empty art="folder" title={musicText('music.cloud.r2_empty')} description={musicText('music.cloud.r2_empty_hint')} />
            : (
              <ul className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
                {data.uploads.slice(0, 50).map((upload) => (
                  <li key={upload.id} className="flex min-w-0 items-center gap-3 px-3 py-2.5">
                    <FileAudio size={15} className="shrink-0 text-[var(--text-tertiary)]" />
                    <span className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)] text-[var(--text-primary)]">{upload.filename}</span>
                    <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{formatBytes(upload.size)}</span>
                    <Badge tone={upload.status === 'completed' ? 'success' : upload.status === 'failed' ? 'danger' : 'neutral'}>
                      {musicText(uploadStatusKey(upload.status))}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
        </section>
      )}

      {data && source === 'webdav' && (
        <section className="flex flex-col gap-3" aria-label={musicText('music.cloud.source.webdav')}>
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
                </div>
                {data.webdav.entries.length === 0
                  ? <Empty art="folder" title={musicText('music.cloud.empty')} />
                  : (
                    <ul className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
                      {data.webdav.entries.map((entry) => (
                        <li key={entry.path}>
                          <button
                            type="button"
                            disabled={!entry.isDirectory && !entry.isMedia}
                            onClick={() => {
                              if (entry.isDirectory) setPath(entry.path)
                            }}
                            className="flex w-full min-w-0 items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-default disabled:opacity-50"
                          >
                            {entry.isDirectory ? <Folder size={15} className="shrink-0 text-[var(--text-tertiary)]" /> : <FileAudio size={15} className="shrink-0 text-[var(--text-tertiary)]" />}
                            <span className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)] text-[var(--text-primary)]">{entry.name}</span>
                            {!entry.isDirectory && <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{formatBytes(entry.sizeBytes)}</span>}
                          </button>
                        </li>
                      ))}
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
        <Empty art="folder" title={musicText('music.cloud.alist_title')} description={musicText('music.cloud.alist_hint')} />
      )}
    </MusicPageBody>
  )
}
