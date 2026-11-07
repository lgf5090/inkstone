import { useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  Download,
  File as FileIcon,
  Folder,
  FolderPlus,
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
import { useUi } from '../../store/ui'
import { t } from '../../lib/i18n'
import { websshApi } from './api'

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

export function SftpPanel({ sessionId, homePath = '/', onClose }: { sessionId: string; homePath?: string; onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [path, setPath] = useState(homePath)
  const [pathDraft, setPathDraft] = useState(homePath)
  const [entries, setEntries] = useState<WebsshSftpEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ label: string; value: number } | null>(null)
  const [mkdirOpen, setMkdirOpen] = useState(false)
  const [mkdirName, setMkdirName] = useState('')
  const [renameTarget, setRenameTarget] = useState<WebsshSftpEntry | null>(null)
  const [renameName, setRenameName] = useState('')

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
  }, [sessionId, path, reloadToken])

  const refresh = () => setReloadToken((value) => value + 1)

  const toast = (title: string, tone: 'success' | 'warning' | 'danger' = 'success') => {
    useUi.getState().toast({ title, tone })
  }

  const download = async (entry: WebsshSftpEntry) => {
    setProgress({ label: t('webssh.sftp.downloading', { name: entry.name }), value: 0 })
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
        if (total > 0) {
          setProgress({
            label: t('webssh.sftp.downloading', { name: entry.name }),
            value: Math.min(1, offset / total),
          })
        }
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
      setProgress(null)
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

  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length) return
    const list = Array.from(files)
    setBusy(true)
    try {
      for (const file of list) {
        if (file.size > 2 * 1024 * 1024 * 1024) {
          toast(t('webssh.sftp.too_large', { name: file.name }), 'danger')
          continue
        }
        setProgress({ label: t('webssh.sftp.uploading', { name: file.name }), value: 0 })
        const created = await websshApi.createUpload(sessionId, joinPath(path, file.name), file.size)
        let offset = 0
        try {
          while (offset < file.size) {
            const chunk = file.slice(offset, Math.min(offset + created.chunkSize, file.size))
            await websshApi.putChunk(sessionId, created.transferId, offset, chunk)
            offset += chunk.size
            setProgress({
              label: t('webssh.sftp.uploading', { name: file.name }),
              value: file.size === 0 ? 1 : offset / file.size,
            })
          }
          await websshApi.completeUpload(sessionId, created.transferId)
        } catch (caught) {
          await websshApi.cancelUpload(sessionId, created.transferId).catch(() => undefined)
          throw caught
        }
        toast(t('webssh.sftp.upload_done', { name: file.name }))
      }
      refresh()
    } catch (caught) {
      toast(errorText(caught), 'danger')
    } finally {
      setProgress(null)
      setBusy(false)
    }
  }

  return (
    <section
      aria-label={t('webssh.sftp.title')}
      className="flex min-h-0 w-full flex-col border-[var(--border-subtle)] bg-[var(--bg-surface)] md:w-[380px] md:shrink-0 md:border-s"
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] px-2 py-1.5">
        <Folder size={14} aria-hidden="true" className="shrink-0 text-[var(--text-secondary)]" />
        <h2 className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">
          {t('webssh.sftp.title')}
        </h2>
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
        <IconButton label={t('webssh.actions.close')} size="sm" onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </IconButton>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            void uploadFiles(event.target.files)
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
              event.preventDefault()
              setPath(pathDraft.trim() || '/')
            }
          }}
        />
        <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
          {t('webssh.sftp.count', { count: entries.length })}
        </span>
      </div>

      {progress && (
        <div className="shrink-0 border-b border-[var(--border-subtle)] px-3 py-2">
          <div className="mb-1 truncate text-[length:var(--text-11-5)] text-[var(--text-secondary)]">{progress.label}</div>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress.value * 100)}
            aria-valuetext={`${Math.round(progress.value * 100)}%`}
            className="h-1.5 overflow-hidden rounded-full bg-[var(--bg-inset)]"
          >
            <div className="h-full bg-[var(--accent)] transition-[width] duration-150" style={{ width: `${Math.round(progress.value * 100)}%` }} />
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
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
          <ul className="divide-y divide-[var(--border-subtle)]">
            {entries.map((entry) => {
              const isDirectory = entry.kind === 'directory'
              return (
                <li key={entry.path} className="flex items-center gap-2 px-2 py-1.5 hover:bg-[var(--bg-hover)]">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-start"
                    onClick={() => {
                      if (isDirectory) setPath(entry.path)
                      else void download(entry)
                    }}
                  >
                    {isDirectory
                      ? <Folder size={15} aria-hidden="true" className="shrink-0 text-[var(--accent)]" />
                      : <FileIcon size={15} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[length:var(--text-12-5)] text-[var(--text-primary)]">{entry.name}</span>
                      <span className="block truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                        {isDirectory ? entry.permissions : `${formatBytes(entry.size)} · ${formatMode(entry.mtime)}`}
                      </span>
                    </span>
                  </button>
                  <span className="flex shrink-0 items-center gap-0.5">
                    {!isDirectory && (
                      <Tooltip label={t('webssh.sftp.download')}>
                        <IconButton label={t('webssh.sftp.download')} size="xs" onClick={() => void download(entry)}>
                          <Download size={13} aria-hidden="true" />
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
