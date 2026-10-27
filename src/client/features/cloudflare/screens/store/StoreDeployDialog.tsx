import { useEffect, useMemo, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import type { CloudflareAccount } from '@shared/cloudflare/model'
import { Badge, Button } from '../../../../components/primitives'
import { Field, Input, Segmented } from '../../../../components/form'
import { SelectMenu } from '../../../../components/select-menu'
import { Modal } from '../../../../components/overlay'
import { MultiSelect } from '../../components/MultiSelect'
import { useUi } from '../../../../store/ui'
import { accountsApi } from '../../api/accounts'
import { cfErrorText, cfRequest } from '../../api/client'
import {
  storeApi,
  type CatalogBinding,
  type DeploymentResult,
  type PreflightResult,
  type StoreDeployment,
  type TemplateItem,
} from '../../api/store'
import { useCfT } from '../../i18n'
import {
  autoResourceName,
  defaultDeployName,
  resolveDeployType,
  type DeployChoice,
} from './helpers'

type Phase = 'form' | 'checking' | 'confirm' | 'deploying' | 'results'
type ResourceKind = 'kv' | 'd1' | 'r2'

interface ResourceOption {
  value: string
  label: string
}

interface ResourceState {
  kv: ResourceOption[]
  d1: ResourceOption[]
  r2: ResourceOption[]
  error: string
}

interface PreflightRow {
  accountId: string
  accountName: string
  result?: PreflightResult
  error?: string
}

const EMPTY_RESOURCES: ResourceState = { kv: [], d1: [], r2: [], error: '' }
const ACCOUNT_PAGE_SIZE = 100

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function records(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is Record<string, unknown> => (
    Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)
  ))
}

function recordText(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function accountHasR2(account: CloudflareAccount): boolean {
  const features = account.available_features.split(',').filter(Boolean)
  return features.includes('r2') && !features.includes('-r2')
}

async function readResources(accountId: string, kinds: readonly ResourceKind[]): Promise<ResourceState> {
  const state: ResourceState = { kv: [], d1: [], r2: [], error: '' }
  const errors: string[] = []
  await Promise.all(kinds.map(async (kind) => {
    try {
      const body = await cfRequest<unknown>(`/workers/${encodeURIComponent(accountId)}/resources/${kind}`)
      if (kind === 'r2') {
        state.r2 = records(asRecord(body).buckets)
          .map((record) => recordText(record, 'name'))
          .filter((name) => name.length > 0)
          .map((name) => ({ value: name, label: name }))
        return
      }
      state[kind] = records(body)
        .map((record) => {
          const id = recordText(record, kind === 'kv' ? 'id' : 'uuid')
          if (!id) return null
          const label = recordText(record, kind === 'kv' ? 'title' : 'name') || id
          return { value: id, label }
        })
        .filter((option): option is ResourceOption => option !== null)
    } catch (failure) {
      errors.push(`${kind.toUpperCase()}: ${cfErrorText(failure)}`)
    }
  }))
  state.error = errors.join('; ')
  return state
}

export function StoreDeployDialog({
  open,
  item,
  onClose,
}: {
  open: boolean
  item: TemplateItem | null
  onClose: () => void
}) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)

  const template = item?.template
  const templateId = template?.id ?? ''
  const bindings = useMemo(() => template?.bindings ?? [], [template])
  const selectableBindings = bindings.filter((binding) => (
    binding.type === 'kv' || binding.type === 'd1' || binding.type === 'r2' || binding.type === 'ai'
  ))
  const secretBindings = bindings.filter((binding) => binding.type === 'var')
  const needsR2 = bindings.some((binding) => binding.type === 'r2')
  const isHybrid = template?.type === 'hybrid'

  const [phase, setPhase] = useState<Phase>('form')
  const [accounts, setAccounts] = useState<CloudflareAccount[] | null>(null)
  const [accountAttempt, setAccountAttempt] = useState(0)
  const [accountError, setAccountError] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [name, setName] = useState('')
  const [choice, setChoice] = useState<DeployChoice>('both')
  const [selections, setSelections] = useState<Record<string, string>>({})
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [resources, setResources] = useState<ResourceState>(EMPTY_RESOURCES)
  const [resourceLoading, setResourceLoading] = useState(false)
  const [preflights, setPreflights] = useState<PreflightRow[]>([])
  const [results, setResults] = useState<DeploymentResult[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || !item) return
    setPhase('form')
    setSelectedIds([])
    setName(defaultDeployName(item.template.id))
    setChoice('both')
    setSelections({})
    setSecrets({})
    setResources(EMPTY_RESOURCES)
    setResourceLoading(false)
    setPreflights([])
    setResults([])
    setError('')
    setAccountError('')
  }, [open, item])

  useEffect(() => {
    if (!open || !item) return
    let cancelled = false
    setAccounts(null)
    setAccountError('')
    void accountsApi.list({ pageSize: ACCOUNT_PAGE_SIZE })
      .then((page) => {
        if (!cancelled) setAccounts(page.accounts)
      })
      .catch((failure: unknown) => {
        if (!cancelled) {
          setAccounts([])
          setAccountError(cfErrorText(failure))
        }
      })
    return () => { cancelled = true }
  }, [open, item, accountAttempt])

  const resourceSignature = useMemo(() => {
    const kinds = new Set<ResourceKind>()
    for (const binding of bindings) {
      if (binding.type === 'kv' || binding.type === 'd1' || binding.type === 'r2') kinds.add(binding.type)
    }
    return [...kinds].sort().join(',')
  }, [bindings])

  const firstAccountId = selectedIds[0] ?? ''

  useEffect(() => {
    if (!open) return
    if (!firstAccountId || !resourceSignature) {
      setResources(EMPTY_RESOURCES)
      setResourceLoading(false)
      return
    }
    let cancelled = false
    setResourceLoading(true)
    setResources((previous) => ({ ...previous, error: '' }))
    void readResources(firstAccountId, resourceSignature.split(',') as ResourceKind[])
      .then((next) => {
        if (!cancelled) setResources(next)
      })
      .catch((failure: unknown) => {
        if (!cancelled) setResources({ ...EMPTY_RESOURCES, error: cfErrorText(failure) })
      })
      .finally(() => {
        if (!cancelled) setResourceLoading(false)
      })
    return () => { cancelled = true }
  }, [open, firstAccountId, resourceSignature])

  const isMulti = selectedIds.length > 1
  useEffect(() => {
    if (isMulti) setSelections({})
  }, [isMulti])

  const accountOptions = useMemo(() => (
    (accounts ?? [])
      .filter((account) => !needsR2 || accountHasR2(account))
      .map((account) => ({
        value: account.id,
        label: account.name,
        ...(accountHasR2(account) ? { hint: 'R2' } : {}),
      }))
  ), [accounts, needsR2])

  const missingRequiredSecret = secretBindings.some((binding) => (
    binding.required === true && !(secrets[binding.name] ?? '').trim()
  ))
  // A binding must name a resource that exists: this deployment can bind, but it cannot create a
  // KV namespace or a D1 database, so an "auto" choice would deploy a name into an id slot.
  const missingBinding = bindings.some((binding) => (
    binding.type !== 'ai' && !(selections[binding.name] ?? '').trim()
  ))
  const canPreflight = Boolean(item)
    && selectedIds.length > 0
    && name.trim().length > 0
    && !missingRequiredSecret
    && !missingBinding
    && accounts !== null

  const allOk = preflights.length > 0 && preflights.every((row) => row.result?.ok === true)

  function selectedValue(binding: CatalogBinding): string {
    if (binding.type === 'ai') return 'ai:auto'
    const value = (selections[binding.name] ?? '').trim()
    return value ? `${binding.type}:${value}` : ''
  }

  function buildDeployment(accountId: string): StoreDeployment {
    const bindingSelections: Record<string, string> = {}
    for (const binding of bindings) {
      if (binding.type === 'kv' || binding.type === 'd1' || binding.type === 'r2' || binding.type === 'ai') {
        const value = selectedValue(binding)
        if (value) bindingSelections[binding.name] = value
      }
    }
    const secretValues: Record<string, string> = {}
    for (const [key, value] of Object.entries(secrets)) {
      if (value.length > 0) secretValues[key] = value
    }
    const deployType = template ? resolveDeployType(template.type, choice) : undefined
    return {
      accountId,
      templateId,
      name: name.trim(),
      bindingSelections,
      secretValues,
      ...(deployType ? { deployType } : {}),
    }
  }

  function accountName(accountId: string): string {
    return accounts?.find((account) => account.id === accountId)?.name
      ?? t('cloudflare.store_deploy.account_label', { id: accountId })
  }

  function changeAccounts(next: string[]): void {
    setSelectedIds(next)
    setSelections({})
    setPreflights([])
    setResults([])
    setError('')
    setPhase('form')
  }

  function resourceOptions(binding: CatalogBinding): ResourceOption[] {
    if (binding.type === 'kv' || binding.type === 'd1' || binding.type === 'r2') {
      return [...resources[binding.type]]
    }
    return []
  }

  async function runPreflight(): Promise<void> {
    if (!canPreflight) return
    setError('')
    setPhase('checking')
    const rows: PreflightRow[] = await Promise.all(selectedIds.map(async (accountId) => {
      const label = accountName(accountId)
      try {
        const result = await storeApi.preflight(buildDeployment(accountId))
        return { accountId, accountName: label, result }
      } catch (failure) {
        return { accountId, accountName: label, error: cfErrorText(failure) }
      }
    }))
    setPreflights(rows)
    setPhase('confirm')
    const failed = rows.filter((row) => row.result?.ok !== true)
    if (failed.length > 0) {
      const thrown = failed.find((row) => row.error)
      toast({
        title: thrown?.error
          ? t('cloudflare.store_deploy.msg.preflight_error', { error: thrown.error })
          : t('cloudflare.store_deploy.msg.preflight_failed'),
        tone: 'danger',
      })
    }
  }

  async function runDeploy(): Promise<void> {
    if (!allOk) return
    setPhase('deploying')
    setError('')
    const deployments = selectedIds.map((accountId) => buildDeployment(accountId))
    try {
      if (deployments.length === 1) {
        const result = await storeApi.deploy(deployments[0]!)
        setResults([result])
        if (result.success) {
          toast({
            title: t('cloudflare.store.deploy_success', {
              account: t('cloudflare.store.deploy_success_account', {
                name: accountName(result.accountId),
              }),
            }),
            tone: 'success',
          })
        } else {
          toast({
            title: t('cloudflare.store.deploy_failed', { error: result.error ?? '' }),
            tone: 'danger',
          })
        }
      } else {
        const batch = await storeApi.deployBatch(deployments)
        setResults(batch.results)
        if (batch.failed === 0) {
          toast({
            title: t('cloudflare.store_deploy.msg.batch_success', {
              success: batch.succeeded,
              total: batch.total,
            }),
            tone: 'success',
          })
        } else {
          toast({
            title: t('cloudflare.store_deploy.msg.batch_partial', {
              success: batch.succeeded,
              failed: batch.failed,
            }),
            tone: 'warning',
          })
        }
      }
      setPhase('results')
    } catch (failure) {
      const message = cfErrorText(failure)
      setError(message)
      setPhase('confirm')
      toast({
        title: deployments.length > 1
          ? t('cloudflare.store_deploy.msg.batch_failed', { error: message })
          : t('cloudflare.store.deploy_failed', { error: message }),
        tone: 'danger',
      })
    }
  }

  const choiceLabel = choice === 'worker'
    ? t('cloudflare.store_deploy.worker_only')
    : choice === 'pages'
      ? t('cloudflare.store_deploy.pages_only')
      : t('cloudflare.store_deploy.both')

  const footer = phase === 'results' ? (
    <Button variant="primary" onClick={onClose}>{t('common.close')}</Button>
  ) : phase === 'confirm' || phase === 'deploying' ? (
    <>
      <Button variant="ghost" onClick={onClose} disabled={phase === 'deploying'}>{t('common.cancel')}</Button>
      <Button variant="secondary" onClick={() => setPhase('form')} disabled={phase === 'deploying'}>
        {t('cloudflare.store_deploy.back_to_edit')}
      </Button>
      <Button
        variant="primary"
        disabled={phase === 'deploying' || !allOk}
        loading={phase === 'deploying'}
        onClick={() => void runDeploy()}
      >
        {t('cloudflare.store_deploy.confirm_deploy')}
      </Button>
    </>
  ) : (
    <>
      <Button variant="ghost" onClick={onClose} disabled={phase === 'checking'}>{t('common.cancel')}</Button>
      <Button
        variant="primary"
        disabled={!canPreflight || phase === 'checking'}
        loading={phase === 'checking'}
        onClick={() => void runPreflight()}
      >
        {phase === 'checking'
          ? t('cloudflare.store_deploy.preflighting')
          : t('cloudflare.store_deploy.confirm_deploy')}
      </Button>
    </>
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('cloudflare.store_deploy.title', { name: template?.name ?? '' })}
      width={640}
      footer={footer}
      dismissible={phase !== 'checking' && phase !== 'deploying'}
    >
      {!item ? null : phase === 'results' ? (
        <section aria-live="polite" className="space-y-2">
          <h3 className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">
            {t('cloudflare.store_deploy.deploy_results')}
          </h3>
          {results.map((row, index) => (
            <div
              key={`${row.accountId}-${index}`}
              className="space-y-1 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2.5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={row.success ? 'success' : 'danger'}>
                  {row.success
                    ? t('cloudflare.store_deploy.success')
                    : t('cloudflare.store_deploy.failed')}
                </Badge>
                <span className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">
                  {accountName(row.accountId)}
                </span>
              </div>
              {row.error ? (
                <p role="alert" className="text-[length:var(--text-11-5)] text-[var(--danger)]">
                  {row.error}
                </p>
              ) : null}
              {row.url ? (
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href={row.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[length:var(--text-11-5)] text-[var(--accent)] underline"
                  >
                    <ExternalLink size={12} aria-hidden="true" />
                    {t('cloudflare.store.open_url')}
                  </a>
                  <span className="min-w-0 truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                    {row.url}
                  </span>
                </div>
              ) : null}
            </div>
          ))}
        </section>
      ) : (
        <div className="space-y-4">
          {phase === 'form' || phase === 'checking' ? (
            <>
              <Field
                label={t('cloudflare.store_deploy.target_account')}
                required
                hint={needsR2 ? t('cloudflare.store_deploy.r2_hint') : undefined}
              >
                <MultiSelect
                  label={t('cloudflare.store_deploy.target_account')}
                  value={selectedIds}
                  options={accountOptions}
                  onChange={changeAccounts}
                  placeholder={t('cloudflare.store_deploy.target_account_placeholder')}
                  disabled={phase === 'checking' || accounts === null}
                />
              </Field>
              {accounts === null ? (
                <p role="status" className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                  {t('common.loading')}
                </p>
              ) : null}
              {accountError ? (
                <div
                  role="alert"
                  className="flex items-start justify-between gap-2 rounded-[var(--r-md)] border border-[var(--danger)]/45 px-2.5 py-2"
                >
                  <span className="min-w-0 break-words text-[length:var(--text-11-5)] text-[var(--danger)]">
                    {accountError}
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => setAccountAttempt((value) => value + 1)}>
                    {t('common.retry')}
                  </Button>
                </div>
              ) : null}
              {isMulti ? (
                <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                  {t('cloudflare.store_deploy.multi_account_hint')}
                </p>
              ) : null}

              <Field label={t('cloudflare.store_deploy.name')} required>
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t('cloudflare.store_deploy.name_placeholder')}
                  disabled={phase === 'checking'}
                  autoComplete="off"
                />
              </Field>

              {isHybrid ? (
                <Field label={t('cloudflare.store_deploy.deploy_method')} required>
                  <Segmented
                    label={t('cloudflare.store_deploy.deploy_method')}
                    value={choice}
                    onChange={setChoice}
                    disabled={phase === 'checking'}
                    options={[
                      { value: 'both', label: t('cloudflare.store_deploy.both') },
                      { value: 'worker', label: t('cloudflare.store_deploy.worker_only') },
                      { value: 'pages', label: t('cloudflare.store_deploy.pages_only') },
                    ]}
                  />
                </Field>
              ) : null}

              {selectableBindings.length > 0 ? (
                <section className="space-y-2">
                  <h3 className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">
                    {t('cloudflare.store_deploy.bindings')}
                  </h3>
                  {selectableBindings.map((binding) => (
                    <Field key={binding.name} label={`${binding.name} (${binding.type})`}>
                      {binding.type === 'ai' ? (
                        <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                          {t('cloudflare.store_deploy.auto_create', {
                            name: autoResourceName(templateId, binding.name),
                          })}
                        </p>
                      ) : (
                        <div>
                          <SelectResource
                            binding={binding}
                            value={selections[binding.name] ?? ''}
                            options={resourceOptions(binding)}
                            disabled={isMulti || phase === 'checking'}
                            onChange={(value) => setSelections((previous) => ({
                              ...previous,
                              [binding.name]: value,
                            }))}
                          />
                        </div>
                      )}
                    </Field>
                  ))}
                  {resourceLoading ? (
                    <p role="status" className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                      {t('common.loading')}
                    </p>
                  ) : null}
                  {resources.error ? (
                    <p role="alert" className="text-[length:var(--text-11-5)] text-[var(--danger)]">
                      {resources.error}
                    </p>
                  ) : null}
                </section>
              ) : null}

              {secretBindings.length > 0 ? (
                <section className="space-y-2">
                  <h3 className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">
                    {t('cloudflare.store_deploy.secrets')}
                  </h3>
                  {secretBindings.map((binding) => (
                    <Field
                      key={binding.name}
                      label={binding.title ? `${binding.title} (${binding.name})` : binding.name}
                      required={binding.required === true}
                    >
                      <Input
                        type="password"
                        value={secrets[binding.name] ?? ''}
                        onChange={(event) => setSecrets((previous) => ({
                          ...previous,
                          [binding.name]: event.target.value,
                        }))}
                        placeholder={t('cloudflare.store_deploy.secret_placeholder', {
                          name: binding.title || binding.name,
                        })}
                        disabled={phase === 'checking'}
                        autoComplete="new-password"
                      />
                    </Field>
                  ))}
                </section>
              ) : null}
            </>
          ) : (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3 text-[length:var(--text-12)]">
                <dt className="text-[var(--text-tertiary)]">{t('cloudflare.store_deploy.target_account')}</dt>
                <dd className="min-w-0 break-words text-[var(--text-primary)]">
                  {selectedIds.map(accountName).join(', ')}
                </dd>
                <dt className="text-[var(--text-tertiary)]">{t('cloudflare.store_deploy.name')}</dt>
                <dd className="min-w-0 break-all font-mono text-[var(--text-primary)]">{name.trim()}</dd>
                {isHybrid ? (
                  <>
                    <dt className="text-[var(--text-tertiary)]">{t('cloudflare.store_deploy.deploy_method')}</dt>
                    <dd className="text-[var(--text-primary)]">{choiceLabel}</dd>
                  </>
                ) : null}
              </dl>

              <section aria-live="polite" className="space-y-2">
                <h3 className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">
                  {t('cloudflare.store_deploy.preflight_result')}
                </h3>
                {preflights.map((row) => {
                  const ok = row.result?.ok === true
                  return (
                    <div
                      key={row.accountId}
                      className="space-y-1 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2.5"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={ok ? 'success' : 'danger'}>
                          {ok
                            ? t('cloudflare.store_deploy.success')
                            : t('cloudflare.store_deploy.failed')}
                        </Badge>
                        <span className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">
                          {row.accountName}
                        </span>
                        {row.result ? (
                          <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                            {row.result.deployType}
                          </span>
                        ) : null}
                      </div>
                      {row.error ? (
                        <p role="alert" className="text-[length:var(--text-11-5)] text-[var(--danger)]">
                          {row.error}
                        </p>
                      ) : null}
                      {row.result?.sourceError ? (
                        <p className="text-[length:var(--text-11-5)] text-[var(--danger)]">
                          {row.result.sourceError}
                        </p>
                      ) : null}
                      {row.result?.warning ? (
                        <p className="text-[length:var(--text-11-5)] text-[var(--warning)]">
                          {row.result.warning}
                        </p>
                      ) : null}
                    </div>
                  )
                })}
              </section>
            </>
          )}

          {error ? (
            <p role="alert" className="text-[length:var(--text-11-5)] text-[var(--danger)]">{error}</p>
          ) : null}
        </div>
      )}
    </Modal>
  )
}

function SelectResource({
  binding,
  value,
  options,
  disabled,
  onChange,
}: {
  binding: CatalogBinding
  value: string
  options: ResourceOption[]
  disabled: boolean
  onChange: (value: string) => void
}) {
  const t = useCfT()
  const selected = options.find((option) => option.value === value)?.value ?? ''
  return (
    <SelectMenu
      label={`${binding.name} (${binding.type})`}
      value={selected}
      options={options}
      onChange={onChange}
      disabled={disabled}
      placeholder={t('cloudflare.store_deploy.select_resource')}
      size="sm"
    />
  )
}
