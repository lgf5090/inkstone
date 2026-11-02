import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, Download, FolderOpen, RefreshCw, Save, Users } from 'lucide-react'
import { formatBytes } from '@shared/byte-format'
import { t } from '../../../lib/i18n'
import { Button, IconButton, Spinner } from '../../../components/primitives'
import { useUi } from '../../../store/ui'
import { clouddriveApi, type CloudDriveSharedEntry, type CloudDriveSharedItem } from '../api'
import { useCloudDriveStore } from '../store'

interface BrowseState {
  item: CloudDriveSharedItem
  path: string
  entries: CloudDriveSharedEntry[]
}

export function SharedPage() {
  const toast = useUi((state) => state.toast)
  const bumpRefresh = useCloudDriveStore((state) => state.bumpRefresh)
  const [items, setItems] = useState<CloudDriveSharedItem[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [browse, setBrowse] = useState<BrowseState | null>(null)
  const [busy, setBusy] = useState(false)
  const refreshKey = useCloudDriveStore((state) => state.refreshKey)

  const load = useCallback(async () => {
    setStatus('loading')
    try {
      setItems((await clouddriveApi.sharedWithMe()).shared)
      setStatus('ready')
    } catch {
      setStatus('error')
    }
  }, [])
  useEffect(() => { void load() }, [load, refreshKey])

  const openFolder = async (item: CloudDriveSharedItem, path: string) => {
    setBusy(true)
    try {
      const result = await clouddriveApi.sharedList(item.ownerId, item.fileId, path)
      setBrowse({ item, path: result.path, entries: result.entries })
    } catch {
      setBrowse(null)
    } finally {
      setBusy(false)
    }
  }

  const openFile = (ownerId: string, fileId: string) => {
    window.open(clouddriveApi.sharedContentUrl(ownerId, fileId), '_blank', 'noopener,noreferrer')
  }

  const downloadFile = (ownerId: string, fileId: string) => {
    window.open(clouddriveApi.sharedContentUrl(ownerId, fileId, true), '_blank', 'noopener,noreferrer')
  }

  /**
   * A saved copy is a row of its own that points at the same object, so the reader can move, rename
   * or delete it without touching what the owner shared. It lands in the drive root, which is where
   * a transfer goes in every drive that has this button.
   */
  const save = async (ownerId: string, fileId: string) => {
    setBusy(true)
    try {
      const result = await clouddriveApi.saveShared({ ownerId, fileId, toPath: '/' })
      toast({ title: t('clouddrive.shared.saved', { value0: result.entry.name }), description: t('clouddrive.shared.saved_hint') })
      bumpRefresh()
    } catch (caught) {
      toast({ title: t('clouddrive.toast.failed'), description: caught instanceof Error ? caught.message : String(caught), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">{t('clouddrive.shared.title')}</h1>
          <p className="mt-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('clouddrive.shared.description')}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => { setBrowse(null); void load() }}><RefreshCw size={13} /> {t('clouddrive.toolbar.refresh')}</Button>
      </div>
      {status === 'loading' && <div className="flex h-32 items-center justify-center"><Spinner /></div>}
      {status === 'error' && (
        <div role="alert" className="flex flex-col items-center gap-2 p-6 text-center">
          <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{t('clouddrive.failed')}</p>
          <Button size="sm" variant="secondary" onClick={() => void load()}>{t('clouddrive.retry')}</Button>
        </div>
      )}
      {status === 'ready' && !browse && items.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-2 rounded-[var(--r-lg)] border border-dashed border-[var(--border-subtle)] p-8 text-center">
          <Users size={24} className="text-[var(--text-tertiary)]" aria-hidden />
          <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{t('clouddrive.shared.empty')}</p>
        </div>
      )}
      {!browse && items.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {items.map((item) => (
            <li key={`${item.ownerId}:${item.fileId}`} className="flex min-w-0 items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2">
              {item.kind === 'folder' ? <FolderOpen size={15} className="text-[var(--accent)]" aria-hidden /> : <Download size={15} className="text-[var(--text-tertiary)]" aria-hidden />}
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-[length:var(--text-12)] text-[var(--text-primary)] hover:underline"
                onClick={() => (item.kind === 'folder' ? void openFolder(item, item.path) : openFile(item.ownerId, item.fileId))}
              >
                {item.name}
              </button>
              <span className="shrink-0 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{item.ownerName} · {formatBytes(item.size)}</span>
              <IconButton label={t('clouddrive.shared.save')} disabled={busy} onClick={() => void save(item.ownerId, item.fileId)}><Save size={13} /></IconButton>
              {item.kind === 'file' && (
                <IconButton label={t('clouddrive.action.download')} onClick={() => downloadFile(item.ownerId, item.fileId)}><Download size={13} /></IconButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {browse && (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <IconButton label={t('clouddrive.shared.back')} onClick={() => setBrowse(null)}><ArrowLeft size={14} /></IconButton>
            <strong className="text-[length:var(--text-13)] text-[var(--text-primary)]">{browse.item.name}</strong>
            <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{browse.path}</span>
            {busy && <Spinner size={12} />}
          </div>
          {browse.entries.length === 0 && <p className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('clouddrive.shared.folder_empty')}</p>}
          {browse.entries.length > 0 && (
            <ul className="flex flex-col gap-1">
              {browse.entries.map((entry) => (
                <li key={entry.fileId} className="flex min-w-0 items-center gap-2 rounded-[var(--r-md)] px-2 py-1.5 hover:bg-[var(--bg-hover)]">
                  {entry.kind === 'folder' ? <FolderOpen size={14} className="text-[var(--accent)]" aria-hidden /> : <Download size={14} className="text-[var(--text-tertiary)]" aria-hidden />}
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-[length:var(--text-12)] text-[var(--text-primary)]"
                    onClick={() => (entry.kind === 'folder' ? void openFolder(browse.item, entry.path) : openFile(entry.ownerId, entry.fileId))}
                  >
                    {entry.name}
                  </button>
                  <span className="shrink-0 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{formatBytes(entry.size)}</span>
                  <IconButton label={t('clouddrive.shared.save')} disabled={busy} onClick={() => void save(entry.ownerId, entry.fileId)}><Save size={13} /></IconButton>
                  {entry.kind === 'file' && (
                    <IconButton label={t('clouddrive.action.download')} onClick={() => downloadFile(entry.ownerId, entry.fileId)}><Download size={13} /></IconButton>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
