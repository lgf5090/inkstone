import { useRef, useState, type ChangeEvent } from 'react'
import { Download, RefreshCw, Trash2, Upload } from 'lucide-react'
import { formatBytes } from '@shared/byte-format'
import { Button } from '../../../components/primitives'
import { confirm } from '../../../components/overlay'
import { useUi } from '../../../store/ui'
import {
  AdminCard,
  AdminForbidden,
  AdminNotice,
  AdminPage,
  adminT,
  formatAdminNumber,
  useAdminOwner,
} from './shared'
import {
  clouddriveAdminApi,
  type CloudDriveImportResult,
  type CloudDriveManifest,
  type CloudDriveOrphanObject,
} from './api-admin'

const SCAN_PAGE_CAP = 50

export function MaintenancePage() {
  const owner = useAdminOwner()
  const toast = useUi((state) => state.toast)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [orphans, setOrphans] = useState<CloudDriveOrphanObject[]>([])
  const [scanned, setScanned] = useState<number | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanningFailed, setScanningFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [imported, setImported] = useState<CloudDriveImportResult | null>(null)

  if (!owner) return <AdminForbidden />

  const scan = async () => {
    setScanning(true)
    setScanningFailed(false)
    setOrphans([])
    setScanned(0)
    try {
      const found: CloudDriveOrphanObject[] = []
      let cursor: string | null = null
      let total = 0
      for (let page = 0; page < SCAN_PAGE_CAP; page += 1) {
        const result = await clouddriveAdminApi.orphans(cursor)
        found.push(...result.orphans)
        total += result.scanned
        setScanned(total)
        setOrphans([...found])
        if (result.done || !result.cursor) break
        cursor = result.cursor
      }
      toast({ title: adminT('clouddrive.admin.maintenance.scan_done', { scanned: total }) })
    } catch (caught) {
      setScanningFailed(true)
      toast({
        title: adminT('clouddrive.common.failed'),
        description: caught instanceof Error ? caught.message : '',
        tone: 'danger',
      })
    } finally {
      setScanning(false)
    }
  }

  const deleteOrphans = async () => {
    if (orphans.length === 0) return
    const approved = await confirm({
      title: adminT('clouddrive.admin.maintenance.delete_title'),
      description: adminT('clouddrive.admin.maintenance.delete_body'),
      tone: 'danger',
    })
    if (!approved) return
    setBusy(true)
    try {
      const result = await clouddriveAdminApi.deleteOrphans(orphans.map((orphan) => orphan.key))
      setOrphans([])
      toast({ title: adminT('clouddrive.admin.maintenance.deleted', { count: result.deleted }) })
    } catch (caught) {
      toast({
        title: adminT('clouddrive.common.failed'),
        description: caught instanceof Error ? caught.message : '',
        tone: 'danger',
      })
    } finally {
      setBusy(false)
    }
  }

  const exportManifest = async () => {
    setBusy(true)
    try {
      const manifest = await clouddriveAdminApi.exportManifest()
      const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `clouddrive-export-${new Date().toISOString().slice(0, 10)}.json`
      anchor.rel = 'noopener'
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      toast({ title: adminT('clouddrive.admin.maintenance.export_done') })
    } catch (caught) {
      toast({
        title: adminT('clouddrive.common.failed'),
        description: caught instanceof Error ? caught.message : '',
        tone: 'danger',
      })
    } finally {
      setBusy(false)
    }
  }

  const importManifest = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setBusy(true)
    setImported(null)
    try {
      const text = await file.text()
      const parsed: unknown = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('manifest_shape')
      }
      const manifest = parsed as CloudDriveManifest
      if (manifest.format !== 'inkstone-clouddrive' || manifest.version !== 1 || !Array.isArray(manifest.entries)) {
        toast({ title: adminT('clouddrive.admin.maintenance.import_invalid'), tone: 'danger' })
        return
      }
      const result = await clouddriveAdminApi.importManifest(manifest)
      setImported(result)
      toast({ title: adminT('clouddrive.admin.maintenance.import_done', { imported: result.imported, skipped: result.skipped }) })
    } catch (caught) {
      toast({
        title: caught instanceof SyntaxError
          ? adminT('clouddrive.admin.maintenance.import_invalid')
          : adminT('clouddrive.common.failed'),
        description: caught instanceof Error && caught.message !== 'manifest_shape' ? caught.message : '',
        tone: 'danger',
      })
    } finally {
      setBusy(false)
    }
  }

  const orphanBytes = orphans.reduce((sum, orphan) => sum + orphan.size, 0)

  return (
    <AdminPage
      title={adminT('clouddrive.admin.maintenance.title')}
      description={adminT('clouddrive.admin.maintenance.description')}
    >
      <div className="flex flex-col gap-3">
        <AdminCard
          title={adminT('clouddrive.admin.maintenance.orphans_title')}
          hint={adminT('clouddrive.admin.maintenance.orphans_hint')}
          actions={(
            <>
              <Button size="sm" variant="secondary" disabled={scanning || busy} onClick={() => void scan()}>
                {scanning ? <RefreshCw size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                {scanning ? adminT('clouddrive.admin.maintenance.scanning') : adminT('clouddrive.admin.maintenance.scan')}
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy || scanning || orphans.length === 0}
                onClick={() => void deleteOrphans()}
              >
                <Trash2 size={13} /> {adminT('clouddrive.admin.maintenance.delete_orphans')}
              </Button>
            </>
          )}
        >
          {scanningFailed && <AdminNotice tone="warning">{adminT('clouddrive.common.failed')}</AdminNotice>}
          {!scanningFailed && scanned !== null && orphans.length === 0 && (
            <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
              {adminT('clouddrive.admin.maintenance.orphans_empty')}
            </p>
          )}
          {orphans.length > 0 && (
            <>
              <p className="mb-2 text-[length:var(--text-12)] text-[var(--text-secondary)]">
                {adminT('clouddrive.admin.maintenance.orphans_found', {
                  count: formatAdminNumber(orphans.length),
                  bytes: formatBytes(orphanBytes),
                })}
              </p>
              <ul className="flex max-h-72 flex-col gap-1 overflow-auto">
                {orphans.slice(0, 200).map((orphan) => (
                  <li key={orphan.key} className="flex min-w-0 items-center gap-2 rounded-[var(--r-sm)] bg-[var(--bg-sunken)] px-2 py-1 font-mono text-[length:var(--text-10)] text-[var(--text-tertiary)]">
                    <span className="min-w-0 flex-1 truncate">{orphan.key}</span>
                    <span className="shrink-0 tabular">{formatBytes(orphan.size)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </AdminCard>

        <AdminCard title={adminT('clouddrive.admin.maintenance.export_title')} hint={adminT('clouddrive.admin.maintenance.export_hint')}>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void exportManifest()}>
            <Download size={13} /> {adminT('clouddrive.admin.maintenance.export')}
          </Button>
        </AdminCard>

        <AdminCard title={adminT('clouddrive.admin.maintenance.import_title')} hint={adminT('clouddrive.admin.maintenance.import_hint')}>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => fileInputRef.current?.click()}>
            <Upload size={13} /> {adminT('clouddrive.admin.maintenance.import')}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => void importManifest(event)}
          />
          {imported && (
            <div className="mt-2">
              <p className="text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
                {adminT('clouddrive.admin.maintenance.import_done', { imported: imported.imported, skipped: imported.skipped })}
              </p>
              {imported.errors.length > 0 && (
                <ul className="mt-1 flex max-h-40 flex-col gap-0.5 overflow-auto text-[length:var(--text-10)] text-[var(--text-tertiary)]">
                  {imported.errors.map((error, index) => (
                    <li key={`${error.path}-${index}`}>{error.path || '—'} · {error.reason}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </AdminCard>
      </div>
    </AdminPage>
  )
}
