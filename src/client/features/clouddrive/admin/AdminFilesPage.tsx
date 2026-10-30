import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Search, Trash2 } from 'lucide-react'
import { formatBytes } from '@shared/byte-format'
import { Button } from '../../../components/primitives'
import { Input, Switch } from '../../../components/form'
import { confirm } from '../../../components/overlay'
import { useUi } from '../../../store/ui'
import { AdminCard, AdminEmpty, AdminError, AdminForbidden, AdminLoading, AdminNotice, AdminPage, adminT, formatAdminDateTime, useAdminOwner } from './shared'
import { clouddriveAdminApi, type CloudDriveAdminFile } from './api-admin'

export function AdminFilesPage() {
  const owner = useAdminOwner()
  const toast = useUi((state) => state.toast)
  const [files, setFiles] = useState<CloudDriveAdminFile[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [onlyRecord, setOnlyRecord] = useState(false)
  const [memberHidden, setMemberHidden] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (append = false, from: string | null = null) => {
    setStatus(append ? 'ready' : 'loading'); setError(null)
    try {
      const result = await clouddriveAdminApi.files({ q: query || undefined, cursor: from })
      setFiles((current) => append ? [...current, ...result.files] : result.files)
      setCursor(result.cursor)
      setMemberHidden(!result.ownerCanViewMemberFiles)
      setStatus('ready')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught)); setStatus('error')
    }
  }, [query])

  useEffect(() => { if (owner) void load(false) }, [owner, load])

  if (!owner) return <AdminForbidden />
  const remove = async () => {
    if (!selected.size) return
    if (!(await confirm({ title: adminT('clouddrive.admin.files.delete_title'), description: adminT('clouddrive.admin.files.delete_body', { count: selected.size }), confirmLabel: adminT('clouddrive.admin.files.delete_selected'), tone: 'danger' }))) return
    setBusy(true)
    try {
      const result = await clouddriveAdminApi.deleteFiles([...selected], onlyRecord)
      toast({ title: adminT('clouddrive.admin.files.delete_done', { count: result.deleted }) })
      setSelected(new Set()); await load(false)
    } catch (caught) {
      toast({ title: adminT('clouddrive.common.failed'), description: caught instanceof Error ? caught.message : '', tone: 'danger' })
    } finally { setBusy(false) }
  }

  return (
    <AdminPage title={adminT('clouddrive.admin.files.title')} description={adminT('clouddrive.admin.files.description')} actions={<><Button size="sm" variant="ghost" onClick={() => void load(false)}><RefreshCw size={13} /> {adminT('clouddrive.toolbar.refresh')}</Button><Button size="sm" variant="danger" disabled={busy || !selected.size} onClick={() => void remove()}><Trash2 size={13} /> {adminT('clouddrive.admin.files.delete_selected')}</Button></>}>
      {status === 'loading' && <AdminLoading />}
      {status === 'error' && <AdminError message={error} onRetry={() => void load(false)} />}
      {status === 'ready' && (
        <div className="flex flex-col gap-3">
          {memberHidden && <AdminNotice tone="warning">{adminT('clouddrive.admin.files.member_hidden')}</AdminNotice>}
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-[200px] max-w-[420px] flex-1"><Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" aria-hidden /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={adminT('clouddrive.admin.files.search')} aria-label={adminT('clouddrive.admin.files.search')} className="h-8 pl-7" /></label>
            <label className="flex items-center gap-1.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]"><Switch checked={onlyRecord} onChange={setOnlyRecord} label={adminT('clouddrive.admin.files.only_record')} />{adminT('clouddrive.admin.files.only_record')}</label>
          </div>
          {!files.length ? <AdminEmpty title={adminT('clouddrive.admin.files.empty')} /> : (
            <AdminCard>
              <div className="overflow-auto"><table className="w-full min-w-[820px] text-left text-[length:var(--text-11-5)]">
                <thead className="text-[var(--text-tertiary)]"><tr><th className="w-8 p-2"><input type="checkbox" aria-label={adminT('clouddrive.admin.files.select')} checked={selected.size === files.length && files.length > 0} onChange={() => setSelected(selected.size === files.length ? new Set() : new Set(files.map((file) => file.id)))} /></th><th className="p-2">{adminT('clouddrive.admin.files.name')}</th><th className="p-2">{adminT('clouddrive.admin.files.mime')}</th><th className="p-2">{adminT('clouddrive.admin.files.size')}</th><th className="p-2">{adminT('clouddrive.admin.files.remaining_views')}</th><th className="p-2">{adminT('clouddrive.admin.files.storage')}</th><th className="p-2">{adminT('clouddrive.admin.files.creator')}</th><th className="p-2">{adminT('clouddrive.admin.files.created')}</th></tr></thead>
                <tbody>{files.map((file) => { const checked = selected.has(file.id); return <tr key={file.id} className="border-t border-[var(--border-subtle)]"><td className="p-2"><input type="checkbox" checked={checked} aria-label={file.name} onChange={() => { const next = new Set(selected); if (checked) next.delete(file.id); else next.add(file.id); setSelected(next) }} /></td><td className="p-2"><div className="truncate font-medium text-[var(--text-primary)]">{file.name}</div><div className="truncate text-[length:var(--text-10)] text-[var(--text-tertiary)]">{file.path}</div></td><td className="p-2 text-[var(--text-tertiary)]">{file.mime}</td><td className="p-2 tabular">{formatBytes(file.size)}</td><td className="p-2">{file.remainingViews === null ? adminT('clouddrive.admin.files.unlimited') : adminT('clouddrive.admin.files.remaining_views_value', { count: file.remainingViews })}</td><td className="p-2 text-[var(--text-tertiary)]">{file.storage ?? '—'}</td><td className="p-2 text-[var(--text-tertiary)]">{file.creator?.name ?? '—'}</td><td className="p-2 text-[var(--text-tertiary)]">{formatAdminDateTime(file.createdAt)}</td></tr> })}</tbody>
              </table></div>
              {cursor && <div className="mt-2 flex justify-center"><Button size="sm" variant="secondary" onClick={() => void load(true, cursor)}>{adminT('clouddrive.admin.files.load_more')}</Button></div>}
            </AdminCard>
          )}
        </div>
      )}
    </AdminPage>
  )
}
