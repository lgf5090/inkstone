/**
 * The module's settings: what the deployment has, the one cache, the demo accounts, and the scheduled
 * tasks.
 *
 * The reference screen also carried a global proxy and a Resin pool. Neither is here: an outbound
 * proxy is a Node transport, and this deployment cannot use one, so a form that saved it would be a
 * lie. What remains is everything that actually changes behaviour on this platform.
 */
import { useEffect, useMemo, useState } from 'react'
import { Play, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { CloudflareAccount } from '@shared/cloudflare/model'
import { Badge, Button, IconButton } from '../../../components/primitives'
import { Field, Input, Switch } from '../../../components/form'
import { SelectMenu } from '../../../components/select-menu'
import { Modal, confirm } from '../../../components/overlay'
import { LoadingBlock } from '../../../components/feedback'
import { TBody, THead, Table, TableScroll, Td, Th, Tr } from '../components/Table'
import { useCfT, type CloudflareMessageKey } from '../i18n'
import { useUi } from '../../../store/ui'
import { cfRequest, cfErrorText } from '../api/client'
import { cloudflareSettingsApi, type CloudflareModuleSettings } from '../api/settings'
import {
  TASK_TYPES,
  tasksApi,
  type CloudflareTask,
  type CloudflareTaskExecution,
  type TaskConfigInput,
  type TaskType,
} from '../api/tasks'
import { formatDateTime } from '../lib/format'

const TASK_LABEL: Record<TaskType, CloudflareMessageKey> = {
  quota_report: 'cloudflare.settings.task_types.quota_report',
  kv_cleanup: 'cloudflare.settings.task_types.kv_cleanup',
  d1_backup: 'cloudflare.settings.task_types.d1_backup',
  r2_cleanup: 'cloudflare.settings.task_types.r2_cleanup',
}

const TASK_DESCRIPTION: Record<TaskType, CloudflareMessageKey> = {
  quota_report: 'cloudflare.settings.task_type_desc.quota_report',
  kv_cleanup: 'cloudflare.settings.task_type_desc.kv_cleanup',
  d1_backup: 'cloudflare.settings.task_type_desc.d1_backup',
  r2_cleanup: 'cloudflare.settings.task_type_desc.r2_cleanup',
}

function parseTaskConfig(task: CloudflareTask | null): TaskConfigInput {
  if (!task?.config) return {}
  try {
    const parsed: unknown = JSON.parse(task.config)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as TaskConfigInput : {}
  } catch {
    return {}
  }
}

function StatusBadge({ status }: { status: CloudflareTaskExecution['status'] }) {
  const t = useCfT()
  const tone = status === 'success' ? 'success' : status === 'error' ? 'danger' : 'neutral'
  const label = status === 'success'
    ? t('cloudflare.settings.status_success')
    : status === 'error'
      ? t('cloudflare.settings.status_error')
      : t('cloudflare.settings.status_running')
  return <Badge tone={tone}>{label}</Badge>
}

export function SettingsScreen() {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const [settings, setSettings] = useState<CloudflareModuleSettings | null>(null)
  const [accounts, setAccounts] = useState<CloudflareAccount[]>([])
  const [tasks, setTasks] = useState<CloudflareTask[]>([])
  const [demoDraft, setDemoDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<CloudflareTask | 'new' | null>(null)
  const [historyFor, setHistoryFor] = useState<CloudflareTask | null>(null)
  const [executions, setExecutions] = useState<CloudflareTaskExecution[]>([])
  const [busy, setBusy] = useState(false)

  async function refresh(): Promise<void> {
    const [moduleSettings, taskList, accountPage] = await Promise.all([
      cloudflareSettingsApi.get(),
      tasksApi.list(),
      cfRequest<{ accounts: CloudflareAccount[] }>('/accounts?pageSize=100'),
    ])
    setSettings(moduleSettings)
    setDemoDraft(moduleSettings.demo_account_ids)
    setTasks(taskList.tasks)
    setAccounts(accountPage.accounts)
  }

  useEffect(() => {
    setLoading(true)
    refresh()
      .catch((failure: unknown) => setError(cfErrorText(failure)))
      .finally(() => setLoading(false))
  }, [])

  const demoCount = useMemo(
    () => demoDraft.split(',').map((id) => id.trim()).filter(Boolean).length,
    [demoDraft],
  )

  async function clearCache(): Promise<void> {
    setBusy(true)
    try {
      await cloudflareSettingsApi.clearCache()
      toast({ title: t('cloudflare.settings.msg.cache_cleared'), tone: 'success' })
    } catch (failure) {
      toast({ title: cfErrorText(failure), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function saveDemoAccounts(): Promise<void> {
    setBusy(true)
    try {
      const ids = demoDraft.split(',').map((id) => id.trim()).filter(Boolean)
      const saved = await cloudflareSettingsApi.saveDemoAccounts(ids)
      setDemoDraft(saved.demo_account_ids)
      toast({ title: t('cloudflare.settings.msg.saved'), tone: 'success' })
    } catch (failure) {
      toast({ title: cfErrorText(failure), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function runTask(task: CloudflareTask): Promise<void> {
    setBusy(true)
    try {
      const result = await tasksApi.run(task.id)
      toast({ title: result.detail, tone: result.status === 'success' ? 'success' : 'danger' })
      if (historyFor?.id === task.id) setExecutions((await tasksApi.history(task.id)).executions)
    } catch (failure) {
      toast({ title: cfErrorText(failure), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function toggleTask(task: CloudflareTask, enabled: boolean): Promise<void> {
    try {
      await tasksApi.update(task.id, { enabled })
      setTasks((rows) => rows.map((row) => (row.id === task.id ? { ...row, enabled: enabled ? 1 : 0 } : row)))
    } catch (failure) {
      toast({ title: cfErrorText(failure), tone: 'danger' })
    }
  }

  async function removeTask(task: CloudflareTask): Promise<void> {
    const ok = await confirm({
      title: t('cloudflare.settings.delete'),
      description: task.name,
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await tasksApi.remove(task.id)
      setTasks((rows) => rows.filter((row) => row.id !== task.id))
      toast({ title: t('cloudflare.settings.msg.task_deleted'), tone: 'success' })
    } catch (failure) {
      toast({ title: cfErrorText(failure), tone: 'danger' })
    }
  }

  async function openHistory(task: CloudflareTask): Promise<void> {
    setHistoryFor(task)
    try {
      setExecutions((await tasksApi.history(task.id)).executions)
    } catch (failure) {
      toast({ title: cfErrorText(failure), tone: 'danger' })
    }
  }

  if (loading) return <div className="flex h-full items-center justify-center"><LoadingBlock /></div>
  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-[length:var(--text-13)] text-[var(--text-secondary)]">{error}</p>
        <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={() => { setError(''); setLoading(true); void refresh().catch((f: unknown) => setError(cfErrorText(f))).finally(() => setLoading(false)) }}>
          {t('common.retry')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 md:p-6">
        <h1 className="text-[length:var(--text-17)] font-semibold text-[var(--text-primary)]">{t('cloudflare.settings.title')}</h1>

        <section className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] p-3 md:p-4">
          <h2 className="mb-3 text-[length:var(--text-14)] font-medium text-[var(--text-primary)]">{t('cloudflare.settings.config_status')}</h2>
          <dl className="grid gap-2 text-[length:var(--text-12-5)] sm:grid-cols-2">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-[var(--text-tertiary)]">{t('cloudflare.settings.encryption_key')}</dt>
              <dd><Badge tone={settings?.vault ? 'success' : 'danger'}>{settings?.vault ? t('cloudflare.settings.enabled') : t('cloudflare.settings.disabled')}</Badge></dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-[var(--text-tertiary)]">{t('cloudflare.storage.r2')}</dt>
              <dd><Badge tone={settings?.r2 ? 'success' : 'danger'}>{settings?.r2 ? t('cloudflare.settings.enabled') : t('cloudflare.settings.disabled')}</Badge></dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-[var(--text-tertiary)]">{t('cloudflare.settings.platform')}</dt>
              <dd className="font-mono text-[var(--text-secondary)]">{settings?.platform ?? '—'}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-[var(--text-tertiary)]">{t('cloudflare.settings.version')}</dt>
              <dd className="font-mono text-[var(--text-secondary)]">{settings?.version ? `v${settings.version}` : t('cloudflare.settings.unknown')}</dd>
            </div>
          </dl>
        </section>

        <section className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] p-3 md:p-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-[length:var(--text-14)] font-medium text-[var(--text-primary)]">{t('cloudflare.settings.demo_accounts')}</h2>
              <p className="mt-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('cloudflare.settings.demo_accounts_hint')}</p>
            </div>
            <span className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{demoCount}</span>
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <Field label={t('cloudflare.settings.demo_accounts')} className="min-w-64 flex-1">
              <Input value={demoDraft} onChange={(event) => setDemoDraft(event.target.value)} placeholder={t('cloudflare.settings.demo_accounts_placeholder')} autoComplete="off" />
            </Field>
            <Button variant="secondary" onClick={() => void saveDemoAccounts()} loading={busy}>{t('common.save')}</Button>
          </div>
        </section>

        <section className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] p-3 md:p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[length:var(--text-14)] font-medium text-[var(--text-primary)]">{t('cloudflare.settings.cache_management')}</h2>
            <Button variant="secondary" onClick={() => void clearCache()} loading={busy} icon={<Trash2 size={14} />}>
              {t('cloudflare.settings.clear_cache')}
            </Button>
          </div>
        </section>

        <section className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] p-3 md:p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[length:var(--text-14)] font-medium text-[var(--text-primary)]">{t('cloudflare.settings.scheduled_tasks')}</h2>
            <Button variant="secondary" icon={<Plus size={14} />} onClick={() => setEditing('new')}>{t('cloudflare.settings.add_task')}</Button>
          </div>
          {tasks.length === 0
            ? <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('cloudflare.settings.no_tasks')}</p>
            : (
              <TableScroll label={t('cloudflare.settings.scheduled_tasks')}>
                <Table>
                  <THead>
                    <tr>
                      <Th>{t('cloudflare.settings.task_name')}</Th>
                      <Th>{t('cloudflare.settings.task_type')}</Th>
                      <Th>{t('cloudflare.settings.cron_expr')}</Th>
                      <Th>{t('cloudflare.settings.enabled')}</Th>
                      <Th>{t('cloudflare.settings.edit')}</Th>
                    </tr>
                  </THead>
                  <TBody>
                    {tasks.map((task) => (
                      <Tr key={task.id}>
                        <Td className="max-w-48 truncate">{task.name}</Td>
                        <Td><Badge tone="neutral">{t(TASK_LABEL[task.type])}</Badge></Td>
                        <Td className="font-mono text-[length:var(--text-11-5)]">{task.cron}</Td>
                        <Td><Switch checked={task.enabled === 1} onChange={(next) => void toggleTask(task, next)} label={t('cloudflare.settings.enabled')} /></Td>
                        <Td>
                          <div className="flex items-center gap-1">
                            <Button size="sm" variant="ghost" onClick={() => void runTask(task)} icon={<Play size={13} />}>{t('cloudflare.settings.run_now')}</Button>
                            <Button size="sm" variant="ghost" onClick={() => void openHistory(task)}>{t('cloudflare.settings.history')}</Button>
                            <Button size="sm" variant="ghost" onClick={() => setEditing(task)}>{t('common.edit')}</Button>
                            <IconButton label={t('common.delete')} size="sm" variant="ghost" onClick={() => void removeTask(task)}>
                              <Trash2 size={13} />
                            </IconButton>
                          </div>
                        </Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </TableScroll>
            )}
        </section>
      </div>

      {editing && (
        <TaskDialog
          task={editing === 'new' ? null : editing}
          accounts={accounts}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); setTasks((await tasksApi.list()).tasks) }}
        />
      )}

      <Modal open={historyFor !== null} onClose={() => setHistoryFor(null)} title={historyFor ? t('cloudflare.settings.history_title', { name: historyFor.name }) : ''} width={640}>
        {executions.length === 0
          ? <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('cloudflare.settings.no_history')}</p>
          : (
            <TableScroll label={t('cloudflare.settings.history_title', { name: historyFor?.name ?? '' })}>
              <Table>
                <THead><tr><Th>{t('cloudflare.settings.config_status')}</Th><Th>{t('cloudflare.settings.detail')}</Th><Th>{t('cloudflare.settings.version')}</Th></tr></THead>
                <TBody>
                  {executions.map((execution) => (
                    <Tr key={execution.id}>
                      <Td><StatusBadge status={execution.status} /></Td>
                      <Td className="max-w-80 whitespace-pre-wrap break-words text-[length:var(--text-12)]">{execution.detail ?? '—'}</Td>
                      <Td className="whitespace-nowrap text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{formatDateTime(execution.started_at)}</Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </TableScroll>
          )}
      </Modal>
    </div>
  )
}

function TaskDialog({
  task,
  accounts,
  onClose,
  onSaved,
}: {
  task: CloudflareTask | null
  accounts: CloudflareAccount[]
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const initial = parseTaskConfig(task)
  const [name, setName] = useState(task?.name ?? '')
  const [type, setType] = useState<TaskType>(task?.type ?? 'quota_report')
  const [cron, setCron] = useState(task?.cron ?? '0 8 * * *')
  const [accountId, setAccountId] = useState(initial.account_id ?? accounts[0]?.id ?? '')
  const [namespaceId, setNamespaceId] = useState(initial.namespace_id ?? '')
  const [keyPrefix, setKeyPrefix] = useState(initial.key_prefix ?? '')
  const [databaseId, setDatabaseId] = useState(initial.database_id ?? '')
  const [bucket, setBucket] = useState(initial.bucket ?? '')
  const [prefix, setPrefix] = useState(initial.prefix ?? '')
  const [maxAgeDays, setMaxAgeDays] = useState(String(initial.max_age_days ?? 30))
  const [saving, setSaving] = useState(false)

  async function save(): Promise<void> {
    if (!name.trim() || !cron.trim()) {
      toast({ title: t('cloudflare.settings.msg.info_required'), tone: 'warning' })
      return
    }
    const config: TaskConfigInput = {}
    if (type !== 'quota_report') config.account_id = accountId
    if (type === 'kv_cleanup') {
      config.namespace_id = namespaceId.trim()
      config.key_prefix = keyPrefix.trim()
    }
    if (type === 'd1_backup') config.database_id = databaseId.trim()
    if (type === 'r2_cleanup') {
      config.bucket = bucket.trim()
      config.prefix = prefix.trim()
      config.max_age_days = Number(maxAgeDays) || 30
    }
    setSaving(true)
    try {
      if (task) {
        await tasksApi.update(task.id, { name: name.trim(), cron: cron.trim(), config })
        toast({ title: t('cloudflare.settings.msg.saved'), tone: 'success' })
      } else {
        await tasksApi.create({ name: name.trim(), type, cron: cron.trim(), config })
        toast({ title: t('cloudflare.settings.msg.task_created'), tone: 'success' })
      }
      await onSaved()
    } catch (failure) {
      toast({ title: cfErrorText(failure), tone: 'danger' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={task ? t('cloudflare.settings.edit_task_title') : t('cloudflare.settings.add_task_title')}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>{t('common.save')}</Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        <Field label={t('cloudflare.settings.task_name')} required>
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('cloudflare.settings.task_name_placeholder')} />
        </Field>
        <div className="flex flex-col gap-1">
          <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('cloudflare.settings.task_type')}</span>
          <SelectMenu
            label={t('cloudflare.settings.task_type')}
            value={type}
            onChange={(value) => setType(value)}
            options={TASK_TYPES.map((value) => ({ value, label: t(TASK_LABEL[value]) }))}
          />
          <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t(TASK_DESCRIPTION[type])}</p>
        </div>
        {type !== 'quota_report' && (
          <div className="flex flex-col gap-1">
            <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('cloudflare.settings.account')}</span>
            <SelectMenu
              label={t('cloudflare.settings.account')}
              value={accountId}
              onChange={setAccountId}
              options={accounts.map((account) => ({ value: account.id, label: account.name }))}
              placeholder={t('cloudflare.settings.select_account')}
            />
          </div>
        )}
        {type === 'kv_cleanup' && (
          <>
            <Field label={t('cloudflare.settings.namespace_id')} required>
              <Input value={namespaceId} onChange={(event) => setNamespaceId(event.target.value)} />
            </Field>
            <Field label={t('cloudflare.settings.key_prefix')} required>
              <Input value={keyPrefix} onChange={(event) => setKeyPrefix(event.target.value)} placeholder={t('cloudflare.settings.key_prefix_placeholder')} />
            </Field>
          </>
        )}
        {type === 'd1_backup' && (
          <>
            <Field label={t('cloudflare.settings.database_id')} required hint={t('cloudflare.settings.d1_backup_hint')}>
              <Input value={databaseId} onChange={(event) => setDatabaseId(event.target.value)} />
            </Field>
          </>
        )}
        {type === 'r2_cleanup' && (
          <>
            <Field label={t('cloudflare.settings.bucket')} required>
              <Input value={bucket} onChange={(event) => setBucket(event.target.value)} placeholder={t('cloudflare.settings.bucket_placeholder')} />
            </Field>
            <Field label={t('cloudflare.settings.prefix_filter')} required>
              <Input value={prefix} onChange={(event) => setPrefix(event.target.value)} />
            </Field>
            <Field label={t('cloudflare.settings.max_age_days')} required>
              <Input type="number" min={1} value={maxAgeDays} onChange={(event) => setMaxAgeDays(event.target.value)} />
            </Field>
          </>
        )}
        <Field label={t('cloudflare.settings.cron_expr')} required hint={t('cloudflare.settings.cron_hint')}>
          <Input value={cron} onChange={(event) => setCron(event.target.value)} placeholder={t('cloudflare.settings.cron_placeholder')} />
        </Field>
      </div>
    </Modal>
  )
}
