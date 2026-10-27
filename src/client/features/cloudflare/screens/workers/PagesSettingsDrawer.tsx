/**
 * A Pages project's settings: information, custom domains, environment variables, resource bindings
 * and deployment history.
 *
 * Pages keeps environment and binding configuration under `deployment_configs`, once for production
 * and once for preview. Every write here merges into the existing section rather than replacing it,
 * because a form that sends only its own fields would delete the rest of the project's configuration.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Checkbox, Field, Input, Segmented } from '../../../../components/form'
import { LoadingBlock } from '../../../../components/feedback'
import { Drawer, Modal, confirm } from '../../../../components/overlay'
import { Badge, Button, IconButton } from '../../../../components/primitives'
import { SelectMenu } from '../../../../components/select-menu'
import { useUi } from '../../../../store/ui'
import { t as uiT } from '../../../../lib/i18n'
import { cfErrorText } from '../../api/client'
import {
  workersApi,
  type D1Database,
  type KvNamespace,
  type PagesDeployment,
  type PagesDeploymentConfig,
  type PagesDomain,
  type PagesEnvVar,
  type PagesProject,
  type R2Bucket,
  type ZoneOption,
} from '../../api/workers'
import { TBody, Table, Td, THead, Th, Tr } from '../../components/Table'
import { useCfT } from '../../i18n'
import { formatDateTime } from '../../lib/format'

type PagesTab = 'info' | 'domains' | 'env' | 'bindings' | 'deployments'
type BindingTypeKey = 'kv_namespaces' | 'd1_databases' | 'r2_buckets' | 'ai'

interface BindingRow {
  typeKey: BindingTypeKey
  typeLabel: string
  name: string
  value: string
}

const PAGE_SIZE = 10

function dateText(value: string | null | undefined): string {
  if (!value) return '—'
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? formatDateTime(ms) : value
}

function parseBindings(config: PagesDeploymentConfig | undefined): BindingRow[] {
  if (!config) return []
  const rows: BindingRow[] = []
  for (const [name, item] of Object.entries(config.kv_namespaces ?? {})) {
    rows.push({ typeKey: 'kv_namespaces', typeLabel: 'KV', name, value: item?.namespace_id ?? '' })
  }
  for (const [name, item] of Object.entries(config.d1_databases ?? {})) {
    rows.push({ typeKey: 'd1_databases', typeLabel: 'D1', name, value: item?.id ?? '' })
  }
  for (const [name, item] of Object.entries(config.r2_buckets ?? {})) {
    rows.push({ typeKey: 'r2_buckets', typeLabel: 'R2', name, value: item?.name ?? '' })
  }
  for (const name of Object.keys(config.ai ?? {})) {
    rows.push({ typeKey: 'ai', typeLabel: 'AI', name, value: '—' })
  }
  return rows
}

export function PagesSettingsDrawer({
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
  const [tab, setTab] = useState<PagesTab>('info')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [project, setProject] = useState<PagesProject | null>(null)
  const [domains, setDomains] = useState<PagesDomain[]>([])
  const [deployments, setDeployments] = useState<PagesDeployment[]>([])
  const [zones, setZones] = useState<ZoneOption[]>([])
  const [saving, setSaving] = useState(false)

  const [domainModal, setDomainModal] = useState(false)
  const [domainZone, setDomainZone] = useState('')
  const [domainSub, setDomainSub] = useState('')

  const [envModal, setEnvModal] = useState(false)
  const [envEditing, setEnvEditing] = useState(false)
  const [envForm, setEnvForm] = useState<{ name: string; value: string; type: 'plain_text' | 'secret_text' }>({
    name: '',
    value: '',
    type: 'plain_text',
  })

  const [bindingModal, setBindingModal] = useState(false)
  const [bindingType, setBindingType] = useState<BindingTypeKey>('kv_namespaces')
  const [bindingName, setBindingName] = useState('')
  const [bindingResource, setBindingResource] = useState('')
  const [bindingOptions, setBindingOptions] = useState<Array<{ value: string; label: string }>>([])
  const [r2Disabled, setR2Disabled] = useState(false)

  const [selectedDeployments, setSelectedDeployments] = useState<string[]>([])
  const [deploymentPage, setDeploymentPage] = useState(1)

  const production = project?.deployment_configs?.production
  const envVars = useMemo(() => {
    const entries = Object.entries(production?.env_vars ?? {})
    return entries.map(([key, value]) => ({
      name: key,
      type: value?.type === 'secret_text' ? 'secret_text' as const : 'plain_text' as const,
      value: value?.type === 'plain_text' ? value.value ?? '' : '******',
    }))
  }, [production])
  const bindings = useMemo(() => parseBindings(production), [production])

  const zoneOptions = useMemo(
    () => zones.map((zone) => ({ value: zone.name, label: `${zone.name}${zone.status ? ` (${zone.status})` : ''}` })),
    [zones],
  )

  const pageCount = Math.max(1, Math.ceil(deployments.length / PAGE_SIZE))
  const pageRows = deployments.slice((deploymentPage - 1) * PAGE_SIZE, deploymentPage * PAGE_SIZE)
  const selectedProduction = deployments
    .filter((deployment) => selectedDeployments.includes(deployment.id) && deployment.environment === 'production')
    .length

  async function loadProject(): Promise<void> {
    const answer = await workersApi.getPagesProject(accountId, name)
    setProject(answer)
  }

  async function loadDomains(): Promise<void> {
    setDomains(await workersApi.getPagesDomains(accountId, name))
  }

  async function loadDeployments(): Promise<void> {
    const answer = await workersApi.getPagesDeployments(accountId, name)
    setDeployments(Array.isArray(answer) ? answer : [])
    setSelectedDeployments([])
    setDeploymentPage(1)
  }

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setTab('info')
    setError('')
    setProject(null)
    setDomains([])
    setDeployments([])
    setZones([])
    setSelectedDeployments([])
    setDeploymentPage(1)
    setLoading(true)
    void (async () => {
      const results = await Promise.allSettled([loadProject(), loadDomains(), loadDeployments()])
      if (cancelled) return
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failure) setError(cfErrorText(failure.reason))
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
    // The loaders read accountId/name; reopening on another project is the only reason to reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, accountId, name])

  async function ensureZones(): Promise<void> {
    if (zones.length > 0) return
    setZones(await workersApi.getZones(accountId))
  }

  async function openDomainModal(): Promise<void> {
    setDomainZone('')
    setDomainSub('')
    setDomainModal(true)
    try {
      await ensureZones()
    } catch (reason) {
      setError(cfErrorText(reason))
    }
  }

  async function addDomain(): Promise<void> {
    const hostname = domainSub.trim() ? `${domainSub.trim()}.${domainZone}` : domainZone
    if (!hostname) {
      toast({ title: t('cloudflare.pages_settings.msg.domain_required'), tone: 'warning' })
      return
    }
    setSaving(true)
    try {
      await workersApi.addPagesDomain(accountId, name, hostname)
      toast({ title: t('cloudflare.pages_settings.msg.domain_added'), tone: 'success' })
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

  async function removeDomain(row: PagesDomain): Promise<void> {
    const ok = await confirm({
      title: uiT('common.delete'),
      description: t('cloudflare.workers.table.delete_confirm', {
        type: t('cloudflare.pages_settings.domain'),
        name: row.name,
      }),
      confirmLabel: uiT('common.delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await workersApi.removePagesDomain(accountId, name, row.name)
      toast({ title: t('cloudflare.pages_settings.msg.domain_deleted'), tone: 'success' })
      await loadDomains()
    } catch (reason) {
      toast({
        title: t('cloudflare.pages_settings.msg.delete_failed'),
        description: cfErrorText(reason),
        tone: 'danger',
      })
    }
  }

  function openEnvModal(row?: { name: string; type: 'plain_text' | 'secret_text'; value: string }): void {
    setEnvEditing(Boolean(row))
    setEnvForm({
      name: row?.name ?? '',
      type: row?.type ?? 'plain_text',
      value: row?.type === 'plain_text' ? row.value : '',
    })
    setEnvModal(true)
  }

  async function saveEnv(): Promise<void> {
    if (!envForm.name.trim()) {
      toast({ title: t('cloudflare.pages_settings.msg.var_name_required'), tone: 'warning' })
      return
    }
    setSaving(true)
    try {
      const current = await workersApi.getPagesProject(accountId, name)
      const prod = current.deployment_configs?.production ?? {}
      const preview = current.deployment_configs?.preview ?? {}
      const prodVars = { ...(prod.env_vars ?? {}) }
      const previewVars = { ...(preview.env_vars ?? {}) }
      const value: PagesEnvVar = {
        type: envForm.type,
        value: envForm.value,
      }
      prodVars[envForm.name.trim()] = value
      previewVars[envForm.name.trim()] = value
      await workersApi.editPagesProject(accountId, name, {
        deployment_configs: {
          production: { ...prod, env_vars: prodVars },
          preview: { ...preview, env_vars: previewVars },
        },
      })
      toast({ title: t('cloudflare.pages_settings.msg.var_saved'), tone: 'success' })
      setEnvModal(false)
      await loadProject()
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

  async function deleteEnv(row: { name: string }): Promise<void> {
    const ok = await confirm({
      title: uiT('common.delete'),
      description: t('cloudflare.workers.table.delete_confirm', {
        type: t('cloudflare.pages_settings.var_name'),
        name: row.name,
      }),
      confirmLabel: uiT('common.delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      const current = await workersApi.getPagesProject(accountId, name)
      const prod = current.deployment_configs?.production ?? {}
      const preview = current.deployment_configs?.preview ?? {}
      const prodVars = { ...(prod.env_vars ?? {}) }
      const previewVars = { ...(preview.env_vars ?? {}) }
      delete prodVars[row.name]
      delete previewVars[row.name]
      await workersApi.editPagesProject(accountId, name, {
        deployment_configs: {
          production: { ...prod, env_vars: prodVars },
          preview: { ...preview, env_vars: previewVars },
        },
      })
      toast({ title: t('cloudflare.pages_settings.msg.var_deleted'), tone: 'success' })
      await loadProject()
    } catch (reason) {
      toast({
        title: t('cloudflare.pages_settings.msg.delete_failed'),
        description: cfErrorText(reason),
        tone: 'danger',
      })
    }
  }

  async function loadBindingResources(type: BindingTypeKey): Promise<void> {
    setBindingResource('')
    setBindingOptions([])
    setR2Disabled(false)
    try {
      if (type === 'kv_namespaces') {
        const list = await workersApi.getKvNamespaces(accountId) as KvNamespace[]
        setBindingOptions(list.map((item) => ({ value: item.id, label: item.title || item.id })))
      } else if (type === 'd1_databases') {
        const list = await workersApi.getD1Databases(accountId) as D1Database[]
        setBindingOptions(list.map((item) => ({
          value: item.uuid || item.name || '',
          label: item.name || item.uuid || '',
        })))
      } else if (type === 'r2_buckets') {
        const answer = await workersApi.getR2Buckets(accountId)
        setR2Disabled(answer.r2_not_enabled)
        setBindingOptions(answer.buckets.map((item: R2Bucket) => ({
          value: item.name || '',
          label: item.name || '',
        })))
      }
    } catch (reason) {
      setBindingOptions([])
      setError(cfErrorText(reason))
    }
  }

  async function openBindingModal(): Promise<void> {
    setBindingType('kv_namespaces')
    setBindingName('')
    setBindingModal(true)
    await loadBindingResources('kv_namespaces')
  }

  async function addBinding(): Promise<void> {
    const nextName = bindingName.trim()
    if (!nextName) {
      toast({ title: t('cloudflare.pages_settings.msg.var_name_required'), tone: 'warning' })
      return
    }
    if (bindingType !== 'ai' && !bindingResource) {
      toast({ title: t('cloudflare.pages_settings.msg.resource_required'), tone: 'warning' })
      return
    }
    setSaving(true)
    try {
      const current = await workersApi.getPagesProject(accountId, name)
      const prod = current.deployment_configs?.production ?? {}
      const preview = current.deployment_configs?.preview ?? {}
      const entry = bindingType === 'kv_namespaces'
        ? { namespace_id: bindingResource }
        : bindingType === 'd1_databases'
          ? { id: bindingResource }
          : bindingType === 'r2_buckets'
            ? { name: bindingResource }
            : {}
      const prodSection = { ...((prod[bindingType] ?? {}) as Record<string, unknown>), [nextName]: entry }
      const previewSection = { ...((preview[bindingType] ?? {}) as Record<string, unknown>), [nextName]: entry }
      await workersApi.updatePagesBindings(accountId, name, {
        production: { ...prod, [bindingType]: prodSection },
        preview: { ...preview, [bindingType]: previewSection },
      })
      toast({ title: t('cloudflare.pages_settings.msg.binding_added'), tone: 'success' })
      setBindingModal(false)
      await loadProject()
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

  async function deleteBinding(row: BindingRow): Promise<void> {
    const ok = await confirm({
      title: uiT('common.delete'),
      description: t('cloudflare.workers.table.delete_confirm', {
        type: row.typeLabel,
        name: row.name,
      }),
      confirmLabel: uiT('common.delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      const current = await workersApi.getPagesProject(accountId, name)
      const prod = current.deployment_configs?.production ?? {}
      const preview = current.deployment_configs?.preview ?? {}
      const prodSection = { ...((prod[row.typeKey] ?? {}) as Record<string, unknown>) }
      const previewSection = { ...((preview[row.typeKey] ?? {}) as Record<string, unknown>) }
      delete prodSection[row.name]
      delete previewSection[row.name]
      await workersApi.updatePagesBindings(accountId, name, {
        production: {
          ...prod,
          [row.typeKey]: Object.keys(prodSection).length > 0 ? prodSection : null,
        },
        preview: {
          ...preview,
          [row.typeKey]: Object.keys(previewSection).length > 0 ? previewSection : null,
        },
      })
      toast({ title: t('cloudflare.pages_settings.msg.binding_deleted'), tone: 'success' })
      await loadProject()
    } catch (reason) {
      toast({
        title: t('cloudflare.pages_settings.msg.delete_failed'),
        description: cfErrorText(reason),
        tone: 'danger',
      })
    }
  }

  function toggleDeployment(id: string): void {
    setSelectedDeployments((current) => (
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    ))
  }

  async function deleteDeployments(): Promise<void> {
    const ids = [...selectedDeployments]
    if (ids.length === 0) return
    const ok = await confirm({
      title: t('cloudflare.pages_settings.batch_delete_title'),
      description: `${t('cloudflare.pages_settings.batch_delete_confirm', { count: ids.length })}${
        selectedProduction > 0
          ? ` ${t('cloudflare.pages_settings.batch_delete_warning', { count: selectedProduction })}`
          : ''
      }`,
      confirmLabel: uiT('common.delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    setSaving(true)
    try {
      const answer = await workersApi.deletePagesDeployments(accountId, name, ids)
      if (answer.succeeded === 0) {
        toast({
          title: t('cloudflare.pages_settings.msg.batch_delete_all_failed', {
            error: answer.results.find((row) => row.error)?.error ?? '',
          }),
          tone: 'danger',
        })
      } else if (answer.failed > 0) {
        toast({
          title: t('cloudflare.pages_settings.msg.batch_delete_partial', {
            succeeded: answer.succeeded,
            failed: answer.failed,
            error: answer.results.find((row) => !row.success)?.error ?? '',
          }),
          tone: 'warning',
        })
      } else {
        toast({
          title: t('cloudflare.pages_settings.msg.batch_delete_success', { count: answer.succeeded }),
          tone: 'success',
        })
      }
      await loadDeployments()
    } catch (reason) {
      toast({
        title: t('cloudflare.pages_settings.msg.batch_delete_failed'),
        description: cfErrorText(reason),
        tone: 'danger',
      })
    } finally {
      setSaving(false)
    }
  }

  const tabs: Array<{ value: PagesTab; label: string }> = [
    { value: 'info', label: t('cloudflare.pages_settings.tabs.info') },
    { value: 'domains', label: t('cloudflare.pages_settings.tabs.domains') },
    { value: 'env', label: t('cloudflare.pages_settings.tabs.env_vars') },
    { value: 'bindings', label: t('cloudflare.pages_settings.tabs.bindings') },
    { value: 'deployments', label: t('cloudflare.pages_settings.tabs.deployments') },
  ]

  const bindingTypeOptions: Array<{ value: BindingTypeKey; label: string }> = [
    { value: 'kv_namespaces', label: t('cloudflare.pages_settings.binding_types.kv') },
    { value: 'd1_databases', label: t('cloudflare.pages_settings.binding_types.d1') },
    { value: 'r2_buckets', label: t('cloudflare.pages_settings.binding_types.r2') },
    { value: 'ai', label: 'AI' },
  ]

  return (
    <>
      <DrawerShell
        open={open}
        onClose={onClose}
        title={t('cloudflare.pages_settings.drawer_title', { name })}
      >
        <div className="mb-3">
          <Segmented<PagesTab> value={tab} options={tabs} onChange={setTab} label={t('common.tabs')} />
        </div>
        {error && (
          <p role="alert" className="mb-3 rounded-[var(--r-sm)] bg-[var(--bg-sunken)] p-2 text-[length:var(--text-11-5)] text-[var(--danger)]">
            {error}
          </p>
        )}
        {loading ? <LoadingBlock /> : (
          <>
            {tab === 'info' && (
              <div className="space-y-3">
                <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                  {t('cloudflare.pages_settings.info_hint')}
                </p>
                {project && (
                  <dl className="grid grid-cols-1 gap-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3 sm:grid-cols-2">
                    {([
                      [t('cloudflare.pages_settings.name'), project.name ?? '—'],
                      [t('cloudflare.accounts.table.id'), project.id ?? '—'],
                      [t('cloudflare.pages_settings.production_branch'), project.production_branch ?? '—'],
                      [t('cloudflare.pages_settings.framework'), project.framework || '—'],
                      [t('cloudflare.pages_settings.subdomain'), project.subdomain ?? '—'],
                      [t('cloudflare.pages_settings.created_time'), dateText(project.created_on)],
                      [t('cloudflare.pages_settings.functions'), project.uses_functions ? uiT('common.on') : uiT('common.off')],
                    ] as const).map(([label, value]) => (
                      <div key={label}>
                        <dt className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{label}</dt>
                        <dd className="break-all text-[length:var(--text-12-5)] text-[var(--text-primary)]">{value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            )}

            {tab === 'domains' && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                    {t('cloudflare.pages_settings.domains_hint')}
                  </p>
                  <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => void openDomainModal()}>
                    {t('cloudflare.pages_settings.add_domain')}
                  </Button>
                </div>
                <Table>
                  <THead>
                    <Tr>
                      <Th>{t('cloudflare.pages_settings.domain')}</Th>
                      <Th>{t('cloudflare.pages_settings.status')}</Th>
                      <Th className="w-40">{t('cloudflare.workers.table.actions')}</Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {domains.map((row) => (
                      <Tr key={row.name}>
                        <Td>
                          <a
                            href={`https://${row.name}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[var(--accent)] hover:underline"
                          >
                            {row.name}
                          </a>
                        </Td>
                        <Td><Badge tone={row.status === 'active' ? 'success' : 'warning'}>{row.status || '—'}</Badge></Td>
                        <Td>
                          <IconButton label={uiT('common.delete')} size="sm" onClick={() => void removeDomain(row)}>
                            <Trash2 size={13} />
                          </IconButton>
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

            {tab === 'env' && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                    {t('cloudflare.pages_settings.env_vars_hint')}
                  </p>
                  <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => openEnvModal()}>
                    {t('cloudflare.pages_settings.add_var')}
                  </Button>
                </div>
                <Table>
                  <THead>
                    <Tr>
                      <Th>{t('cloudflare.pages_settings.var_name')}</Th>
                      <Th>{t('cloudflare.pages_settings.var_type')}</Th>
                      <Th>{t('cloudflare.pages_settings.var_value')}</Th>
                      <Th className="w-32">{t('cloudflare.workers.table.actions')}</Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {envVars.map((row) => (
                      <Tr key={row.name}>
                        <Td>{row.name}</Td>
                        <Td>
                          <Badge tone={row.type === 'secret_text' ? 'warning' : 'accent'}>
                            {row.type === 'secret_text'
                              ? t('cloudflare.pages_settings.secret_text')
                              : t('cloudflare.pages_settings.plain_text')}
                          </Badge>
                        </Td>
                        <Td className="font-mono text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{row.value}</Td>
                        <Td>
                          <div className="flex gap-1">
                            <Button size="sm" variant="ghost" onClick={() => openEnvModal(row)}>
                              {uiT('common.edit')}
                            </Button>
                            <IconButton label={uiT('common.delete')} size="sm" onClick={() => void deleteEnv(row)}>
                              <Trash2 size={13} />
                            </IconButton>
                          </div>
                        </Td>
                      </Tr>
                    ))}
                    {envVars.length === 0 && (
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

            {tab === 'bindings' && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                    {t('cloudflare.pages_settings.bindings_hint')}
                  </p>
                  <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => void openBindingModal()}>
                    {t('cloudflare.pages_settings.add_binding')}
                  </Button>
                </div>
                <Table>
                  <THead>
                    <Tr>
                      <Th>{t('cloudflare.pages_settings.binding_type')}</Th>
                      <Th>{t('cloudflare.pages_settings.binding_name')}</Th>
                      <Th>{t('cloudflare.pages_settings.binding_resource')}</Th>
                      <Th className="w-24">{t('cloudflare.workers.table.actions')}</Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {bindings.map((row) => (
                      <Tr key={`${row.typeKey}-${row.name}`}>
                        <Td><Badge tone={row.typeKey === 'kv_namespaces' ? 'accent' : row.typeKey === 'd1_databases' ? 'warning' : 'success'}>{row.typeLabel}</Badge></Td>
                        <Td>{row.name}</Td>
                        <Td className="font-mono text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{row.value}</Td>
                        <Td>
                          <IconButton label={uiT('common.delete')} size="sm" onClick={() => void deleteBinding(row)}>
                            <Trash2 size={13} />
                          </IconButton>
                        </Td>
                      </Tr>
                    ))}
                    {bindings.length === 0 && (
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

            {tab === 'deployments' && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                    {t('cloudflare.pages_settings.deployments_hint')}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setSelectedDeployments(pageRows.map((row) => row.id))}
                    >
                      {t('cloudflare.pages_settings.select_all_page')}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setSelectedDeployments([])}>
                      {t('cloudflare.pages_settings.deselect_all')}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={selectedDeployments.length === 0 || saving}
                      onClick={() => void deleteDeployments()}
                    >
                      {t('cloudflare.pages_settings.delete_selected', { count: selectedDeployments.length })}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<RefreshCw size={13} />}
                      onClick={() => void loadDeployments()}
                    >
                      {uiT('common.refresh')}
                    </Button>
                  </div>
                </div>
                <Table>
                  <THead>
                    <Tr>
                      <Th className="w-10">
                        <span className="sr-only">{t('cloudflare.pages_settings.batch_delete_title')}</span>
                      </Th>
                      <Th>{t('cloudflare.accounts.table.id')}</Th>
                      <Th>{t('cloudflare.pages_settings.status')}</Th>
                      <Th>{t('cloudflare.pages_settings.stage')}</Th>
                      <Th>{t('cloudflare.workers.url')}</Th>
                      <Th>{t('cloudflare.pages_settings.created_time')}</Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {pageRows.map((row) => (
                      <Tr key={row.id}>
                        <Td>
                          <Checkbox
                            checked={selectedDeployments.includes(row.id)}
                            label={<span className="sr-only">{row.id}</span>}
                            onChange={() => toggleDeployment(row.id)}
                          />
                        </Td>
                        <Td className="font-mono text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{row.id}</Td>
                        <Td>
                          <Badge tone={row.environment === 'production' ? 'success' : 'accent'}>{row.environment || '—'}</Badge>
                          <Badge tone={row.latest_stage?.status === 'success' ? 'success' : row.latest_stage?.status === 'failure' ? 'danger' : 'neutral'} className="ml-1">
                            {row.latest_stage?.status || '—'}
                          </Badge>
                        </Td>
                        <Td>{row.latest_stage?.name || '—'}</Td>
                        <Td>
                          {row.url ? (
                            <a
                              href={row.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="break-all text-[length:var(--text-11-5)] text-[var(--accent)] hover:underline"
                            >
                              {row.url}
                            </a>
                          ) : '—'}
                        </Td>
                        <Td>{dateText(row.created_on)}</Td>
                      </Tr>
                    ))}
                    {deployments.length === 0 && (
                      <Tr>
                        <Td colSpan={6} className="py-6 text-center text-[var(--text-tertiary)]">
                          {t('share.no_data_yet')}
                        </Td>
                      </Tr>
                    )}
                  </TBody>
                </Table>
                {deployments.length > 0 && (
                  <div className="flex items-center justify-end gap-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                    <Button size="sm" variant="secondary" disabled={deploymentPage <= 1} onClick={() => setDeploymentPage((page) => page - 1)}>
                      ‹
                    </Button>
                    <span>{deploymentPage} / {pageCount}</span>
                    <Button size="sm" variant="secondary" disabled={deploymentPage >= pageCount} onClick={() => setDeploymentPage((page) => page + 1)}>
                      ›
                    </Button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </DrawerShell>

      <Dialog
        open={domainModal}
        onClose={() => setDomainModal(false)}
        title={t('cloudflare.pages_settings.domain_modal_title')}
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
          <Field label={t('cloudflare.pages_settings.domain')} required>
            <div>
              <SelectMenu
                label={t('cloudflare.pages_settings.domain')}
                value={domainZone}
                options={zoneOptions}
                onChange={setDomainZone}
                placeholder={t('cloudflare.pages_settings.domain_placeholder')}
                width={360}
              />
            </div>
          </Field>
          {domainZone && (
            <Field label={t('cloudflare.pages_settings.subdomain')}>
              <div className="flex gap-2">
                <Input
                  value={domainSub}
                  placeholder={t('cloudflare.pages_settings.subdomain_placeholder')}
                  onChange={(event) => setDomainSub(event.target.value)}
                />
                <Input value={`.${domainZone}`} disabled className="w-2/5" />
              </div>
            </Field>
          )}
          {domainZone && (
            <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
              {t('cloudflare.pages_settings.preview')}: <Badge tone="accent" className="font-mono">{domainSub.trim() ? `${domainSub.trim()}.${domainZone}` : domainZone}</Badge>
            </p>
          )}
        </div>
      </Dialog>

      <Dialog
        open={envModal}
        onClose={() => setEnvModal(false)}
        title={envEditing
          ? t('cloudflare.pages_settings.env_modal_title_edit')
          : t('cloudflare.pages_settings.env_modal_title_add')}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setEnvModal(false)} disabled={saving}>
              {uiT('common.cancel')}
            </Button>
            <Button variant="primary" loading={saving} onClick={() => void saveEnv()}>
              {uiT('common.save')}
            </Button>
          </>
        )}
      >
        <div className="space-y-3">
          <Field label={t('cloudflare.pages_settings.var_name')} required>
            <Input
              value={envForm.name}
              disabled={envEditing}
              placeholder={t('cloudflare.pages_settings.var_name_placeholder')}
              onChange={(event) => setEnvForm((form) => ({ ...form, name: event.target.value }))}
            />
          </Field>
          <Field label={t('cloudflare.pages_settings.var_value')}>
            <Input
              value={envForm.value}
              type={envForm.type === 'secret_text' ? 'password' : 'text'}
              placeholder={t('cloudflare.pages_settings.var_value_placeholder')}
              onChange={(event) => setEnvForm((form) => ({ ...form, value: event.target.value }))}
            />
          </Field>
          <Field label={t('cloudflare.pages_settings.var_type')}>
            <Segmented
              value={envForm.type}
              options={[
                { value: 'plain_text', label: t('cloudflare.pages_settings.plain_text') },
                { value: 'secret_text', label: t('cloudflare.pages_settings.secret_text') },
              ]}
              onChange={(next) => setEnvForm((form) => ({ ...form, type: next }))}
              label={t('cloudflare.pages_settings.var_type')}
            />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={bindingModal}
        onClose={() => setBindingModal(false)}
        title={t('cloudflare.pages_settings.binding_modal_title')}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setBindingModal(false)} disabled={saving}>
              {uiT('common.cancel')}
            </Button>
            <Button variant="primary" loading={saving} onClick={() => void addBinding()}>
              {uiT('common.save')}
            </Button>
          </>
        )}
      >
        <div className="space-y-3">
          <Field label={t('cloudflare.pages_settings.binding_type')}>
            <div>
              <SelectMenu
                label={t('cloudflare.pages_settings.binding_type')}
                value={bindingType}
                options={bindingTypeOptions}
                onChange={(next) => {
                  setBindingType(next)
                  void loadBindingResources(next)
                }}
                width={280}
              />
            </div>
          </Field>
          <Field label={t('cloudflare.pages_settings.binding_name')} required>
            <Input
              value={bindingName}
              placeholder={t('cloudflare.pages_settings.binding_name_placeholder')}
              onChange={(event) => setBindingName(event.target.value)}
            />
          </Field>
          {bindingType !== 'ai' && (
            <Field label={t('cloudflare.pages_settings.binding_resource')} required>
              <div>
                <SelectMenu
                  label={t('cloudflare.pages_settings.binding_resource')}
                  value={bindingResource}
                  options={bindingOptions}
                  onChange={setBindingResource}
                  placeholder={t('cloudflare.pages_settings.binding_resource_placeholder')}
                  width={360}
                />
              </div>
            </Field>
          )}
          {r2Disabled && (
            <p role="status" className="text-[length:var(--text-11-5)] text-[var(--warning)]">
              {t('cloudflare.pages_settings.msg.r2_not_enabled')}
            </p>
          )}
        </div>
      </Dialog>
    </>
  )
}

function DrawerShell({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
}) {
  return (
    <Drawer open={open} onClose={onClose} width={880} title={title} bodyClassName="p-3">
      {children}
    </Drawer>
  )
}

function Dialog({
  open,
  onClose,
  title,
  footer,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  footer: ReactNode
  children: ReactNode
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} width={520} footer={footer}>
      {children}
    </Modal>
  )
}
