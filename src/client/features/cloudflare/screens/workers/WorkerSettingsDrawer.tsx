/**
 * A Worker's settings: variables and secrets, cron triggers, custom domains, workers.dev, script
 * settings, routes, source and deployment history.
 *
 * Each tab loads its own slice of Cloudflare's API when the drawer opens. Saving a plain variable is
 * a redeploy (Cloudflare has no variable-only endpoint); a secret goes through the secrets endpoint.
 * The drawer keeps the two paths distinct so a secret is never written as plain text.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ExternalLink, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { Field, Input, Segmented, Switch } from '../../../../components/form'
import { LoadingBlock } from '../../../../components/feedback'
import { Drawer, Modal, confirm } from '../../../../components/overlay'
import { Badge, Button, IconButton } from '../../../../components/primitives'
import { SelectMenu } from '../../../../components/select-menu'
import { useUi } from '../../../../store/ui'
import { t as uiT } from '../../../../lib/i18n'
import { cfErrorText } from '../../api/client'
import {
  workersApi,
  type DeployVarInput,
  type WorkerCronSchedule,
  type WorkerDeployment,
  type WorkerDomain,
  type WorkerRoute,
  type WorkerSecret,
  type WorkerSettings,
  type WorkerSubdomain,
  type ZoneOption,
} from '../../api/workers'
import { CopyButton } from '../../components/CopyButton'
import { CodeEditor } from '../../components/CodeEditor'
import { TBody, Table, Td, THead, Th, Tr } from '../../components/Table'
import { useCfT } from '../../i18n'
import { formatDateTime, stringifyOrPretty } from '../../lib/format'
import { EnvSyncDialog } from './EnvSyncDialog'

type SettingsTab = 'secrets' | 'schedules' | 'domains' | 'subdomain' | 'settings' | 'routes' | 'source' | 'deployments'

interface SecretRow {
  name: string
  type: 'plain_text' | 'secret_text'
  value: string
}

const CRON_PRESETS = [
  { key: 'cloudflare.worker_settings.cron_presets.every_minute', value: '* * * * *' },
  { key: 'cloudflare.worker_settings.cron_presets.every5_min', value: '*/5 * * * *' },
  { key: 'cloudflare.worker_settings.cron_presets.every15_min', value: '*/15 * * * *' },
  { key: 'cloudflare.worker_settings.cron_presets.every30_min', value: '*/30 * * * *' },
  { key: 'cloudflare.worker_settings.cron_presets.every_hour', value: '0 * * * *' },
  { key: 'cloudflare.worker_settings.cron_presets.every2_hour', value: '0 */2 * * *' },
  { key: 'cloudflare.worker_settings.cron_presets.daily0', value: '0 0 * * *' },
  { key: 'cloudflare.worker_settings.cron_presets.weekly0', value: '0 0 * * 0' },
  { key: 'cloudflare.worker_settings.cron_presets.monthly1', value: '0 0 1 * *' },
] as const

function dateText(value: string | null | undefined): string {
  if (!value) return '—'
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? formatDateTime(ms) : value
}

function deploymentList(value: WorkerDeployment[] | { deployments?: WorkerDeployment[]; items?: WorkerDeployment[] }): WorkerDeployment[] {
  if (Array.isArray(value)) return value
  return value.deployments ?? value.items ?? []
}

export function WorkerSettingsDrawer({
  open,
  onClose,
  accountId,
  name,
}: {
  open: boolean
  onClose: () => void
  accountId: string
  name: string
}) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const [tab, setTab] = useState<SettingsTab>('secrets')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [secrets, setSecrets] = useState<SecretRow[]>([])
  const [secretModal, setSecretModal] = useState(false)
  const [secretEditing, setSecretEditing] = useState(false)
  const [secretForm, setSecretForm] = useState<{ name: string; type: 'plain_text' | 'secret_text'; value: string }>({
    name: '',
    type: 'plain_text',
    value: '',
  })
  const [saving, setSaving] = useState(false)

  const [schedules, setSchedules] = useState<WorkerCronSchedule[]>([])
  const [cronExpressions, setCronExpressions] = useState<string[]>([])
  const [cronPreset, setCronPreset] = useState('')
  const [showCronFields, setShowCronFields] = useState(false)
  const [cronMin, setCronMin] = useState('*')
  const [cronHour, setCronHour] = useState('*')
  const [cronDay, setCronDay] = useState('*')
  const [cronMon, setCronMon] = useState('*')
  const [cronDow, setCronDow] = useState('*')

  const [zones, setZones] = useState<ZoneOption[]>([])
  const [domains, setDomains] = useState<WorkerDomain[]>([])
  const [domainModal, setDomainModal] = useState(false)
  const [domainZone, setDomainZone] = useState('')
  const [domainSub, setDomainSub] = useState('')
  const [domainEnvironment, setDomainEnvironment] = useState('production')

  const [subdomain, setSubdomain] = useState<WorkerSubdomain | null>(null)
  const [settings, setSettings] = useState<WorkerSettings | null>(null)
  const [tagDraft, setTagDraft] = useState('')

  const [routes, setRoutes] = useState<WorkerRoute[]>([])
  const [routeZoneId, setRouteZoneId] = useState('')
  const [routeModal, setRouteModal] = useState(false)
  const [routeForm, setRouteForm] = useState({ zoneId: '', pattern: '' })

  const [content, setContent] = useState('')
  const [contentLoading, setContentLoading] = useState(false)
  const [deployments, setDeployments] = useState<WorkerDeployment[]>([])
  const [envSyncOpen, setEnvSyncOpen] = useState(false)

  const builtCron = `${cronMin} ${cronHour} ${cronDay} ${cronMon} ${cronDow}`

  const zoneOptions = useMemo(
    () => zones.map((zone) => ({ value: zone.id, label: `${zone.name}${zone.status ? ` (${zone.status})` : ''}` })),
    [zones],
  )

  function describeCron(cron: string): string {
    const preset = CRON_PRESETS.find((item) => item.value === cron)
    if (preset) return t(preset.key)
    const parts = cron.trim().split(/\s+/)
    if (parts.length !== 5) return ''
    const labels = [
      t('cloudflare.worker_settings.minute'),
      t('cloudflare.worker_settings.hour'),
      t('cloudflare.worker_settings.day'),
      t('cloudflare.worker_settings.month'),
      t('cloudflare.worker_settings.week'),
    ]
    const described = parts
      .map((part, index) => (part === '*' ? '' : `${labels[index]}${part}`))
      .filter(Boolean)
    return described.join(' ')
  }

  async function loadSecrets(): Promise<void> {
    const [config, secretList] = await Promise.all([
      workersApi.getWorkerConfig(accountId, name),
      workersApi.getSecrets(accountId, name),
    ])
    const rows: SecretRow[] = config.vars.map((variable) => ({
      name: variable.name,
      type: variable.secret ? 'secret_text' : 'plain_text',
      value: variable.value,
    }))
    for (const secret of secretList as WorkerSecret[]) {
      if (!rows.some((row) => row.name === secret.name)) {
        rows.push({ name: secret.name, type: 'secret_text', value: '' })
      }
    }
    setSecrets(rows)
  }

  async function loadSchedules(): Promise<void> {
    const answer = await workersApi.getSchedules(accountId, name)
    const list = answer.schedules ?? []
    setSchedules(list)
    setCronExpressions(list.map((item) => item.cron))
  }

  async function ensureZones(): Promise<ZoneOption[]> {
    if (zones.length > 0) return zones
    const list = await workersApi.getZones(accountId)
    setZones(list)
    return list
  }

  async function loadDomains(): Promise<void> {
    setDomains(await workersApi.getDomains(accountId, name))
  }

  async function loadSubdomain(): Promise<void> {
    setSubdomain(await workersApi.getSubdomain(accountId, name))
  }

  async function loadSettings(): Promise<void> {
    setSettings(await workersApi.getSettings(accountId, name))
  }

  async function loadDeployments(): Promise<void> {
    setDeployments(deploymentList(await workersApi.getDeployments(accountId, name)))
  }

  async function loadContent(): Promise<void> {
    setContentLoading(true)
    try {
      setContent(stringifyOrPretty(await workersApi.getContent(accountId, name)))
    } catch (reason) {
      setContent(t('cloudflare.worker_settings.msg.load_failed', { error: cfErrorText(reason) }))
    } finally {
      setContentLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setTab('secrets')
    setError('')
    setZones([])
    setSchedules([])
    setDomains([])
    setSubdomain(null)
    setSettings(null)
    setRoutes([])
    setContent('')
    setDeployments([])
    setLoading(true)
    void (async () => {
      const jobs: Array<Promise<void>> = [
        loadSecrets(), loadSchedules(), loadDomains(), loadSubdomain(), loadSettings(), loadDeployments(),
      ]
      const results = await Promise.allSettled(jobs)
      if (cancelled) return
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failure) setError(cfErrorText(failure.reason))
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
    // The loaders are intentionally re-run only when the drawer opens on another worker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, accountId, name])

  function openSecretModal(row?: SecretRow): void {
    setSecretEditing(Boolean(row))
    setSecretForm({
      name: row?.name ?? '',
      type: row?.type ?? 'plain_text',
      value: row?.type === 'secret_text' ? '' : row?.value ?? '',
    })
    setSecretModal(true)
  }

  async function saveSecret(): Promise<void> {
    if (!secretForm.name.trim()) {
      toast({ title: t('cloudflare.worker_settings.msg.name_required'), tone: 'warning' })
      return
    }
    setSaving(true)
    try {
      if (secretForm.type === 'secret_text') {
        if (!secretForm.value) throw new Error(t('cloudflare.worker_settings.msg.at_least_one_secret'))
        await workersApi.updateSecret(accountId, name, secretForm.name.trim(), 'secret_text', secretForm.value)
        toast({ title: t('cloudflare.worker_settings.msg.secret_saved'), tone: 'success' })
      } else {
        const config = await workersApi.getWorkerConfig(accountId, name)
        const nextVars: DeployVarInput[] = config.vars
          .filter((variable) => variable.name !== secretForm.name.trim())
          .map((variable) => ({
            name: variable.name,
            value: variable.secret ? '' : variable.value,
            secret: variable.secret,
            keep: variable.secret,
          }))
        nextVars.push({ name: secretForm.name.trim(), value: secretForm.value, secret: false })
        const answer = await workersApi.batchDeploy(
          [{ accountId, workerName: name }],
          { vars: nextVars, isRedeploy: true },
        )
        if (answer.failed > 0) {
          throw new Error(answer.results[0]?.error ?? t('cloudflare.worker_settings.msg.save_failed'))
        }
        toast({ title: t('cloudflare.worker_settings.msg.var_saved'), tone: 'success' })
      }
      setSecretModal(false)
      await loadSecrets()
    } catch (reason) {
      toast({
        title: t('cloudflare.worker_settings.msg.save_failed'),
        description: cfErrorText(reason),
        tone: 'danger',
      })
    } finally {
      setSaving(false)
    }
  }

  async function deleteSecret(row: SecretRow): Promise<void> {
    const ok = await confirm({
      title: uiT('common.delete'),
      description: t('cloudflare.workers.table.delete_confirm', {
        type: row.type === 'secret_text' ? t('cloudflare.worker_settings.secret_text_label') : t('cloudflare.workers.env_vars.plain_label'),
        name: row.name,
      }),
      confirmLabel: uiT('common.delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    setSaving(true)
    try {
      if (row.type === 'secret_text') {
        await workersApi.deleteSecret(accountId, name, row.name)
        toast({ title: t('cloudflare.worker_settings.msg.secret_deleted'), tone: 'success' })
      } else {
        const config = await workersApi.getWorkerConfig(accountId, name)
        const nextVars: DeployVarInput[] = config.vars
          .filter((variable) => variable.name !== row.name)
          .map((variable) => ({
            name: variable.name,
            value: variable.secret ? '' : variable.value,
            secret: variable.secret,
            keep: variable.secret,
          }))
        const answer = await workersApi.batchDeploy(
          [{ accountId, workerName: name }],
          { vars: nextVars, isRedeploy: true },
        )
        if (answer.failed > 0) {
          throw new Error(answer.results[0]?.error ?? t('cloudflare.worker_settings.msg.save_failed'))
        }
        toast({ title: t('cloudflare.worker_settings.msg.var_deleted'), tone: 'success' })
      }
      await loadSecrets()
    } catch (reason) {
      toast({
        title: t('cloudflare.worker_settings.msg.delete_failed'),
        description: cfErrorText(reason),
        tone: 'danger',
      })
    } finally {
      setSaving(false)
    }
  }

  function applyPreset(value: string): void {
    setCronPreset(value)
    const parts = value.split(' ')
    setCronMin(parts[0] ?? '*')
    setCronHour(parts[1] ?? '*')
    setCronDay(parts[2] ?? '*')
    setCronMon(parts[3] ?? '*')
    setCronDow(parts[4] ?? '*')
    setShowCronFields(true)
  }

  function addCron(): void {
    if (!cronExpressions.includes(builtCron)) {
      setCronExpressions((current) => [...current, builtCron])
    }
  }

  async function saveSchedules(): Promise<void> {
    setSaving(true)
    try {
      await workersApi.updateSchedules(accountId, name, cronExpressions)
      toast({ title: t('cloudflare.worker_settings.msg.schedules_saved'), tone: 'success' })
      await loadSchedules()
    } catch (reason) {
      toast({
        title: t('cloudflare.worker_settings.msg.save_failed'),
        description: cfErrorText(reason),
        tone: 'danger',
      })
    } finally {
      setSaving(false)
    }
  }

  async function openDomainModal(): Promise<void> {
    setDomainZone('')
    setDomainSub('')
    setDomainEnvironment('production')
    setDomainModal(true)
    setError('')
    try {
      await ensureZones()
    } catch (reason) {
      setError(cfErrorText(reason))
    }
  }

  async function addDomain(): Promise<void> {
    const hostname = domainSub.trim() ? `${domainSub.trim()}.${domainZone}` : domainZone
    if (!hostname) {
      toast({ title: t('cloudflare.worker_settings.msg.domain_required'), tone: 'warning' })
      return
    }
    setSaving(true)
    try {
      await workersApi.createDomain(accountId, name, hostname, domainEnvironment)
      toast({ title: t('cloudflare.worker_settings.msg.domain_added'), tone: 'success' })
      setDomainModal(false)
      await loadDomains()
    } catch (reason) {
      toast({
        title: t('cloudflare.worker_settings.msg.save_failed'),
        description: cfErrorText(reason),
        tone: 'danger',
      })
    } finally {
      setSaving(false)
    }
  }

  async function deleteDomain(row: WorkerDomain): Promise<void> {
    const ok = await confirm({
      title: uiT('common.delete'),
      description: t('cloudflare.workers.table.delete_confirm', {
        type: t('cloudflare.worker_settings.domain'),
        name: row.hostname,
      }),
      confirmLabel: uiT('common.delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await workersApi.deleteDomain(accountId, name, row.id)
      toast({ title: t('cloudflare.worker_settings.msg.domain_deleted'), tone: 'success' })
      await loadDomains()
    } catch (reason) {
      toast({
        title: t('cloudflare.worker_settings.msg.delete_failed'),
        description: cfErrorText(reason),
        tone: 'danger',
      })
    }
  }

  async function toggleSubdomain(next: boolean): Promise<void> {
    setSaving(true)
    try {
      await workersApi.setSubdomain(accountId, name, next)
      toast({
        title: next
          ? t('cloudflare.worker_settings.msg.subdomain_enabled')
          : t('cloudflare.worker_settings.msg.subdomain_disabled'),
        tone: 'success',
      })
      await loadSubdomain()
    } catch (reason) {
      toast({
        title: t('cloudflare.worker_settings.msg.save_failed'),
        description: cfErrorText(reason),
        tone: 'danger',
      })
    } finally {
      setSaving(false)
    }
  }

  async function updateSetting(patch: Record<string, unknown>): Promise<void> {
    try {
      await workersApi.updateSettings(accountId, name, patch)
      toast({ title: t('cloudflare.worker_settings.msg.settings_updated'), tone: 'success' })
      await loadSettings()
    } catch (reason) {
      toast({
        title: t('cloudflare.worker_settings.msg.save_failed'),
        description: cfErrorText(reason),
        tone: 'danger',
      })
    }
  }

  async function addTag(): Promise<void> {
    const tag = tagDraft.trim()
    if (!tag) return
    const tags = [...(settings?.tags ?? []), tag]
    setTagDraft('')
    await updateSetting({ tags })
  }

  async function removeTag(tag: string): Promise<void> {
    await updateSetting({ tags: (settings?.tags ?? []).filter((item) => item !== tag) })
  }

  async function loadZonesForRoutes(): Promise<void> {
    setError('')
    try {
      await ensureZones()
    } catch (reason) {
      setError(cfErrorText(reason))
    }
  }

  async function loadRoutes(): Promise<void> {
    if (!routeZoneId) {
      toast({ title: t('cloudflare.worker_settings.msg.zone_required'), tone: 'warning' })
      return
    }
    setError('')
    try {
      setRoutes(await workersApi.getRoutes(accountId, name, routeZoneId))
    } catch (reason) {
      setError(cfErrorText(reason))
    }
  }

  async function openRouteModal(): Promise<void> {
    setRouteForm({ zoneId: routeZoneId, pattern: '' })
    setRouteModal(true)
    await loadZonesForRoutes()
  }

  async function addRoute(): Promise<void> {
    if (!routeForm.zoneId || !routeForm.pattern.trim()) {
      toast({ title: t('cloudflare.worker_settings.msg.info_required'), tone: 'warning' })
      return
    }
    setSaving(true)
    try {
      const zoneId = routeForm.zoneId
      await workersApi.createRoute(accountId, name, zoneId, routeForm.pattern.trim())
      toast({ title: t('cloudflare.worker_settings.msg.route_added'), tone: 'success' })
      setRouteZoneId(zoneId)
      setRouteModal(false)
      setRouteForm({ zoneId: '', pattern: '' })
      setRoutes(await workersApi.getRoutes(accountId, name, zoneId))
    } catch (reason) {
      toast({
        title: t('cloudflare.worker_settings.msg.save_failed'),
        description: cfErrorText(reason),
        tone: 'danger',
      })
    } finally {
      setSaving(false)
    }
  }

  async function deleteRoute(row: WorkerRoute): Promise<void> {
    if (!routeZoneId) return
    const ok = await confirm({
      title: uiT('common.delete'),
      description: t('cloudflare.workers.table.delete_confirm', {
        type: t('cloudflare.worker_settings.tabs.routes'),
        name: row.pattern,
      }),
      confirmLabel: uiT('common.delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await workersApi.deleteRoute(accountId, name, row.id, routeZoneId)
      toast({ title: t('cloudflare.worker_settings.msg.route_deleted'), tone: 'success' })
      await loadRoutes()
    } catch (reason) {
      toast({
        title: t('cloudflare.worker_settings.msg.delete_failed'),
        description: cfErrorText(reason),
        tone: 'danger',
      })
    }
  }

  const tabs: Array<{ value: SettingsTab; label: string }> = [
    { value: 'secrets', label: t('cloudflare.worker_settings.tabs.secrets') },
    { value: 'schedules', label: t('cloudflare.worker_settings.tabs.schedules') },
    { value: 'domains', label: t('cloudflare.worker_settings.tabs.domains') },
    { value: 'subdomain', label: t('cloudflare.worker_settings.tabs.subdomain') },
    { value: 'settings', label: t('cloudflare.worker_settings.tabs.settings') },
    { value: 'routes', label: t('cloudflare.worker_settings.tabs.routes') },
    { value: 'source', label: t('cloudflare.worker_settings.tabs.source') },
    { value: 'deployments', label: t('cloudflare.worker_settings.tabs.deployments') },
  ]

  function onTabChange(next: SettingsTab): void {
    setTab(next)
    if (next === 'routes') void loadZonesForRoutes()
    if (next === 'source' && !content) void loadContent()
  }

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        width={880}
        title={t('cloudflare.worker_settings.drawer_title', { name })}
        bodyClassName="p-3"
      >
        <div className="mb-3">
          <Segmented<SettingsTab> value={tab} options={tabs} onChange={onTabChange} label={t('common.tabs')} />
        </div>
        {error && (
          <p role="alert" className="mb-3 rounded-[var(--r-sm)] bg-[var(--bg-sunken)] p-2 text-[length:var(--text-11-5)] text-[var(--danger)]">
            {error}
          </p>
        )}
        {loading ? <LoadingBlock /> : (
          <>
            {tab === 'secrets' && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                    {t('cloudflare.worker_settings.env_and_secrets')}
                  </p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setEnvSyncOpen(true)}>
                      {t('cloudflare.worker_settings.sync_to_other')}
                    </Button>
                    <Button size="sm" variant="primary" onClick={() => openSecretModal()}>
                      {t('cloudflare.worker_settings.add_var')}
                    </Button>
                  </div>
                </div>
                <Table>
                  <THead>
                    <Tr>
                      <Th>{t('cloudflare.worker_settings.secret_name')}</Th>
                      <Th>{t('cloudflare.worker_settings.secret_type')}</Th>
                      <Th>{t('cloudflare.worker_settings.var_value_label')}</Th>
                      <Th className="w-32">{t('cloudflare.workers.table.actions')}</Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {secrets.map((row) => (
                      <Tr key={`${row.type}-${row.name}`}>
                        <Td>{row.name}</Td>
                        <Td>
                          <Badge tone={row.type === 'secret_text' ? 'warning' : 'accent'}>
                            {row.type === 'secret_text'
                              ? t('cloudflare.workers.env_vars.secret_label')
                              : t('cloudflare.workers.env_vars.plain_label')}
                          </Badge>
                        </Td>
                        <Td className="font-mono text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                          {row.type === 'secret_text' ? '******' : row.value || '—'}
                        </Td>
                        <Td>
                          <div className="flex gap-1">
                            <Button size="sm" variant="ghost" onClick={() => openSecretModal(row)}>
                              {uiT('common.edit')}
                            </Button>
                            <IconButton label={uiT('common.delete')} size="sm" onClick={() => void deleteSecret(row)}>
                              <Trash2 size={13} />
                            </IconButton>
                          </div>
                        </Td>
                      </Tr>
                    ))}
                    {secrets.length === 0 && (
                      <Tr>
                        <Td colSpan={4} className="py-6 text-center text-[var(--text-tertiary)]">
                          {t('share.no_data_yet')}
                        </Td>
                      </Tr>
                    )}
                  </TBody>
                </Table>
              </div>
            )}

            {tab === 'schedules' && (
              <div className="space-y-3">
                <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                  {t('cloudflare.worker_settings.schedules_hint')}
                </p>
                {schedules.length > 0 && (
                  <Table>
                    <THead>
                      <Tr>
                        <Th>{t('cloudflare.worker_settings.cron_expr')}</Th>
                        <Th>{t('cloudflare.worker_settings.modified_time')}</Th>
                      </Tr>
                    </THead>
                    <TBody>
                      {schedules.map((schedule) => (
                        <Tr key={schedule.id ?? schedule.cron}>
                          <Td>
                            <span className="font-mono">{schedule.cron}</span>
                            <span className="ml-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                              {describeCron(schedule.cron)}
                            </span>
                          </Td>
                          <Td>{dateText(schedule.modified_on)}</Td>
                        </Tr>
                      ))}
                    </TBody>
                  </Table>
                )}
                <div className="space-y-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
                  <p className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
                    {t('cloudflare.worker_settings.build_cron')}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {CRON_PRESETS.map((preset) => (
                      <Button
                        key={preset.value}
                        size="sm"
                        variant={cronPreset === preset.value ? 'primary' : 'secondary'}
                        onClick={() => applyPreset(preset.value)}
                      >
                        {t(preset.key)}
                      </Button>
                    ))}
                    <Button size="sm" variant="secondary" onClick={() => setShowCronFields((value) => !value)}>
                      {showCronFields ? t('cloudflare.worker_settings.collapse') : t('cloudflare.worker_settings.custom')}
                    </Button>
                  </div>
                  {showCronFields && (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                      {([
                        [t('cloudflare.worker_settings.minute'), cronMin, setCronMin],
                        [t('cloudflare.worker_settings.hour'), cronHour, setCronHour],
                        [t('cloudflare.worker_settings.day'), cronDay, setCronDay],
                        [t('cloudflare.worker_settings.month'), cronMon, setCronMon],
                        [t('cloudflare.worker_settings.week'), cronDow, setCronDow],
                      ] as const).map(([label, value, setter]) => (
                        <Field key={label} label={label}>
                          <Input
                            value={value}
                            onChange={(event) => {
                              setter(event.target.value)
                              setCronPreset('')
                            }}
                          />
                        </Field>
                      ))}
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="accent" className="font-mono">{builtCron}</Badge>
                    <span className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{describeCron(builtCron)}</span>
                    <Button size="sm" variant="secondary" disabled={cronExpressions.includes(builtCron)} onClick={addCron}>
                      {t('cloudflare.worker_settings.add_to_list')}
                    </Button>
                  </div>
                  {cronExpressions.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {cronExpressions.map((cron) => (
                        <span key={cron} className="inline-flex items-center gap-1 rounded-full bg-[var(--bg-sunken)] px-2 py-0.5">
                          <span className="font-mono text-[length:var(--text-11-5)]">{cron}</span>
                          <IconButton
                            label={uiT('common.remove')}
                            size="xs"
                            onClick={() => setCronExpressions((current) => current.filter((item) => item !== cron))}
                          >
                            <X size={11} />
                          </IconButton>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                      {t('cloudflare.worker_settings.no_cron')}
                    </p>
                  )}
                  <Button size="sm" variant="primary" loading={saving} onClick={() => void saveSchedules()}>
                    {t('cloudflare.worker_settings.save_schedules')}
                  </Button>
                </div>
              </div>
            )}

            {tab === 'domains' && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                    {t('cloudflare.worker_settings.domains_hint')}
                  </p>
                  <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => void openDomainModal()}>
                    {t('cloudflare.worker_settings.add_domain')}
                  </Button>
                </div>
                <Table>
                  <THead>
                    <Tr>
                      <Th>{t('cloudflare.worker_settings.domain')}</Th>
                      <Th>{t('cloudflare.worker_settings.environment')}</Th>
                      <Th className="w-40">{t('cloudflare.workers.table.actions')}</Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {domains.map((row) => (
                      <Tr key={row.id}>
                        <Td>
                          <a
                            href={`https://${row.hostname}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[var(--accent)] hover:underline"
                          >
                            {row.hostname}
                          </a>
                        </Td>
                        <Td><Badge tone={row.environment === 'production' ? 'success' : 'warning'}>{row.environment || '—'}</Badge></Td>
                        <Td>
                          <div className="flex gap-1">
                            <a
                              href={`https://${row.hostname}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={t('cloudflare.worker_settings.open')}
                              className="inline-flex size-8 items-center justify-center rounded-[var(--r-md)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] md:size-6"
                            >
                              <ExternalLink size={13} />
                            </a>
                            <IconButton label={uiT('common.delete')} size="sm" onClick={() => void deleteDomain(row)}>
                              <Trash2 size={13} />
                            </IconButton>
                          </div>
                        </Td>
                      </Tr>
                    ))}
                    {domains.length === 0 && (
                      <Tr>
                        <Td colSpan={3} className="py-6 text-center text-[var(--text-tertiary)]">
                          {t('share.no_data_yet')}
                        </Td>
                      </Tr>
                    )}
                  </TBody>
                </Table>
              </div>
            )}

            {tab === 'subdomain' && (
              <div className="space-y-3">
                <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                  {t('cloudflare.worker_settings.subdomain_hint')}
                </p>
                {subdomain && (
                  <div className="space-y-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[length:var(--text-12-5)]">{t('cloudflare.worker_settings.enable_status')}</span>
                      <Badge tone={subdomain.enabled ? 'success' : 'neutral'}>
                        {subdomain.enabled ? t('cloudflare.worker_settings.enabled') : t('cloudflare.worker_settings.not_enabled')}
                      </Badge>
                      <Switch
                        checked={subdomain.enabled === true}
                        label={t('cloudflare.worker_settings.enable_status')}
                        disabled={saving}
                        onChange={(next) => void toggleSubdomain(next)}
                      />
                    </div>
                    {subdomain.previews_enabled !== undefined && (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[length:var(--text-12-5)]">{t('cloudflare.worker_settings.preview_deploy')}</span>
                        <Badge tone={subdomain.previews_enabled ? 'success' : 'neutral'}>
                          {subdomain.previews_enabled ? t('cloudflare.worker_settings.enabled') : t('cloudflare.worker_settings.not_enabled')}
                        </Badge>
                      </div>
                    )}
                    {subdomain.url ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[length:var(--text-12-5)]">{t('cloudflare.worker_settings.access_url')}</span>
                        <a
                          href={subdomain.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="break-all text-[var(--accent)] hover:underline"
                        >
                          {subdomain.url}
                        </a>
                        <CopyButton text={subdomain.url} />
                      </div>
                    ) : subdomain.accountSubdomain === '' ? (
                      <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                        {t('cloudflare.worker_settings.subdomain_not_configured')}
                      </p>
                    ) : null}
                  </div>
                )}
              </div>
            )}

            {tab === 'settings' && (
              <div className="space-y-3">
                <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                  {t('cloudflare.worker_settings.script_settings_hint')}
                </p>
                {settings && (
                  <div className="space-y-4 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[length:var(--text-12-5)]">{t('cloudflare.worker_settings.observability')}</span>
                      <Switch
                        checked={settings.observability?.enabled === true}
                        label={t('cloudflare.worker_settings.observability')}
                        onChange={(next) => void updateSetting({ observability: { enabled: next } })}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[length:var(--text-12-5)]">{t('cloudflare.workers.table.logs_btn')}</span>
                      <Switch
                        checked={settings.logpush === true}
                        label={t('cloudflare.workers.table.logs_btn')}
                        onChange={(next) => void updateSetting({ logpush: next })}
                      />
                    </div>
                    <div className="space-y-2">
                      <span className="text-[length:var(--text-12-5)]">{t('cloudflare.worker_settings.tags')}</span>
                      <div className="flex flex-wrap gap-1.5">
                        {(settings.tags ?? []).map((tag) => (
                          <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-[var(--bg-sunken)] px-2 py-0.5">
                            <span className="text-[length:var(--text-11-5)]">{tag}</span>
                            <IconButton label={uiT('common.remove')} size="xs" onClick={() => void removeTag(tag)}>
                              <X size={11} />
                            </IconButton>
                          </span>
                        ))}
                      </div>
                      <div className="flex gap-2">
                        <Input
                          value={tagDraft}
                          aria-label={t('cloudflare.worker_settings.tags')}
                          placeholder={t('cloudflare.worker_settings.tags')}
                          className="w-48"
                          onChange={(event) => setTagDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                              event.preventDefault()
                              void addTag()
                            }
                          }}
                        />
                        <Button size="sm" variant="secondary" onClick={() => void addTag()}>
                          {t('cloudflare.worker_settings.add_to_list')}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {tab === 'routes' && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="w-72">
                    <SelectMenu
                      label={t('cloudflare.worker_settings.select_zone')}
                      value={routeZoneId}
                      options={zoneOptions}
                      onChange={setRouteZoneId}
                      placeholder={t('cloudflare.worker_settings.select_zone')}
                      width={280}
                    />
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => void loadRoutes()}>
                    {t('cloudflare.worker_settings.load_routes')}
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => void openRouteModal()}>
                    {t('cloudflare.worker_settings.add_route')}
                  </Button>
                </div>
                <Table>
                  <THead>
                    <Tr>
                      <Th>{t('cloudflare.worker_settings.pattern')}</Th>
                      <Th>{t('cloudflare.workers.script_source')}</Th>
                      <Th>{t('cloudflare.accounts.table.id')}</Th>
                      <Th className="w-24">{t('cloudflare.workers.table.actions')}</Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {routes.map((route) => (
                      <Tr key={route.id}>
                        <Td className="font-mono">{route.pattern}</Td>
                        <Td>{route.script || '—'}</Td>
                        <Td className="font-mono text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{route.id}</Td>
                        <Td>
                          <IconButton label={uiT('common.delete')} size="sm" onClick={() => void deleteRoute(route)}>
                            <Trash2 size={13} />
                          </IconButton>
                        </Td>
                      </Tr>
                    ))}
                    {routes.length === 0 && (
                      <Tr>
                        <Td colSpan={4} className="py-6 text-center text-[var(--text-tertiary)]">
                          {t('share.no_data_yet')}
                        </Td>
                      </Tr>
                    )}
                  </TBody>
                </Table>
              </div>
            )}

            {tab === 'source' && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                    {t('cloudflare.worker_settings.source_hint')}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<RefreshCw size={13} />}
                      loading={contentLoading}
                      onClick={() => void loadContent()}
                    >
                      {uiT('common.refresh')}
                    </Button>
                    {content && <CopyButton text={content} label={t('cloudflare.worker_settings.copy')} />}
                  </div>
                </div>
                {content ? (
                  <CodeEditor
                    value={content}
                    readOnly
                    minHeight={360}
                    ariaLabel={t('cloudflare.worker_settings.source_label')}
                  />
                ) : (
                  <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                    {contentLoading ? t('common.loading') : t('cloudflare.worker_settings.source_empty')}
                  </p>
                )}
              </div>
            )}

            {tab === 'deployments' && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                    {t('cloudflare.worker_settings.deployments_hint')}
                  </p>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<RefreshCw size={13} />}
                    onClick={() => void loadDeployments()}
                  >
                    {uiT('common.refresh')}
                  </Button>
                </div>
                <Table>
                  <THead>
                    <Tr>
                      <Th>{t('cloudflare.accounts.table.id')}</Th>
                      <Th>{t('cloudflare.worker_settings.created_time')}</Th>
                      <Th>{t('cloudflare.worker_settings.source_label')}</Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {deployments.map((deployment) => (
                      <Tr key={deployment.id ?? `${deployment.created_on}-${deployment.source}`}>
                        <Td className="font-mono text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{deployment.id ?? '—'}</Td>
                        <Td>{dateText(deployment.created_on)}</Td>
                        <Td>{deployment.source || '—'}</Td>
                      </Tr>
                    ))}
                    {deployments.length === 0 && (
                      <Tr>
                        <Td colSpan={3} className="py-6 text-center text-[var(--text-tertiary)]">
                          {t('share.no_data_yet')}
                        </Td>
                      </Tr>
                    )}
                  </TBody>
                </Table>
              </div>
            )}
          </>
        )}
      </Drawer>

      <ModalShell
        open={secretModal}
        title={secretEditing ? t('cloudflare.worker_settings.edit_var') : t('cloudflare.worker_settings.add_var')}
        onClose={() => setSecretModal(false)}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setSecretModal(false)} disabled={saving}>
              {uiT('common.cancel')}
            </Button>
            <Button variant="primary" loading={saving} onClick={() => void saveSecret()}>
              {uiT('common.save')}
            </Button>
          </>
        )}
      >
        <div className="space-y-3">
          <Field label={t('cloudflare.worker_settings.secret_name')} required>
            <Input
              value={secretForm.name}
              disabled={secretEditing}
              placeholder={t('cloudflare.worker_settings.secret_name_placeholder')}
              onChange={(event) => setSecretForm((form) => ({ ...form, name: event.target.value }))}
            />
          </Field>
          <Field label={t('cloudflare.worker_settings.secret_type')}>
            <Segmented
              value={secretForm.type}
              options={[
                { value: 'plain_text', label: t('cloudflare.workers.env_vars.plain_label') },
                { value: 'secret_text', label: t('cloudflare.worker_settings.secret_text_label') },
              ]}
              onChange={(next) => setSecretForm((form) => ({ ...form, type: next }))}
              disabled={secretEditing}
              label={t('cloudflare.worker_settings.secret_type')}
            />
          </Field>
          <Field label={t('cloudflare.worker_settings.var_value_label')}>
            <Input
              value={secretForm.value}
              type={secretForm.type === 'secret_text' ? 'password' : 'text'}
              placeholder={t('cloudflare.worker_settings.var_value_placeholder')}
              onChange={(event) => setSecretForm((form) => ({ ...form, value: event.target.value }))}
            />
          </Field>
        </div>
      </ModalShell>

      <ModalShell
        open={domainModal}
        title={t('cloudflare.worker_settings.domain_modal_title')}
        onClose={() => setDomainModal(false)}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setDomainModal(false)} disabled={saving}>
              {uiT('common.cancel')}
            </Button>
            <Button variant="primary" loading={saving} onClick={() => void addDomain()}>
              {uiT('common.save')}
            </Button>
          </>
        )}
      >
        <div className="space-y-3">
          <Field label={t('cloudflare.worker_settings.domain')} required>
            <div>
              <SelectMenu
                label={t('cloudflare.worker_settings.domain')}
                value={domainZone}
                options={zoneOptions}
                onChange={setDomainZone}
                placeholder={t('cloudflare.worker_settings.domain_placeholder')}
                width={360}
              />
            </div>
          </Field>
          {domainZone && (
            <Field label={t('cloudflare.worker_settings.domain_subdomain')}>
              <div className="flex gap-2">
                <Input
                  value={domainSub}
                  placeholder={t('cloudflare.worker_settings.domain_subdomain_placeholder')}
                  onChange={(event) => setDomainSub(event.target.value)}
                />
                <Input value={`.${domainZone}`} disabled className="w-2/5" />
              </div>
            </Field>
          )}
          {domainZone && (
            <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
              {t('cloudflare.worker_settings.preview')}: <Badge tone="accent" className="font-mono">{domainSub.trim() ? `${domainSub.trim()}.${domainZone}` : domainZone}</Badge>
            </p>
          )}
          <Field label={t('cloudflare.worker_settings.environment')}>
            <Segmented
              value={domainEnvironment}
              options={[
                { value: 'production', label: 'production' },
                { value: 'staging', label: 'staging' },
              ]}
              onChange={setDomainEnvironment}
              label={t('cloudflare.worker_settings.environment')}
            />
          </Field>
        </div>
      </ModalShell>

      <ModalShell
        open={routeModal}
        title={t('cloudflare.worker_settings.route_modal_title')}
        onClose={() => setRouteModal(false)}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setRouteModal(false)} disabled={saving}>
              {uiT('common.cancel')}
            </Button>
            <Button variant="primary" loading={saving} onClick={() => void addRoute()}>
              {uiT('common.save')}
            </Button>
          </>
        )}
      >
        <div className="space-y-3">
          <Field label={t('cloudflare.worker_settings.select_zone')} required>
            <div>
              <SelectMenu
                label={t('cloudflare.worker_settings.select_zone')}
                value={routeForm.zoneId}
                options={zoneOptions}
                onChange={(value) => setRouteForm((form) => {
                  const zone = zones.find((item) => item.id === value)
                  return {
                    ...form,
                    zoneId: value,
                    pattern: form.pattern || (zone ? `${zone.name}/*` : ''),
                  }
                })}
                placeholder={t('cloudflare.worker_settings.select_zone')}
                width={360}
              />
            </div>
          </Field>
          <Field label={t('cloudflare.worker_settings.pattern')} required>
            <Input
              value={routeForm.pattern}
              placeholder={t('cloudflare.worker_settings.pattern')}
              onChange={(event) => setRouteForm((form) => ({ ...form, pattern: event.target.value }))}
            />
          </Field>
        </div>
      </ModalShell>

      <EnvSyncDialog
        open={envSyncOpen}
        onClose={() => setEnvSyncOpen(false)}
        accountId={accountId}
        workerName={name}
        sourceKeys={secrets}
        onDone={() => void loadSecrets()}
      />
    </>
  )
}

function ModalShell({
  open,
  title,
  onClose,
  footer,
  children,
}: {
  open: boolean
  title: string
  onClose: () => void
  footer: ReactNode
  children: ReactNode
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} width={520} footer={footer}>
      {children}
    </Modal>
  )
}
