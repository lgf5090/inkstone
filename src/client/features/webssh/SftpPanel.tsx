import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import {
  ArrowUp,
  Download,
  FilePen,
  Folder,
  FolderPlus,
  Maximize2,
  Minimize2,
  PanelLeft,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import type { WebsshSftpEntry } from '@shared/webssh/types'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Empty } from '../../components/feedback'
import { Field, Input } from '../../components/form'
import { Modal, Tooltip, confirm } from '../../components/overlay'
import { ApiError } from '../../lib/api'
import { isImeComposing } from '../../lib/ime'
import { useUi } from '../../store/ui'
import { t } from '../../lib/i18n'
import { websshApi } from './api'
import { FileGlyph, isEditableTextEntry } from './file-icons'
import { FileEditorDialog } from './FileEditorDialog'
import { FileTree } from './FileTree'
import {
  candidatesFromFileInput,
  collectDropCandidates,
  useSftpTransfers,
} from './use-sftp-transfers'
import { loadSftpDirectory, saveSftpDirectory } from './prefs'

function joinPath(parent: string, name: string): string {
  if (parent === '/') return `/${name}`
  return `${parent.replace(/\/+$/, '')}/${name}`
}

function parentPath(path: string): string {
  if (path === '/' || path === '') return '/'
  const parts = path.split('/').filter(Boolean)
  parts.pop()
  return parts.length ? `/${parts.join('/')}` : '/'
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`
}

function formatMode(mtime: number | null): string {
  if (!mtime) return ''
  return new Date(mtime * 1000).toLocaleString()
}

function errorText(caught: unknown): string {
  return caught instanceof ApiError ? caught.message : t('webssh.error.generic')
}

const ROW_GRID = 'grid min-w-[720px] grid-cols-[minmax(180px,1fr)_70px_80px_130px_90px_90px_100px_104px] items-center gap-2 px-2'

export function SftpPanel({
  sessionId,
  hostId,
  homePath = '/',
  followPath,
  fullscreen = false,
  onToggleFullscreen,
  onClose,
}: {
  sessionId: string
  hostId: string
  homePath?: string
  followPath?: { path: string; token: number } | null
  fullscreen?: boolean
  onToggleFullscreen?: () => void
  onClose: () => void
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const folderInputRef = useRef<HTMLInputElement | null>(null)
  const initialDirectory = useMemo(() => loadSftpDirectory(hostId) ?? homePath, [hostId, homePath])
  const [path, setPath] = useState(initialDirectory)
  const [pathDraft, setPathDraft] = useState(initialDirectory)
  const [entries, setEntries] = useState<WebsshSftpEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [busy, setBusy] = useState(false)
  const [mkdirOpen, setMkdirOpen] = useState(false)
  const [mkdirName, setMkdirName] = useState('')
  const [renameTarget, setRenameTarget] = useState<WebsshSftpEntry | null>(null)
  const [renameName, setRenameName] = useState('')
  const [editorTarget, setEditorTarget] = useState<WebsshSftpEntry | null>(null)
  const [treeOpen, setTreeOpen] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [followEnabled, setFollowEnabled] = useState(true)
  const [focusedIndex, setFocusedIndex] = useState(0)
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([])
  const followTokenRef = useRef(0)

  const refresh = () => setReloadToken((value) => value + 1)
  const transfers = useSftpTransfers(sessionId, refresh)

  useEffect(() => {
    folderInputRef.current?.setAttribute('webkitdirectory', '')
    folderInputRef.current?.setAttribute('directory', '')
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    websshApi.listDir(sessionId, path)
      .then((listing) => {
        if (cancelled) return
        setPath(listing.path)
        setPathDraft(listing.path)
        setEntries([...listing.entries].sort((left, right) => {
          if (left.kind === 'directory' && right.kind !== 'directory') return -1
          if (right.kind === 'directory' && left.kind !== 'directory') return 1
          return left.name.localeCompare(right.name)
        }))
        setFocusedIndex(0)
        saveSftpDirectory(hostId, listing.path)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorText(caught))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, path, reloadToken, hostId])

  useEffect(() => {
    if (!followEnabled || !followPath || followPath.token === followTokenRef.current) return
    followTokenRef.current = followPath.token
    setPath(followPath.path)
  }, [followEnabled, followPath])

  useEffect(() => {
    const row = rowRefs.current[focusedIndex]
    if (!row) return
    row.tabIndex = 0
  }, [focusedIndex, entries])

  const toast = (title: string, tone: 'success' | 'warning' | 'danger' = 'success') => {
    useUi.getState().toast({ title, tone })
  }

  const download = async (entry: WebsshSftpEntry) => {
    setBusy(true)
    try {
      const chunks: Blob[] = []
      let offset = 0
      let total = entry.size
      for (let i = 0; i < 64; i += 1) {
        const response = await websshApi.download(sessionId, entry.path, offset)
        const headerSize = Number(response.headers.get('x-webssh-file-size') ?? '0')
        if (Number.isSafeInteger(headerSize) && headerSize > 0) total = headerSize
        const blob = await response.blob()
        chunks.push(blob)
        offset += blob.size
        if (blob.size === 0 || offset >= total) break
      }
      const url = URL.createObjectURL(new Blob(chunks))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = entry.name
      anchor.click()
      URL.revokeObjectURL(url)
      toast(t('webssh.sftp.download_done', { name: entry.name }))
    } catch (caught) {
      toast(errorText(caught), 'danger')
    } finally {
      setBusy(false)
    }
  }

  const removeEntry = async (entry: WebsshSftpEntry) => {
    const approved = await confirm({
      title: t('webssh.sftp.remove_title'),
      description: t('webssh.sftp.remove_description', { name: entry.name }),
      tone: 'danger',
      confirmLabel: t('webssh.actions.delete'),
    })
    if (!approved) return
    setBusy(true)
    try {
      await websshApi.remove(sessionId, entry.path, entry.kind === 'directory' ? 'directory' : 'file')
      toast(t('webssh.sftp.removed', { name: entry.name }))
      refresh()
    } catch (caught) {
      toast(errorText(caught), 'danger')
    } finally {
      setBusy(false)
    }
  }

  const createFolder = async () => {
    const name = mkdirName.trim()
    if (!name) return
    setBusy(true)
    try {
      await websshApi.mkdir(sessionId, joinPath(path, name))
      setMkdirOpen(false)
      setMkdirName('')
      toast(t('webssh.sftp.created', { name }))
      refresh()
    } catch (caught) {
      toast(errorText(caught), 'danger')
    } finally {
      setBusy(false)
    }
  }

  const renameEntry = async () => {
    if (!renameTarget) return
    const name = renameName.trim()
    if (!name) return
    setBusy(true)
    try {
      await websshApi.rename(sessionId, renameTarget.path, joinPath(path, name), false)
      setRenameTarget(null)
      toast(t('webssh.sftp.renamed', { name }))
      refresh()
    } catch (caught) {
      toast(errorText(caught), 'danger')
    } finally {
      setBusy(false)
    }
  }

  const uploadFiles = async (candidates: ReturnType<typeof candidatesFromFileInput>) => {
    if (candidates.length === 0) return
    await transfers.enqueue(candidates, path)
  }

  const onDrop = async (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    setDragActive(false)
    const candidates = await collectDropCandidates(event.dataTransfer)
    await uploadFiles(candidates)
  }

  const moveFocus = (next: number) => {
    if (entries.length === 0) return
    const index = Math.max(0, Math.min(entries.length - 1, next))
    setFocusedIndex(index)
    rowRefs.current.forEach((row, rowIndex) => {
      if (row) row.tabIndex = rowIndex === index ? 0 : -1
    })
    rowRefs.current[index]?.focus()
  }

  const onRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveFocus(index + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(index - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      moveFocus(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      moveFocus(entries.length - 1)
    }
  }

  const typeLabel = (entry: WebsshSftpEntry) => {
    if (entry.kind === 'directory') return t('webssh.sftp.type.directory')
    if (entry.kind === 'file') return t('webssh.sftp.type.file')
    if (entry.kind === 'symlink') return t('webssh.sftp.type.symlink')
    return t('webssh.sftp.type.other')
  }

  const percent = transfers.summary.totalBytes > 0
    ? Math.min(1, transfers.summary.uploadedBytes / transfers.summary.totalBytes)
    : 0

  return (
    <section
      aria-label={t('webssh.sftp.title')}
      className={fullscreen
        ? 'absolute inset-0 z-30 flex min-h-0 w-full flex-col bg-[var(--bg-surface)]'
        : 'relative flex min-h-0 w-full flex-col border-[var(--border-subtle)] bg-[var(--bg-surface)] md:w-[560px] md:shrink-0 md:border-s'}
      onDragOver={(event) => {
        event.preventDefault()
        setDragActive(true)
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(event) => void onDrop(event)}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] px-2 py-1.5">
        <Folder size={14} aria-hidden="true" className="shrink-0 text-[var(--text-secondary)]" />
        <h2 className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">
          {t('webssh.sftp.title')}
        </h2>
        {transfers.summary.active + transfers.summary.queued > 0 && (
          <span className="shrink-0 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
            {t('webssh.sftp.transfers.active', {
              active: transfers.summary.active,
              queued: transfers.summary.queued,
            })}
          </span>
        )}
        <Tooltip label={t('webssh.sftp.tree.toggle')}>
          <IconButton label={t('webssh.sftp.tree.toggle')} size="sm" onClick={() => setTreeOpen((value) => !value)}>
            <PanelLeft size={14} aria-hidden="true" />
          </IconButton>
        </Tooltip>
        <Tooltip label={t('webssh.sftp.parent')}>
          <IconButton label={t('webssh.sftp.parent')} size="sm" onClick={() => setPath(parentPath(path))}>
            <ArrowUp size={14} aria-hidden="true" />
          </IconButton>
        </Tooltip>
        <Tooltip label={t('webssh.sftp.refresh')}>
          <IconButton label={t('webssh.sftp.refresh')} size="sm" onClick={refresh}>
            <RefreshCw size={14} aria-hidden="true" />
          </IconButton>
        </Tooltip>
        <Tooltip label={t('webssh.sftp.new_folder')}>
          <IconButton label={t('webssh.sftp.new_folder')} size="sm" onClick={() => setMkdirOpen(true)}>
            <FolderPlus size={14} aria-hidden="true" />
          </IconButton>
        </Tooltip>
        <Tooltip label={t('webssh.sftp.upload')}>
          <IconButton label={t('webssh.sftp.upload')} size="sm" onClick={() => inputRef.current?.click()} disabled={busy}>
            <Upload size={14} aria-hidden="true" />
          </IconButton>
        </Tooltip>
        <Tooltip label={t('webssh.sftp.upload_folder')}>
          <IconButton label={t('webssh.sftp.upload_folder')} size="sm" onClick={() => folderInputRef.current?.click()}>
            <FolderPlus size={14} aria-hidden="true" />
          </IconButton>
        </Tooltip>
        {onToggleFullscreen && (
          <Tooltip label={fullscreen ? t('webssh.sftp.exit_fullscreen') : t('webssh.sftp.fullscreen')}>
            <IconButton
              label={fullscreen ? t('webssh.sftp.exit_fullscreen') : t('webssh.sftp.fullscreen')}
              size="sm"
              onClick={onToggleFullscreen}
            >
              {fullscreen ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
            </IconButton>
          </Tooltip>
        )}
        <IconButton label={t('webssh.actions.close')} size="sm" onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </IconButton>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            void uploadFiles(candidatesFromFileInput(event.target.files))
            event.target.value = ''
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            void uploadFiles(candidatesFromFileInput(event.target.files))
            event.target.value = ''
          }}
        />
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1">
        <Input
          value={pathDraft}
          aria-label={t('webssh.sftp.path')}
          spellCheck={false}
          className="h-7 min-w-0 flex-1 font-mono text-[length:var(--text-11-5)]"
          onChange={(event) => setPathDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              if (isImeComposing(event)) return
              event.preventDefault()
              setPath(pathDraft.trim() || '/')
            }
          }}
        />
        <label className="flex shrink-0 items-center gap-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
          <input
            type="checkbox"
            checked={followEnabled}
            onChange={(event) => setFollowEnabled(event.target.checked)}
          />
          {t('webssh.sftp.follow')}
        </label>
        <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
          {t('webssh.sftp.count', { count: entries.length })}
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        {treeOpen && (
          <FileTree
            sessionId={sessionId}
            rootPath={homePath}
            currentPath={path}
            onNavigate={setPath}
            onClose={() => setTreeOpen(false)}
          />
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {transfers.jobs.length > 0 && (
            <div className="shrink-0 border-b border-[var(--border-subtle)] px-3 py-2">
              <div className="mb-1 flex items-center gap-2 text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
                <span className="min-w-0 flex-1 truncate">
                  {t('webssh.sftp.transfers.summary', {
                    done: Math.round(percent * 100),
                    failed: transfers.summary.failed,
                  })}
                </span>
                <Button size="sm" variant="ghost" onClick={transfers.cancelAll}>
                  {t('webssh.sftp.transfers.cancel_all')}
                </Button>
                <Button size="sm" variant="ghost" onClick={transfers.clearFinished}>
                  {t('webssh.sftp.transfers.clear')}
                </Button>
              </div>
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(percent * 100)}
                aria-valuetext={`${Math.round(percent * 100)}%`}
                className="h-1.5 overflow-hidden rounded-full bg-[var(--bg-inset)]"
              >
                <div className="h-full bg-[var(--accent)] transition-[width] duration-150" style={{ width: `${Math.round(percent * 100)}%` }} />
              </div>
              <ul className="mt-1 max-h-24 space-y-0.5 overflow-y-auto">
                {transfers.jobs.slice(0, 8).map((job) => (
                  <li key={job.id} className="flex items-center gap-2 text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">
                    <span className="min-w-0 flex-1 truncate">{job.relativePath}</span>
                    <span className="shrink-0">
                      {job.status === 'done'
                        ? t('webssh.sftp.transfers.done')
                        : job.status === 'cancelled'
                          ? t('webssh.sftp.transfers.cancelled')
                          : job.status === 'error'
                            ? t('webssh.sftp.transfers.failed')
                            : `${Math.round(job.size === 0 ? 100 : job.uploaded / job.size * 100)}%`}
                    </span>
                    {(job.status === 'uploading' || job.status === 'queued') && (
                      <button
                        type="button"
                        className="shrink-0 text-[var(--danger)] underline"
                        onClick={() => transfers.cancel(job.id)}
                      >
                        {t('webssh.sftp.transfers.cancel')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="shrink-0 overflow-x-auto">
            <div className={ROW_GRID + ' border-b border-[var(--border-subtle)] py-1 text-[length:var(--text-10-5)] uppercase tracking-wide text-[var(--text-quaternary)]'}>
              <span>{t('webssh.sftp.column.name')}</span>
              <span>{t('webssh.sftp.column.size')}</span>
              <span>{t('webssh.sftp.column.type')}</span>
              <span>{t('webssh.sftp.column.modified')}</span>
              <span>{t('webssh.sftp.column.owner')}</span>
              <span>{t('webssh.sftp.column.group')}</span>
              <span>{t('webssh.sftp.column.permissions')}</span>
              <span>{t('webssh.sftp.column.actions')}</span>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {loading ? (
              <div className="flex items-center justify-center p-6"><Spinner size={16} /></div>
            ) : error ? (
              <div className="p-4">
                <Empty art="folder" title={t('webssh.sftp.error_title')} description={error} action={<Button size="sm" onClick={refresh}>{t('webssh.actions.retry')}</Button>} />
              </div>
            ) : entries.length === 0 ? (
              <div className="p-4">
                <Empty art="folder" compact title={t('webssh.sftp.empty_title')} description={t('webssh.sftp.empty_description')} />
              </div>
            ) : (
              <ul aria-label={t('webssh.sftp.list_label')}>
                {entries.map((entry, index) => {
                  const isDirectory = entry.kind === 'directory'
                  return (
                    <li
                      key={entry.path}
                      className={ROW_GRID + ' border-b border-[var(--border-subtle)] py-1 hover:bg-[var(--bg-hover)]'}
                    >
                      <button
                        type="button"
                        ref={(element) => { rowRefs.current[index] = element }}
                        tabIndex={index === focusedIndex ? 0 : -1}
                        className="flex min-w-0 items-center gap-2 text-start"
                        onClick={() => {
                          setFocusedIndex(index)
                          if (isDirectory) setPath(entry.path)
                          else void download(entry)
                        }}
                        onKeyDown={(event) => onRowKeyDown(event, index)}
                      >
                        <FileGlyph entry={entry} />
                        <span className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)] text-[var(--text-primary)]">{entry.name}</span>
                      </button>
                      <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{isDirectory ? '' : formatBytes(entry.size)}</span>
                      <span className="truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">{typeLabel(entry)}</span>
                      <span className="truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">{formatMode(entry.mtime)}</span>
                      <span className="truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">{entry.owner}</span>
                      <span className="truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">{entry.group}</span>
                      <span className="truncate font-mono text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{entry.permissions}</span>
                      <span className="flex shrink-0 items-center gap-0.5">
                        {!isDirectory && (
                          <Tooltip label={t('webssh.sftp.download')}>
                            <IconButton label={t('webssh.sftp.download')} size="xs" onClick={() => void download(entry)}>
                              <Download size={13} aria-hidden="true" />
                            </IconButton>
                          </Tooltip>
                        )}
                        {isEditableTextEntry(entry) && (
                          <Tooltip label={t('webssh.editor.open')}>
                            <IconButton label={t('webssh.editor.open')} size="xs" onClick={() => setEditorTarget(entry)}>
                              <FilePen size={13} aria-hidden="true" />
                            </IconButton>
                          </Tooltip>
                        )}
                        <Tooltip label={t('webssh.actions.rename')}>
                          <IconButton
                            label={t('webssh.actions.rename')}
                            size="xs"
                            onClick={() => {
                              setRenameTarget(entry)
                              setRenameName(entry.name)
                            }}
                          >
                            <Pencil size={13} aria-hidden="true" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip label={t('webssh.actions.delete')}>
                          <IconButton label={t('webssh.actions.delete')} size="xs" onClick={() => void removeEntry(entry)} disabled={busy}>
                            <Trash2 size={13} aria-hidden="true" />
                          </IconButton>
                        </Tooltip>
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      </div>

      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-[var(--accent-soft)]/40">
          <div className="rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-4 py-2 text-[length:var(--text-12-5)] text-[var(--text-primary)] shadow-[var(--shadow-md)]">
            {t('webssh.sftp.drop_hint')}
          </div>
        </div>
      )}

      <Modal
        open={mkdirOpen}
        onClose={() => setMkdirOpen(false)}
        title={t('webssh.sftp.new_folder')}
        width={400}
        footer={
          <>
            <Button onClick={() => setMkdirOpen(false)}>{t('webssh.actions.cancel')}</Button>
            <Button variant="primary" onClick={() => void createFolder()} disabled={busy || !mkdirName.trim()} loading={busy}>
              {t('webssh.actions.add')}
            </Button>
          </>
        }
      >
        <Field label={t('webssh.sftp.folder_name')}>
          <Input value={mkdirName} autoFocus onChange={(event) => setMkdirName(event.target.value)} />
        </Field>
      </Modal>

      <FileEditorDialog
        open={editorTarget !== null}
        entry={editorTarget}
        sessionId={sessionId}
        onClose={() => setEditorTarget(null)}
        onSaved={refresh}
      />

      <Modal
        open={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
        title={t('webssh.actions.rename')}
        width={400}
        footer={
          <>
            <Button onClick={() => setRenameTarget(null)}>{t('webssh.actions.cancel')}</Button>
            <Button variant="primary" onClick={() => void renameEntry()} disabled={busy || !renameName.trim()} loading={busy}>
              {t('webssh.actions.save')}
            </Button>
          </>
        }
      >
        <Field label={t('webssh.sftp.new_name')}>
          <Input value={renameName} autoFocus onChange={(event) => setRenameName(event.target.value)} />
        </Field>
      </Modal>
    </section>
  )
}
