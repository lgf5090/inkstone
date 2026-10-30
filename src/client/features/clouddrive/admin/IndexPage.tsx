import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '../../../components/primitives'
import { confirm } from '../../../components/overlay'
import { useUi } from '../../../store/ui'
import { AdminCard, AdminEmpty, AdminError, AdminForbidden, AdminLoading, AdminNotice, AdminPage, adminT, formatAdminDateTime, formatAdminNumber, useAdminOwner } from './shared'
import { clouddriveAdminApi, type CloudDriveAdminIndex } from './api-admin'

export function IndexPage() {
  const owner = useAdminOwner()
  const toast = useUi((state) => state.toast)
  const [index, setIndex] = useState<CloudDriveAdminIndex | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setStatus('loading'); setError(null)
    try { setIndex(await clouddriveAdminApi.index()); setStatus('ready') } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); setStatus('error') }
  }
  useEffect(() => { if (owner) void load() }, [owner])

  if (!owner) return <AdminForbidden />
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true)
    try { await work(); toast({ title: adminT('clouddrive.admin.index.done') }); await load() } catch (caught) { toast({ title: adminT('clouddrive.common.failed'), description: caught instanceof Error ? caught.message : '', tone: 'danger' }) } finally { setBusy(false) }
  }

  return (
    <AdminPage title={adminT('clouddrive.admin.index.title')} description={adminT('clouddrive.admin.index.description')} actions={<><Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw size={13} /> {adminT('clouddrive.toolbar.refresh')}</Button><Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => clouddriveAdminApi.incrementalIndex())}>{adminT('clouddrive.admin.index.incremental')}</Button><Button size="sm" variant="primary" disabled={busy} onClick={() => void run(() => clouddriveAdminApi.rebuildIndex())}>{adminT('clouddrive.admin.index.rebuild')}</Button><Button size="sm" variant="danger" disabled={busy} onClick={async () => { if (await confirm({ title: adminT('clouddrive.admin.index.clear_title'), description: adminT('clouddrive.admin.index.clear_body'), tone: 'danger' })) await run(() => clouddriveAdminApi.clearIndex()) }}>{adminT('clouddrive.admin.index.clear')}</Button></>}>
      {status === 'loading' && <AdminLoading />}
      {status === 'error' && <AdminError message={error} onRetry={() => void load()} />}
      {status === 'ready' && index && (
        <div className="flex flex-col gap-3">
          <AdminNotice>{adminT('clouddrive.admin.index.clear_note')}</AdminNotice>
          <div className="grid gap-2 sm:grid-cols-2">
            <AdminCard title={adminT('clouddrive.admin.index.total_pending')}><div className="text-[length:var(--text-20)] font-semibold tabular">{formatAdminNumber(index.pending)}</div></AdminCard>
            <AdminCard title={adminT('clouddrive.admin.index.last_indexed')}><div className="text-[length:var(--text-14)] font-medium">{formatAdminDateTime(index.lastIndexedAt)}</div></AdminCard>
          </div>
          {index.mounts.length === 0 ? <AdminEmpty title={adminT('clouddrive.admin.index.empty')} /> : (
            <div className="flex flex-col gap-2">
              {index.mounts.map((mount) => (
                <AdminCard key={mount.mountId} title={`${mount.mountName} (${mount.mountPath})`} hint={mount.external ? adminT('clouddrive.admin.index.external_hint') : undefined}>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
                    <span>{adminT('clouddrive.admin.index.pending')}: <strong className="tabular">{formatAdminNumber(mount.pending)}</strong></span>
                    <span>{adminT('clouddrive.admin.index.last_indexed')}: {mount.lastIndexedAt ? formatAdminDateTime(mount.lastIndexedAt) : adminT('clouddrive.admin.index.never')}</span>
                    <span>{mount.status === 'error' ? adminT('clouddrive.admin.index.status.error') : mount.status === 'running' ? adminT('clouddrive.admin.index.status.running') : adminT('clouddrive.admin.index.status.idle')}</span>
                    {mount.lastError && <span className="text-[var(--danger)]">{mount.lastError}</span>}
                  </div>
                </AdminCard>
              ))}
            </div>
          )}
        </div>
      )}
    </AdminPage>
  )
}
