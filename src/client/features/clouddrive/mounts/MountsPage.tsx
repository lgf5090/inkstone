import { useEffect, useState } from 'react'
import { Database, Link2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { Button, IconButton, Spinner } from '../../../components/primitives'
import { Field, Input, Select } from '../../../components/form'
import { confirm, Modal } from '../../../components/overlay'
import { clouddriveApi } from '../api'

interface Storage {
  id: string
  name: string
  type: string
  config: Record<string, unknown>
  status: string
  isDefault: boolean
  hasCredentials: boolean
}
interface Mount {
  id: string
  storageId: string
  name: string
  mountPath: string
  readOnly: boolean
  cacheTtl: number
  sortOrder: number
  enabled: boolean
}

export function MountsPage({ showStorages = false }: { showStorages?: boolean }) {
  const toast = useUi((state) => state.toast)
  const [storages, setStorages] = useState<Storage[]>([])
  const [mounts, setMounts] = useState<Mount[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<'mount' | 'storage' | null>(null)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<Record<string, string>>({ type: 's3', storageId: 'primary' })

  const load = async () => {
    setLoading(true)
    try {
      const [storageResult, mountResult] = await Promise.all([clouddriveApi.storages(), clouddriveApi.mounts()])
      setStorages(storageResult.storages)
      setMounts(mountResult.mounts)
    } catch (error) {
      toast({ title: t('clouddrive.failed'), description: error instanceof Error ? error.message : '', tone: 'danger' })
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [])

  const run = async (work: () => Promise<unknown>, success: string) => {
    setBusy(true)
    try {
      await work()
      toast({ title: success })
      setOpen(null)
      await load()
    } catch (error) {
      toast({ title: t('clouddrive.toast.failed'), description: error instanceof Error ? error.message : '', tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const createStorage = () => run(async () => {
    const config = form.type === 's3'
      ? { endpoint: form.endpoint ?? '', bucketName: form.bucketName ?? '', region: form.region ?? 'auto', pathStyle: form.pathStyle === '1' }
      : { baseUrl: form.baseUrl ?? '', rootPath: form.rootPath ?? '/', readQuota: false }
    const credentials = form.type === 's3'
      ? { accessKeyId: form.accessKeyId ?? '', secretAccessKey: form.secretAccessKey ?? '' }
      : { username: form.username ?? '', password: form.password ?? '' }
    await clouddriveApi.createStorage({ name: form.name, type: form.type, config, credentials, defaultPath: form.defaultPath || '/' })
  }, t('clouddrive.settings.saved'))

  const createMount = () => run(async () => {
    await clouddriveApi.createMount({ name: form.name, mountPath: form.mountPath, storageId: form.storageId, readOnly: form.readOnly === '1', cacheTtl: Number(form.cacheTtl || 300) })
  }, t('clouddrive.settings.saved'))

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">{showStorages ? t('clouddrive.storage.title') : t('clouddrive.mounts.title')}</h1>
        <div className="ml-auto flex gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw size={13} /> {t('clouddrive.toolbar.refresh')}</Button>
          <Button size="sm" variant="primary" onClick={() => { setForm({ type: 's3', storageId: 'primary' }); setOpen(showStorages ? 'storage' : 'mount') }}><Plus size={13} /> {showStorages ? t('clouddrive.storage.add') : t('clouddrive.mounts.add')}</Button>
        </div>
      </div>
      {loading ? <div className="flex h-32 items-center justify-center"><Spinner /></div> : (
        <>
          <section className="mb-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-label={t('clouddrive.storage.title')}>
            <article className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
              <div className="flex items-center gap-2"><Database size={15} className="text-[var(--accent)]" /><strong className="text-[length:var(--text-12)]">{t('clouddrive.sidebar.primary')}</strong></div>
              <p className="mt-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('clouddrive.storage.default')}</p>
            </article>
            {storages.map((storage) => (
              <article key={storage.id} className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Database size={15} className="text-[var(--text-secondary)]" />
                  <strong className="min-w-0 flex-1 truncate text-[length:var(--text-12)]">{storage.name}</strong>
                  <span className="rounded-full bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{storage.type.toUpperCase()}</span>
                </div>
                <p className="mt-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{String(storage.config.endpoint ?? storage.config.baseUrl ?? '')}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  <Button size="sm" variant="ghost" onClick={() => void clouddriveApi.testStorage(storage.id).then((result) => toast({ title: result.ok ? 'OK' : t('clouddrive.toast.failed'), description: result.message, tone: result.ok ? 'default' : 'danger' }))}>{t('clouddrive.storage.test')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => void clouddriveApi.defaultStorage(storage.id).then(load)}>{t('clouddrive.storage.set_default')}</Button>
                  <IconButton label={t('clouddrive.storage.delete')} onClick={async () => { if (await confirm({ title: t('clouddrive.storage.delete'), tone: 'danger' })) await clouddriveApi.deleteStorage(storage.id).then(load).catch((error) => toast({ title: t('clouddrive.toast.failed'), description: String(error), tone: 'danger' })) }}><Trash2 size={13} /></IconButton>
                </div>
              </article>
            ))}
          </section>
          <section className="flex flex-col gap-1" aria-label={t('clouddrive.mounts.title')}>
            {mounts.map((mount) => (
              <div key={mount.id} className="flex min-w-0 items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2">
                <Link2 size={15} className="text-[var(--text-tertiary)]" />
                <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)]">{mount.name} <span className="text-[var(--text-tertiary)]">({mount.mountPath})</span></span>
                <span className="shrink-0 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{mount.storageId}</span>
                <Button size="sm" variant="ghost" onClick={() => void clouddriveApi.testMount(mount.id).then((result) => toast({ title: result.ok ? 'OK' : t('clouddrive.toast.failed'), description: result.message, tone: result.ok ? 'default' : 'danger' }))}>{t('clouddrive.mounts.test')}</Button>
                {mount.id !== 'primary' && <IconButton label={t('clouddrive.mounts.delete')} onClick={async () => { if (await confirm({ title: t('clouddrive.mounts.delete'), tone: 'danger' })) await clouddriveApi.deleteMount(mount.id).then(load) }}><Trash2 size={13} /></IconButton>}
              </div>
            ))}
          </section>
        </>
      )}
      <Modal open={open !== null} onClose={() => setOpen(null)} title={open === 'storage' ? t('clouddrive.storage.add') : t('clouddrive.mounts.add')} width={520}
        footer={<><Button variant="ghost" onClick={() => setOpen(null)}>{t('clouddrive.dialog.cancel')}</Button><Button variant="primary" loading={busy} onClick={() => void (open === 'storage' ? createStorage() : createMount())}>{t('clouddrive.dialog.save')}</Button></>}>
        <div className="grid gap-2">
          <Field label={t('clouddrive.storage.name')}><Input value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          {open === 'storage' ? (
            <>
              <Field label={t('clouddrive.storage.type')}><Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}><option value="s3">{t('clouddrive.storage.type_s3')}</option><option value="webdav">{t('clouddrive.storage.type_webdav')}</option></Select></Field>
              {form.type === 's3' ? (
                <>
                  <Field label={t('clouddrive.storage.endpoint')}><Input value={form.endpoint ?? ''} onChange={(e) => setForm({ ...form, endpoint: e.target.value })} placeholder="https://s3.example.com" /></Field>
                  <Field label={t('clouddrive.storage.bucket')}><Input value={form.bucketName ?? ''} onChange={(e) => setForm({ ...form, bucketName: e.target.value })} /></Field>
                  <Field label={t('clouddrive.storage.region')}><Input value={form.region ?? ''} onChange={(e) => setForm({ ...form, region: e.target.value })} /></Field>
                  <Field label={t('clouddrive.storage.access_key')}><Input value={form.accessKeyId ?? ''} onChange={(e) => setForm({ ...form, accessKeyId: e.target.value })} /></Field>
                  <Field label={t('clouddrive.storage.secret_key')}><Input type="password" value={form.secretAccessKey ?? ''} onChange={(e) => setForm({ ...form, secretAccessKey: e.target.value })} /></Field>
                </>
              ) : (
                <>
                  <Field label={t('clouddrive.storage.base_url')}><Input value={form.baseUrl ?? ''} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://dav.example.com" /></Field>
                  <Field label={t('clouddrive.storage.root_path')}><Input value={form.rootPath ?? '/'} onChange={(e) => setForm({ ...form, rootPath: e.target.value })} /></Field>
                  <Field label={t('clouddrive.storage.username')}><Input value={form.username ?? ''} onChange={(e) => setForm({ ...form, username: e.target.value })} /></Field>
                  <Field label={t('clouddrive.storage.password')}><Input type="password" value={form.password ?? ''} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
                </>
              )}
            </>
          ) : (
            <>
              <Field label={t('clouddrive.mounts.path')}><Input value={form.mountPath ?? ''} onChange={(e) => setForm({ ...form, mountPath: e.target.value })} placeholder={t('clouddrive.mounts.path_placeholder')} /></Field>
              <Field label={t('clouddrive.mounts.storage')}><Select value={form.storageId} onChange={(e) => setForm({ ...form, storageId: e.target.value })}><option value="primary">{t('clouddrive.sidebar.primary')}</option>{storages.map((storage) => <option key={storage.id} value={storage.id}>{storage.name}</option>)}</Select></Field>
              <Field label={t('clouddrive.mounts.cache_ttl')}><Input value={form.cacheTtl ?? '300'} onChange={(e) => setForm({ ...form, cacheTtl: e.target.value })} /></Field>
            </>
          )}
        </div>
      </Modal>
    </div>
  )
}
