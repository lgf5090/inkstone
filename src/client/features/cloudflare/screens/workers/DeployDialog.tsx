/**
 * Deploying a Worker or a Pages project, to one account or several.
 *
 * A redeploy starts from the deployed configuration: variables, bindings and (for a Worker) the
 * current source are loaded first, so an empty field means "keep what is running" rather than
 * "delete it". A batch keeps each account's outcome separately and lets a failed one be retried
 * without re-sending the successful ones.
 */
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { hasFeature, type CloudflareAccount } from '@shared/cloudflare/model'
import { Field, Input, Segmented } from '../../../../components/form'
import { Modal } from '../../../../components/overlay'
import { Badge, Button } from '../../../../components/primitives'
import { MultiSelect } from '../../components/MultiSelect'
import { CodeEditor } from '../../components/CodeEditor'
import { useUi } from '../../../../store/ui'
import { t as uiT } from '../../../../lib/i18n'
import { cfErrorText } from '../../api/client'
import {
  workersApi,
  type DeployBindingInput,
  type DeployResultRow,
  type DeployVarInput,
  type PagesProject,
  type WorkerKind,
} from '../../api/workers'
import { useCfT } from '../../i18n'
import { DeployAdvancedTab } from './DeployAdvancedTab'
import { DeployEnvVarsTab } from './DeployEnvVarsTab'
import { DeployResourceTab } from './DeployResourceTab'

type DeploySource = 'file' | 'url' | 'editor'
type DeployTab = 'vars' | 'kv' | 'd1' | 'r2' | 'advanced'

interface ResultRow extends DeployResultRow {
  accountName?: string
  retrying?: boolean
}

function hasR2(account: CloudflareAccount | undefined): boolean {
  if (!account) return false
  const features = (account.available_features || '').split(',').filter(Boolean)
  return features.includes('r2') && !features.includes('-r2')
}

function pagesVars(project: PagesProject): DeployVarInput[] {
  const envVars = project.deployment_configs?.production?.env_vars ?? {}
  return Object.entries(envVars).map(([name, value]) => ({
    name,
    value: value?.type === 'plain_text' ? value.value ?? '' : '',
    secret: value?.type === 'secret_text',
    keep: value?.type === 'secret_text',
  }))
}

function pagesBindings(project: PagesProject): DeployBindingInput[] {
  const production = project.deployment_configs?.production ?? {}
  const rows: DeployBindingInput[] = []
  for (const [name, value] of Object.entries(production.kv_namespaces ?? {})) {
    rows.push({ type: 'kv', name, mode: 'existing', existingId: value?.namespace_id ?? '' })
  }
  for (const [name, value] of Object.entries(production.d1_databases ?? {})) {
    rows.push({ type: 'd1', name, mode: 'existing', existingId: value?.id ?? '' })
  }
  for (const [name, value] of Object.entries(production.r2_buckets ?? {})) {
    rows.push({ type: 'r2', name, mode: 'existing', existingId: value?.name ?? '' })
  }
  for (const name of Object.keys(production.ai ?? {})) {
    rows.push({ type: 'ai', name })
  }
  return rows
}

export function DeployDialog({
  open,
  onClose,
  redeploy,
  accounts,
  onDeployed,
}: {
  open: boolean
  onClose: () => void
  redeploy: { type: WorkerKind; name: string; accountId: string } | null
  accounts: CloudflareAccount[]
  onDeployed: () => void
}) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const isRedeploy = Boolean(redeploy)
  const [deployType, setDeployType] = useState<WorkerKind>('worker')
  const [targetIds, setTargetIds] = useState<string[]>([])
  const [name, setName] = useState('')
  const [source, setSource] = useState<DeploySource>('file')
  const [scriptFile, setScriptFile] = useState<File | null>(null)
  const [fileKey, setFileKey] = useState(0)
  const [scriptUrl, setScriptUrl] = useState('')
  const [scriptCode, setScriptCode] = useState('')
  const [editorLoaded, setEditorLoaded] = useState(false)
  const [editorLoading, setEditorLoading] = useState(false)
  const [tab, setTab] = useState<DeployTab>('vars')
  const [vars, setVars] = useState<DeployVarInput[]>([])
  const [kvRows, setKvRows] = useState<DeployBindingInput[]>([])
  const [d1Rows, setD1Rows] = useState<DeployBindingInput[]>([])
  const [r2Rows, setR2Rows] = useState<DeployBindingInput[]>([])
  const [advancedRows, setAdvancedRows] = useState<DeployBindingInput[]>([])
  const [aiEnabled, setAiEnabled] = useState(false)
  const [deploying, setDeploying] = useState(false)
  const [results, setResults] = useState<ResultRow[]>([])
  const editorRequested = useRef(false)

  const accountOptions = useMemo(() => accounts
    .filter((account) => account.is_active === 1 && hasFeature(account.enabled_features, 'workers'))
    .map((account) => ({ value: account.id, label: account.name })), [accounts])

  const selectedAccounts = useMemo(
    () => accounts.filter((account) => targetIds.includes(account.id)),
    [accounts, targetIds],
  )
  const missingR2 = selectedAccounts.filter((account) => !hasR2(account)).length
  const showR2 = selectedAccounts.length > 0 && missingR2 === 0

  const allBindings = useMemo(() => {
    const rows = [...kvRows, ...d1Rows, ...(showR2 ? r2Rows : []), ...advancedRows]
    return aiEnabled ? [...rows, { type: 'ai', name: 'AI' } as DeployBindingInput] : rows
  }, [kvRows, d1Rows, r2Rows, advancedRows, aiEnabled, showR2])

  const validName = /^[a-z0-9-]{1,63}$/.test(name.trim())
  const hasSource = Boolean(scriptFile)
    || (source === 'url' && Boolean(scriptUrl.trim()))
    || (source === 'editor' && Boolean(scriptCode.trim()))
  const canDeploy = targetIds.length > 0
    && validName
    && (deployType === 'pages' ? Boolean(scriptFile) : hasSource || isRedeploy)

  async function loadRedeployConfig(): Promise<void> {
    if (!redeploy) return
    try {
      if (redeploy.type === 'pages') {
        const project = await workersApi.getPagesConfig(redeploy.accountId, redeploy.name)
        setVars(pagesVars(project))
        const bindings = pagesBindings(project)
        setKvRows(bindings.filter((binding) => binding.type === 'kv'))
        setD1Rows(bindings.filter((binding) => binding.type === 'd1'))
        setR2Rows(bindings.filter((binding) => binding.type === 'r2'))
        setAiEnabled(bindings.some((binding) => binding.type === 'ai'))
      } else {
        const config = await workersApi.getWorkerConfig(redeploy.accountId, redeploy.name)
        setVars(config.vars.map((variable) => ({
          name: variable.name,
          value: variable.value,
          secret: variable.secret,
          keep: variable.secret && !variable.value,
        })))
        setKvRows(config.bindings.filter((binding) => binding.type === 'kv'))
        setD1Rows(config.bindings.filter((binding) => binding.type === 'd1'))
        setR2Rows(config.bindings.filter((binding) => binding.type === 'r2'))
        setAdvancedRows(config.bindings.filter((binding) => ['durable_object', 'service', 'queue'].includes(binding.type)))
        setAiEnabled(config.bindings.some((binding) => binding.type === 'ai'))
      }
    } catch (error) {
      toast({
        title: t('cloudflare.workers.deploy_dialog.config_read_failed', { error: cfErrorText(error) }),
        tone: 'warning',
      })
    }
  }

  async function loadEditorSource(): Promise<void> {
    if (!redeploy || redeploy.type !== 'worker') return
    setEditorLoading(true)
    try {
      const content = await workersApi.getContent(redeploy.accountId, redeploy.name)
      setScriptCode(content)
      setEditorLoaded(true)
      toast({ title: t('cloudflare.workers.deploy_dialog.editor_loaded'), tone: 'success' })
    } catch (error) {
      toast({
        title: t('cloudflare.workers.deploy_dialog.editor_load_failed', { error: cfErrorText(error) }),
        tone: 'danger',
      })
    } finally {
      setEditorLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    setDeployType(redeploy?.type ?? 'worker')
    setTargetIds(redeploy ? [redeploy.accountId] : [])
    setName(redeploy?.name ?? '')
    setSource('file')
    setScriptFile(null)
    setFileKey((value) => value + 1)
    setScriptUrl('')
    setScriptCode('')
    setEditorLoaded(false)
    setEditorLoading(false)
    editorRequested.current = false
    setTab('vars')
    setVars([])
    setKvRows([])
    setD1Rows([])
    setR2Rows([])
    setAdvancedRows([])
    setAiEnabled(false)
    setResults([])
    setDeploying(false)
    void loadRedeployConfig()
    // loadRedeployConfig reads the same redeploy values; the effect is keyed on opening it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, redeploy?.accountId, redeploy?.name, redeploy?.type])

  useEffect(() => {
    if (deployType === 'pages' && source !== 'file') setSource('file')
    if (deployType === 'pages' && advancedRows.length > 0) setAdvancedRows([])
  }, [deployType, source, advancedRows.length])

  useEffect(() => {
    if (!open || source !== 'editor' || deployType !== 'worker' || !isRedeploy) return
    if (editorRequested.current) return
    editorRequested.current = true
    void loadEditorSource()
    // Loading is intentionally once per dialog opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source, deployType, isRedeploy])

  function currentOptions(): {
    script?: File
    url?: string
    mainModule?: string
    vars: DeployVarInput[]
    bindings: DeployBindingInput[]
    isRedeploy: boolean
  } {
    const workerFile = source === 'editor' && scriptCode.trim()
      ? new File([scriptCode], `${name.trim() || 'worker'}.js`, { type: 'text/javascript' })
      : scriptFile ?? undefined
    return {
      script: deployType === 'worker' ? workerFile : undefined,
      url: deployType === 'worker' && source === 'url' ? scriptUrl.trim() : undefined,
      vars,
      bindings: allBindings,
      isRedeploy,
    }
  }

  async function deploy(): Promise<void> {
    if (!validName) {
      toast({ title: t('cloudflare.workers.msg.deploy_name_required'), tone: 'warning' })
      return
    }
    if (targetIds.length === 0) {
      toast({ title: t('cloudflare.workers.msg.info_required'), tone: 'warning' })
      return
    }
    if (deployType === 'worker' && !hasSource && !isRedeploy) {
      toast({
        title: source === 'url'
          ? t('cloudflare.workers.msg.js_url_required')
          : t('cloudflare.workers.msg.script_file_required'),
        tone: 'warning',
      })
      return
    }
    if (deployType === 'pages' && !scriptFile) {
      toast({ title: t('cloudflare.workers.msg.zip_file_required'), tone: 'warning' })
      return
    }

    const targets = targetIds.map((accountId) => ({ accountId, workerName: name.trim() }))
    setDeploying(true)
    setResults([])
    try {
      const options = currentOptions()
      const answer = deployType === 'worker'
        ? await workersApi.batchDeploy(targets, options)
        : await workersApi.batchDeployPages(targets, {
          zipFile: scriptFile ?? undefined,
          vars,
          bindings: allBindings,
        })
      const mapped: ResultRow[] = answer.results.map((row) => ({
        ...row,
        accountName: accounts.find((account) => account.id === row.accountId)?.name,
      }))
      setResults(mapped)
      if (answer.succeeded === answer.total && answer.total > 0) {
        toast({
          title: t('cloudflare.workers.deploy_dialog.all_success', {
            success: answer.succeeded,
            total: answer.total,
          }),
          tone: 'success',
        })
        onDeployed()
        onClose()
      } else {
        toast({
          title: t('cloudflare.workers.deploy_dialog.partial_fail', {
            success: answer.succeeded,
            failed: answer.failed,
          }),
          tone: 'warning',
        })
      }
    } catch (error) {
      toast({
        title: t('cloudflare.workers.deploy_dialog.deploy_failed', { error: cfErrorText(error) }),
        tone: 'danger',
      })
    } finally {
      setDeploying(false)
    }
  }

  async function retry(row: ResultRow): Promise<void> {
    setResults((current) => current.map((item) => (
      item.accountId === row.accountId ? { ...item, retrying: true } : item
    )))
    try {
      const options = currentOptions()
      const targets = [{ accountId: row.accountId, workerName: name.trim() }]
      const answer = deployType === 'worker'
        ? await workersApi.batchDeploy(targets, options)
        : await workersApi.batchDeployPages(targets, {
          zipFile: scriptFile ?? undefined,
          vars,
          bindings: allBindings,
        })
      const next = answer.results[0]
      setResults((current) => current.map((item) => (
        item.accountId === row.accountId
          ? { ...item, success: next?.success === true, error: next?.error, retrying: false }
          : item
      )))
      if (next?.success) {
        toast({
          title: t('cloudflare.workers.deploy_dialog.retry_success', {
            name: row.accountName
              ?? t('cloudflare.workers.deploy_dialog.account_fallback', { id: row.accountId }),
          }),
          tone: 'success',
        })
        onDeployed()
      } else {
        toast({
          title: t('cloudflare.workers.deploy_dialog.retry_failed'),
          description: next?.error,
          tone: 'danger',
        })
      }
    } catch (error) {
      setResults((current) => current.map((item) => (
        item.accountId === row.accountId
          ? { ...item, error: cfErrorText(error), retrying: false }
          : item
      )))
      toast({ title: t('cloudflare.workers.deploy_dialog.retry_failed'), tone: 'danger' })
    }
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>): void {
    setScriptFile(event.target.files?.[0] ?? null)
  }

  const tabOptions: Array<{ value: DeployTab; label: string }> = [
    { value: 'vars', label: t('cloudflare.workers.deploy_dialog.tab_vars') },
    { value: 'kv', label: t('cloudflare.workers.deploy_dialog.tab_kv') },
    { value: 'd1', label: t('cloudflare.workers.deploy_dialog.tab_d1') },
    ...(showR2 ? [{ value: 'r2' as const, label: t('cloudflare.workers.deploy_dialog.tab_r2') }] : []),
    { value: 'advanced', label: t('cloudflare.workers.deploy_dialog.tab_advanced') },
  ]

  const accept = deployType === 'pages' ? '.zip' : '.js,.mjs,.zip'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isRedeploy
        ? t('cloudflare.workers.deploy_dialog.redeploy_title', { name: redeploy?.name ?? '' })
        : t('cloudflare.workers.deploy_dialog.title')}
      width={900}
      dismissible={!deploying}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={deploying}>
            {t('cloudflare.workers.deploy_dialog.close_btn')}
          </Button>
          <Button variant="primary" loading={deploying} disabled={!canDeploy} onClick={() => void deploy()}>
            {deploying
              ? t('cloudflare.workers.deploy_dialog.deploying')
              : t('cloudflare.workers.deploy_dialog.deploy_btn')}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={t('cloudflare.workers.deploy_dialog.deploy_type_label')}>
            <Segmented<WorkerKind>
              value={deployType}
              options={[
                { value: 'worker', label: t('cloudflare.workers.worker') },
                { value: 'pages', label: t('cloudflare.workers.pages') },
              ]}
              onChange={setDeployType}
              disabled={isRedeploy}
              label={t('cloudflare.workers.deploy_dialog.deploy_type_label')}
            />
          </Field>
          <Field label={t('cloudflare.workers.deploy_dialog.target_accounts')}>
            <MultiSelect
              label={t('cloudflare.workers.deploy_dialog.target_accounts')}
              value={targetIds}
              options={accountOptions}
              onChange={setTargetIds}
              placeholder={t('cloudflare.workers.deploy_dialog.target_accounts_placeholder')}
              disabled={isRedeploy}
            />
          </Field>
        </div>
        {missingR2 > 0 && (
          <p role="status" className="text-[length:var(--text-11-5)] text-[var(--warning)]">
            {t('cloudflare.workers.deploy_dialog.r2_mixed_hint', { count: missingR2 })}
          </p>
        )}
        <Field label={t('cloudflare.workers.deploy_dialog.name_label')} required>
          <Input
            value={name}
            disabled={isRedeploy}
            placeholder={deployType === 'pages'
              ? t('cloudflare.workers.deploy_dialog.pages_name_placeholder')
              : t('cloudflare.workers.deploy_dialog.worker_name_placeholder')}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <div className="space-y-2">
          {deployType === 'worker' && (
            <Segmented<DeploySource>
              value={source}
              options={[
                { value: 'file', label: t('cloudflare.workers.deploy_dialog.file_option') },
                { value: 'url', label: t('cloudflare.workers.script_url') },
                { value: 'editor', label: t('cloudflare.workers.deploy_dialog.editor_option') },
              ]}
              onChange={setSource}
              label={t('cloudflare.workers.deploy_dialog.code_source_label')}
            />
          )}
          {(deployType === 'pages' || source === 'file') && (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                key={fileKey}
                type="file"
                accept={accept}
                aria-label={deployType === 'pages'
                  ? t('cloudflare.workers.select_zip_file')
                  : t('cloudflare.workers.select_js_zip')}
                className="w-72 cursor-pointer"
                onChange={onFileChange}
              />
              {scriptFile && (
                <span className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{scriptFile.name}</span>
              )}
              {isRedeploy && !scriptFile && deployType === 'worker' && (
                <span className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                  {t('cloudflare.workers.deploy_dialog.change_code')}
                </span>
              )}
            </div>
          )}
          {deployType === 'worker' && source === 'url' && (
            <Input
              value={scriptUrl}
              aria-label={t('cloudflare.workers.script_url')}
              placeholder="https://example.com/worker.js"
              onChange={(event) => setScriptUrl(event.target.value)}
            />
          )}
          {deployType === 'worker' && source === 'editor' && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                  {t('cloudflare.workers.deploy_dialog.editor_hint')}
                </p>
                <div className="flex gap-2">
                  {isRedeploy && (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={editorLoading}
                      onClick={() => void loadEditorSource()}
                    >
                      {uiT('common.refresh')}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!scriptCode}
                    onClick={() => {
                      setScriptCode('')
                      setEditorLoaded(false)
                    }}
                  >
                    {t('cloudflare.workers.deploy_dialog.editor_clear')}
                  </Button>
                </div>
              </div>
              {editorLoaded && (
                <p className="text-[length:var(--text-11)] text-[var(--success)]">
                  {t('cloudflare.workers.deploy_dialog.editor_loaded')}
                </p>
              )}
              <CodeEditor
                value={scriptCode}
                onChange={setScriptCode}
                minHeight={280}
                ariaLabel={t('cloudflare.workers.deploy_dialog.editor_option')}
              />
            </div>
          )}
        </div>

        <Segmented<DeployTab>
          value={tab}
          options={tabOptions}
          onChange={setTab}
          label={t('common.tabs')}
        />
        {tab === 'vars' && <DeployEnvVarsTab value={vars} onChange={setVars} />}
        {tab === 'kv' && (
          <DeployResourceTab value={kvRows} onChange={setKvRows} resourceType="kv" accountIds={targetIds} />
        )}
        {tab === 'd1' && (
          <DeployResourceTab value={d1Rows} onChange={setD1Rows} resourceType="d1" accountIds={targetIds} />
        )}
        {tab === 'r2' && showR2 && (
          <DeployResourceTab value={r2Rows} onChange={setR2Rows} resourceType="r2" accountIds={targetIds} />
        )}
        {tab === 'advanced' && (
          <DeployAdvancedTab
            value={advancedRows}
            onChange={setAdvancedRows}
            isPages={deployType === 'pages'}
            aiEnabled={aiEnabled}
            onAiEnabledChange={setAiEnabled}
          />
        )}

        {results.length > 0 && (
          <div className="space-y-2 border-t border-[var(--border-subtle)] pt-3">
            <p className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
              {t('cloudflare.workers.deploy_dialog.result_title')}
            </p>
            {results.map((row) => (
              <div key={`result-${row.accountId}`} className="flex flex-wrap items-center gap-2">
                <Badge tone={row.success ? 'success' : 'danger'}>
                  {row.success
                    ? t('cloudflare.workers.deploy_dialog.success_tag')
                    : t('cloudflare.workers.deploy_dialog.fail_tag')}
                </Badge>
                <span className="text-[length:var(--text-12-5)] text-[var(--text-secondary)]">
                  {row.accountName
                    ?? t('cloudflare.workers.deploy_dialog.account_fallback', { id: row.accountId })}
                </span>
                {!row.success && row.error && (
                  <span className="min-w-0 flex-1 truncate text-[length:var(--text-11-5)] text-[var(--danger)]">
                    {row.error}
                  </span>
                )}
                {!row.success && (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={row.retrying}
                    onClick={() => void retry(row)}
                  >
                    {t('cloudflare.workers.deploy_dialog.retry')}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
