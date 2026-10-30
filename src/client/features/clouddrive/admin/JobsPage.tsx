import { useEffect, useState } from 'react'
import { Play, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Button, IconButton } from '../../../components/primitives'
import { Field, Input, Select, Switch } from '../../../components/form'
import { confirm, Modal } from '../../../components/overlay'
import { useUi } from '../../../store/ui'
import { AdminCard, AdminEmpty, AdminError, AdminForbidden, AdminLoading, AdminPage, adminT, formatAdminDateTime, useAdminOwner } from './shared'
import { CLOUDDRIVE_JOB_HANDLERS, clouddriveAdminApi, type CloudDriveJob } from './api-admin'

export function JobsPage() {
  const owner = useAdminOwner()
  const toast = useUi((state) => state.toast)
  const [jobs, setJobs] = useState<CloudDriveJob[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ handler: CLOUDDRIVE_JOB_HANDLERS[0] as string, name: '', scheduleType: 'interval', intervalSec: '3600', cron: '' })

  const load = async () => {
    setStatus('loading'); setError(null)
    try { setJobs((await clouddriveAdminApi.jobs()).jobs); setStatus('ready') } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); setStatus('error') }
  }
  useEffect(() => { if (owner) void load() }, [owner])
  if (!owner) return <AdminForbidden />

  const create = async () => {
    try {
      await clouddriveAdminApi.createJob({ handler: form.handler, name: form.name.trim(), scheduleType: form.scheduleType as 'interval' | 'cron', intervalSec: form.scheduleType === 'interval' ? Number(form.intervalSec) : null, cron: form.scheduleType === 'cron' ? form.cron : null, enabled: true })
      toast({ title: adminT('clouddrive.admin.jobs.saved') }); setOpen(false); await load()
    } catch (caught) { toast({ title: adminT('clouddrive.common.failed'), description: caught instanceof Error ? caught.message : '', tone: 'danger' }) }
  }

  return (
    <AdminPage title={adminT('clouddrive.admin.jobs.title')} description={adminT('clouddrive.admin.jobs.description')} actions={<><Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw size={13} /> {adminT('clouddrive.toolbar.refresh')}</Button><Button size="sm" variant="primary" onClick={() => setOpen(true)}><Plus size={13} /> {adminT('clouddrive.admin.jobs.new')}</Button></>}>
      {status === 'loading' && <AdminLoading />}
      {status === 'error' && <AdminError message={error} onRetry={() => void load()} />}
      {status === 'ready' && (jobs.length === 0 ? <AdminEmpty title={adminT('clouddrive.admin.jobs.empty')} /> : (
        <div className="flex flex-col gap-2">
          {jobs.map((job) => (
            <AdminCard key={job.id} title={<span className="flex items-center gap-2">{job.name}{job.isBuiltIn && <span className="rounded-full bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10)] font-normal text-[var(--text-tertiary)]">{adminT('clouddrive.admin.jobs.builtin')}</span>}</span>} actions={<><Switch checked={job.enabled} onChange={(value) => void clouddriveAdminApi.updateJob(job.id, { enabled: value }).then(load)} label={adminT('clouddrive.admin.jobs.enabled')} /><Button size="sm" variant="ghost" onClick={() => void clouddriveAdminApi.runJob(job.id).then(() => { toast({ title: adminT('clouddrive.admin.jobs.run') }); void load() })}><Play size={13} /> {adminT('clouddrive.admin.jobs.run')}</Button>{!job.isBuiltIn && <IconButton label={adminT('clouddrive.admin.jobs.delete')} onClick={async () => { if (await confirm({ title: adminT('clouddrive.admin.jobs.delete'), description: job.name, tone: 'danger' })) await clouddriveAdminApi.deleteJob(job.id).then(load) }}><Trash2 size={13} /></IconButton>}</>}>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
                <span>{job.handler}</span>
                <span>{job.scheduleType === 'interval' ? adminT('clouddrive.admin.jobs.interval_seconds', { count: job.intervalSec ?? 0 }) : job.cron}</span>
                <span>{adminT('clouddrive.admin.jobs.runs')}: {job.runCount}</span>
                <span>{adminT('clouddrive.admin.jobs.last')}: {formatAdminDateTime(job.lastRunAt)}</span>
                <span>{adminT('clouddrive.admin.jobs.next')}: {formatAdminDateTime(job.nextRunAt)}</span>
                {job.lastRunStatus && <span>{adminT(`clouddrive.admin.jobs.status.${job.lastRunStatus}` as Parameters<typeof adminT>[0])}</span>}
              </div>
            </AdminCard>
          ))}
        </div>
      ))}
      <Modal open={open} onClose={() => setOpen(false)} title={adminT('clouddrive.admin.jobs.new')} width={480} footer={<><Button variant="ghost" onClick={() => setOpen(false)}>{adminT('clouddrive.dialog.cancel')}</Button><Button variant="primary" disabled={!form.name.trim()} onClick={() => void create()}>{adminT('clouddrive.admin.jobs.save')}</Button></>}>
        <div className="grid gap-2">
          <Field label={adminT('clouddrive.admin.jobs.name')}><Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
          <Field label={adminT('clouddrive.admin.jobs.handler')}><Select value={form.handler} onChange={(event) => setForm({ ...form, handler: event.target.value })}>{CLOUDDRIVE_JOB_HANDLERS.map((handler) => <option key={handler} value={handler}>{handler}</option>)}</Select></Field>
          <Field label={adminT('clouddrive.admin.jobs.schedule_interval')}><Input type="number" value={form.intervalSec} onChange={(event) => setForm({ ...form, intervalSec: event.target.value })} /></Field>
        </div>
      </Modal>
    </AdminPage>
  )
}
