/**
 * Alist mounts and the folder browser behind the cloud page's third source.
 *
 * The panel owns only its own server selection and the two calls the browser makes; the parent owns
 * the mount list so creating or deleting one can refresh every source. A token is collected once and
 * never shown again: the server returns whether one is stored, not what it is.
 */
import { useState, type FormEvent, type ReactElement } from 'react'
import { ChevronLeft, Folder, FileAudio, Plus, Search, Trash2 } from 'lucide-react'
import type { MusicMount } from '@shared/music/model'
import type { MusicAlistEntry, MusicDriveSkipReason } from '@shared/music/api'
import { Badge, Button } from '../../../components/primitives'
import { Input, Select } from '../../../components/form'
import { Empty, LoadingBlock } from '../../../components/feedback'
import { Modal, confirm } from '../../../components/overlay'
import { formatBytes } from '@shared/music/format'
import { useUi } from '../../../store/ui'
import { musicApi } from '../api'
import { useMusicQuery } from '../query'
import { musicText } from './labels'
import { PageError } from '../pages/parts/PageState'

function parentOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
}

function skipReasonKey(reason: MusicDriveSkipReason): string {
  return `music.cloud.skip.${reason}`
}

function MountDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (mount: MusicMount) => void
}): ReactElement {
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [rootPath, setRootPath] = useState('/')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const answer = await musicApi.createAlistMount({
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        rootPath: rootPath.trim() || '/',
        token,
      })
      onCreated(answer.mount)
      setName('')
      setBaseUrl('')
      setRootPath('/')
      setToken('')
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={musicText('music.cloud.alist.add')}
      width={560}
      dismissible={!busy}
      footer={(
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>{musicText('common.cancel')}</Button>
          <Button variant="primary" size="sm" loading={busy} onClick={() => { document.getElementById('alist-mount-form')?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })) }}>
            {musicText('music.cloud.alist.save')}
          </Button>
        </div>
      )}
    >
      <form id="alist-mount-form" onSubmit={(event) => { void submit(event) }} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-[length:var(--text-12)] text-[var(--text-secondary)]">
          {musicText('music.cloud.alist.name')}
          <Input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} />
        </label>
        <label className="flex flex-col gap-1 text-[length:var(--text-12)] text-[var(--text-secondary)]">
          {musicText('music.cloud.alist.url')}
          <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required maxLength={2048} placeholder="https://alist.example.com" inputMode="url" />
        </label>
        <label className="flex flex-col gap-1 text-[length:var(--text-12)] text-[var(--text-secondary)]">
          {musicText('music.cloud.alist.root')}
          <Input value={rootPath} onChange={(event) => setRootPath(event.target.value)} maxLength={1024} placeholder={musicText('music.cloud.alist.root_placeholder')} />
        </label>
        <label className="flex flex-col gap-1 text-[length:var(--text-12)] text-[var(--text-secondary)]">
          {musicText('music.cloud.alist.token')}
          <Input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} required maxLength={4096} />
        </label>
        {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
      </form>
    </Modal>
  )
}

function EntryList({
  entries,
  onOpen,
  onImport,
  importingPath,
}: {
  entries: MusicAlistEntry[]
  onOpen: (entry: MusicAlistEntry) => void
  onImport: (entry: MusicAlistEntry) => void
  importingPath: string | null
}): ReactElement {
  return (
    <ul className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
      {entries.map((entry) => (
        <li key={entry.path} className="flex min-w-0 items-center gap-2 px-2">
          <button
            type="button"
            disabled={!entry.isDirectory && !entry.isMedia}
            onClick={() => onOpen(entry)}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-[var(--r-sm)] px-1 py-2.5 text-left transition-colors hover:text-[var(--text-primary)] disabled:cursor-default disabled:opacity-50"
          >
            {entry.isDirectory ? <Folder size={15} className="shrink-0 text-[var(--text-tertiary)]" /> : <FileAudio size={15} className="shrink-0 text-[var(--text-tertiary)]" />}
            <span className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)] text-[var(--text-primary)]">{entry.name}</span>
            {!entry.isDirectory && <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{formatBytes(entry.sizeBytes)}</span>}
          </button>
          {!entry.isDirectory && entry.isMedia && (
            <Button
              size="sm"
              variant="ghost"
              loading={importingPath === entry.path}
              onClick={() => onImport(entry)}
            >
              {musicText('music.cloud.import')}
            </Button>
          )}
        </li>
      ))}
    </ul>
  )
}

export function AlistPanel({ mounts, onChanged }: { mounts: MusicMount[]; onChanged: () => void }): ReactElement {
  const [addOpen, setAddOpen] = useState(false)
  const [selected, setSelected] = useState('')
  const [path, setPath] = useState('')
  const [keywords, setKeywords] = useState('')
  const [search, setSearch] = useState<MusicAlistEntry[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [importingPath, setImportingPath] = useState<string | null>(null)
  const active = mounts.find((mount) => mount.id === selected) ?? mounts[0] ?? null
  const query = useMusicQuery(async () => {
    if (!active) return null
    return await musicApi.alistList(active.id, path)
  }, [active?.id, path])

  const choose = (mount: MusicMount): void => {
    setSelected(mount.id)
    setPath('')
    setSearch(null)
    setKeywords('')
  }

  const runSearch = async (): Promise<void> => {
    if (!active || !keywords.trim()) return
    setSearching(true)
    setSearchError(null)
    try {
      const answer = await musicApi.alistSearch(active.id, keywords.trim())
      setSearch(answer.entries)
    } catch (reason) {
      setSearchError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSearching(false)
    }
  }

  const importPaths = async (paths: string[]): Promise<void> => {
    if (!active || paths.length === 0) return
    setImportingPath(paths[0] ?? null)
    let imported = 0
    let skipped = 0
    let firstSkip: MusicDriveSkipReason | undefined
    try {
      // The route accepts fifty paths at a time; a directory may hold more.
      for (let start = 0; start < paths.length; start += 50) {
        const result = await musicApi.alistImport(active.id, paths.slice(start, start + 50))
        imported += result.tracks.length
        skipped += result.skipped.length
        firstSkip ??= result.skipped[0]?.reason as MusicDriveSkipReason | undefined
      }
      if (imported > 0) {
        useUi.getState().toast({
          title: musicText('music.cloud.imported', { count: imported }),
          description: skipped > 0 && firstSkip
            ? musicText(skipReasonKey(firstSkip))
            : undefined,
          tone: skipped > 0 ? 'warning' : 'success',
        })
        onChanged()
      } else {
        useUi.getState().toast({
          title: musicText('music.cloud.import_none'),
          description: firstSkip ? musicText(skipReasonKey(firstSkip)) : undefined,
          tone: 'warning',
        })
      }
    } catch (reason) {
      useUi.getState().toast({
        title: musicText('music.cloud.import_failed'),
        description: reason instanceof Error ? reason.message : String(reason),
        tone: 'danger',
      })
      if (imported > 0) onChanged()
    } finally {
      setImportingPath(null)
    }
  }

  const remove = async (mount: MusicMount): Promise<void> => {
    const approved = await confirm({
      title: musicText('music.cloud.alist.delete'),
      description: mount.name,
      confirmLabel: musicText('common.delete'),
      tone: 'danger',
    })
    if (!approved) return
    setBusy(true)
    try {
      await musicApi.deleteAlistMount(mount.id)
      if (selected === mount.id) setSelected('')
      onChanged()
    } catch (reason) {
      setSearchError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const entries = search ?? query.data?.listing.entries ?? []
  const truncated = search ? false : query.data?.listing.truncated ?? false

  return (
    <section className="flex flex-col gap-3" aria-label={musicText('music.cloud.source.alist')}>
      <div className="flex flex-wrap items-center gap-2">
        {mounts.length > 0 && (
          <Select
            aria-label={musicText('music.cloud.alist.mount')}
            value={active?.id ?? ''}
            onChange={(event) => {
              const mount = mounts.find((entry) => entry.id === event.target.value)
              if (mount) choose(mount)
            }}
            className="w-auto min-w-[140px]"
          >
            {mounts.map((mount) => <option key={mount.id} value={mount.id}>{mount.name}</option>)}
          </Select>
        )}
        <Button size="sm" variant="secondary" icon={<Plus size={13} />} onClick={() => setAddOpen(true)}>
          {musicText('music.cloud.alist.add')}
        </Button>
        {active && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Trash2 size={13} />}
            disabled={busy}
            onClick={() => { void remove(active) }}
          >
            {musicText('music.cloud.alist.delete')}
          </Button>
        )}
      </div>

      {mounts.length === 0
        ? <Empty art="folder" title={musicText('music.cloud.alist_title')} description={musicText('music.cloud.alist_hint')} />
        : (
          <>
            <form
              role="search"
              className="flex min-w-0 flex-wrap items-center gap-2"
              onSubmit={(event) => { event.preventDefault(); void runSearch() }}
            >
              <Input
                value={keywords}
                onChange={(event) => setKeywords(event.target.value)}
                placeholder={musicText('music.cloud.alist.search')}
                aria-label={musicText('music.cloud.alist.search')}
                className="min-w-[180px] flex-1"
              />
              <Button size="sm" variant="secondary" icon={<Search size={13} />} loading={searching} type="submit">
                {musicText('music.cloud.alist.search_action')}
              </Button>
              {search !== null && (
                <Button size="sm" variant="ghost" onClick={() => { setSearch(null); setKeywords('') }}>
                  {musicText('common.clear')}
                </Button>
              )}
            </form>

            {active?.status === 'error' && (
              <Badge tone="warning">{musicText('music.cloud.alist.status_error')}</Badge>
            )}
            {searchError && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{searchError}</p>}

            {search === null && (
              <div className="flex flex-wrap items-center gap-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                <button type="button" className="rounded-[var(--r-sm)] px-1.5 py-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]" onClick={() => setPath('')}>
                  {active?.name ?? musicText('music.cloud.source.alist')}
                </button>
                {path.split('/').filter(Boolean).map((segment, index, all) => {
                  const target = all.slice(0, index + 1).join('/')
                  return (
                    <span key={target} className="flex items-center gap-1">
                      <span aria-hidden>/</span>
                      <button type="button" className="rounded-[var(--r-sm)] px-1.5 py-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]" onClick={() => setPath(target)}>
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
            )}

            {search === null && query.status === 'loading' && <LoadingBlock label={musicText('music.cloud.loading')} />}
            {search === null && query.status === 'error' && <PageError error={query.error} onRetry={query.reload} compact />}
            {search === null && query.status === 'ready' && entries.length === 0 && (
              <Empty art="folder" title={musicText('music.cloud.empty')} />
            )}
            {entries.some((entry) => !entry.isDirectory && entry.isMedia) && (
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="secondary"
                  loading={importingPath !== null}
                  onClick={() => {
                    void importPaths(entries.filter((entry) => !entry.isDirectory && entry.isMedia).map((entry) => entry.path))
                  }}
                >
                  {musicText('music.cloud.alist.import_all')}
                </Button>
              </div>
            )}
            {entries.length > 0 && (
              <EntryList
                entries={entries}
                importingPath={importingPath}
                onImport={(entry) => { void importPaths([entry.path]) }}
                onOpen={(entry) => {
                  if (entry.isDirectory) {
                    setPath(entry.path)
                    setSearch(null)
                  }
                }}
              />
            )}
            {truncated && <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{musicText('music.cloud.truncated')}</p>}
          </>
        )}

      <MountDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={(mount) => {
          choose(mount)
          onChanged()
        }}
      />
    </section>
  )
}
