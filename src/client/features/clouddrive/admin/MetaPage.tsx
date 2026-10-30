import { useEffect, useMemo, useState } from 'react'
import { Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
import { useUi } from '../../../store/ui'
import { Button, Spinner } from '../../../components/primitives'
import { Checkbox, Field, Input, Select, Textarea } from '../../../components/form'
import { confirm, Modal } from '../../../components/overlay'
import { clouddriveApi, type CloudDriveMetaView } from '../api'
import { AdminEmpty, AdminForbidden, AdminPage, adminT, formatAdminDateTime, useAdminOwner } from './shared'

interface MountOption {
  id: string
  name: string
  mountPath: string
}

interface MetaForm {
  mountId: string
  path: string
  header: string
  footer: string
  patterns: string
  password: string
  clearPassword: boolean
  inheritHeader: boolean
  inheritFooter: boolean
  inheritHide: boolean
  inheritPassword: boolean
}

function blankForm(mountId = 'primary'): MetaForm {
  return {
    mountId, path: '/', header: '', footer: '', patterns: '', password: '', clearPassword: false,
    inheritHeader: false, inheritFooter: false, inheritHide: false, inheritPassword: false,
  }
}

function formFrom(row: CloudDriveMetaView): MetaForm {
  return {
    mountId: row.mountId,
    path: row.path,
    header: row.header,
    footer: row.footer,
    patterns: row.hidePatterns.join('\n'),
    password: '',
    clearPassword: false,
    inheritHeader: row.inheritHeader,
    inheritFooter: row.inheritFooter,
    inheritHide: row.inheritHide,
    inheritPassword: row.inheritPassword,
  }
}

export function MetaPage() {
  const owner = useAdminOwner()
  const toast = useUi((state) => state.toast)
  const [meta, setMeta] = useState<CloudDriveMetaView[]>([])
  const [mounts, setMounts] = useState<MountOption[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<CloudDriveMetaView | null>(null)
  const [form, setForm] = useState<MetaForm>(blankForm())

  const load = async () => {
    setLoading(true)
    try {
      const [metaResult, mountResult] = await Promise.all([clouddriveApi.metaList(), clouddriveApi.mounts()])
      setMeta(metaResult.meta)
      setMounts(mountResult.mounts.map((mount) => ({ id: mount.id, name: mount.name, mountPath: mount.mountPath })))
    } catch (error) {
      toast({ title: adminT('clouddrive.common.failed'), description: error instanceof Error ? error.message : '', tone: 'danger' })
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { if (owner) void load() }, [owner])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return meta
    return meta.filter((row) => `${row.mountName} ${row.path} ${row.header} ${row.footer}`.toLowerCase().includes(needle))
  }, [meta, query])

  if (!owner) return <AdminForbidden />
  const set = (patch: Partial<MetaForm>) => setForm((current) => ({ ...current, ...patch }))
  const openCreate = () => { setEditing(null); setForm(blankForm(mounts[0]?.id ?? 'primary')); setOpen(true) }
  const openEdit = (row: CloudDriveMetaView) => { setEditing(row); setForm(formFrom(row)); setOpen(true) }

  const save = async () => {
    setBusy(true)
    try {
      await clouddriveApi.metaUpsert({
        mountId: form.mountId,
        path: form.path,
        header: form.header,
        footer: form.footer,
        hidePatterns: form.patterns.split('\n').map((line) => line.trim()).filter(Boolean),
        ...(form.clearPassword ? { clearPassword: true } : form.password ? { password: form.password } : {}),
        inheritHeader: form.inheritHeader,
        inheritFooter: form.inheritFooter,
        inheritHide: form.inheritHide,
        inheritPassword: form.inheritPassword,
      })
      toast({ title: adminT('clouddrive.admin.meta.save') })
      setOpen(false)
      await load()
    } catch (error) {
      toast({ title: adminT('clouddrive.common.failed'), description: error instanceof Error ? error.message : '', tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (row: CloudDriveMetaView) => {
    if (!await confirm({
      title: adminT('clouddrive.admin.meta.delete_title'),
      description: adminT('clouddrive.admin.meta.delete_body'),
      confirmLabel: adminT('clouddrive.admin.meta.delete'),
      tone: 'danger',
    })) return
    try {
      await clouddriveApi.metaDelete({ mountId: row.mountId, path: row.path })
      await load()
    } catch (error) {
      toast({ title: adminT('clouddrive.common.failed'), description: error instanceof Error ? error.message : '', tone: 'danger' })
    }
  }

  return (
    <AdminPage
      title={adminT('clouddrive.admin.meta.title')}
      description={adminT('clouddrive.admin.meta.description')}
      actions={<><Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw size={13} /> {adminT('clouddrive.toolbar.refresh')}</Button><Button size="sm" variant="primary" onClick={openCreate}><Plus size={13} /> {adminT('clouddrive.admin.meta.add')}</Button></>}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="relative min-w-[220px] max-w-[420px] flex-1">
          <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" aria-hidden />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={adminT('clouddrive.admin.meta.search')} aria-label={adminT('clouddrive.admin.meta.search')} className="h-8 pl-7" />
        </label>
      </div>
      {loading ? <div className="flex h-32 items-center justify-center"><Spinner /></div> : filtered.length === 0 ? (
        <AdminEmpty title={adminT('clouddrive.admin.meta.empty')} />
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((row) => (
            <article key={`${row.mountId}:${row.path}`} className="flex min-w-0 flex-wrap items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{row.path}</p>
                <p className="truncate text-[length:var(--text-10)] text-[var(--text-tertiary)]">
                  {row.mountName} · {adminT('clouddrive.admin.meta.updated', { time: formatAdminDateTime(row.updatedAt) })}
                </p>
              </div>
              {row.hidePatterns.length > 0 && <span className="rounded-full bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{adminT('clouddrive.admin.meta.patterns', { count: row.hidePatterns.length })}</span>}
              <span className={`rounded-full px-1.5 py-0.5 text-[length:var(--text-10)] ${row.hasPassword ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]' : 'bg-[var(--bg-inset)] text-[var(--text-tertiary)]'}`}>{row.hasPassword ? adminT('clouddrive.admin.meta.has_password') : adminT('clouddrive.admin.meta.no_password')}</span>
              <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => openEdit(row)}>{adminT('clouddrive.admin.edit')}</Button>
              <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => void remove(row)}>{adminT('clouddrive.admin.meta.delete')}</Button>
            </article>
          ))}
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? adminT('clouddrive.admin.meta.edit') : adminT('clouddrive.admin.meta.add')}
        width={620}
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>{adminT('clouddrive.dialog.cancel')}</Button><Button variant="primary" loading={busy} onClick={() => void save()}>{adminT('clouddrive.admin.meta.save')}</Button></>}
      >
        <div className="grid gap-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label={adminT('clouddrive.admin.meta.mount')} required>
              <Select value={form.mountId} onChange={(event) => set({ mountId: event.target.value })}>
                {mounts.map((mount) => <option key={mount.id} value={mount.id}>{mount.name} ({mount.mountPath})</option>)}
              </Select>
            </Field>
            <Field label={adminT('clouddrive.admin.meta.path')} required>
              <Input value={form.path} onChange={(event) => set({ path: event.target.value })} placeholder={adminT('clouddrive.admin.meta.path_placeholder')} />
            </Field>
          </div>
          <Field label={adminT('clouddrive.admin.meta.header')}>
            <Textarea value={form.header} onChange={(event) => set({ header: event.target.value })} rows={4} />
          </Field>
          <Checkbox checked={form.inheritHeader} label={adminT('clouddrive.admin.meta.inherit_header')} onChange={(next) => set({ inheritHeader: next })} />
          <Field label={adminT('clouddrive.admin.meta.footer')}>
            <Textarea value={form.footer} onChange={(event) => set({ footer: event.target.value })} rows={3} />
          </Field>
          <Checkbox checked={form.inheritFooter} label={adminT('clouddrive.admin.meta.inherit_footer')} onChange={(next) => set({ inheritFooter: next })} />
          <Field label={adminT('clouddrive.admin.meta.hide_patterns')}>
            <Textarea value={form.patterns} onChange={(event) => set({ patterns: event.target.value })} rows={4} />
          </Field>
          <Checkbox checked={form.inheritHide} label={adminT('clouddrive.admin.meta.inherit_hide')} onChange={(next) => set({ inheritHide: next })} />
          <Field label={adminT('clouddrive.admin.meta.password')}>
            <Input type="password" value={form.password} onChange={(event) => set({ password: event.target.value })} placeholder={adminT('clouddrive.admin.meta.password_keep')} disabled={form.clearPassword} />
          </Field>
          <Checkbox checked={form.clearPassword} label={adminT('clouddrive.admin.meta.clear_password')} onChange={(next) => set({ clearPassword: next, password: next ? '' : form.password })} />
          <Checkbox checked={form.inheritPassword} label={adminT('clouddrive.admin.meta.inherit_password')} onChange={(next) => set({ inheritPassword: next })} />
        </div>
      </Modal>
    </AdminPage>
  )
}
