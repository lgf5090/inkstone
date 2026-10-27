/**
 * Workers and Pages: account cards, one merged table, and the drawers behind a row.
 *
 * The data comes from two calls because they answer different questions: the list is Workers and
 * Pages per account, the summary is today's requests and error counts. Both are joined by account id
 * in the table, so a failed usage query leaves the list readable instead of blanking it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { hasFeature, type CloudflareAccount } from '@shared/cloudflare/model'
import { Empty } from '../../../components/feedback'
import { confirm } from '../../../components/overlay'
import { Button } from '../../../components/primitives'
import { SelectMenu } from '../../../components/select-menu'
import { t as uiT } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { accountsApi } from '../api/accounts'
import { cfErrorText } from '../api/client'
import { workersApi, type WorkerRow, type WorkerSummary } from '../api/workers'
import { SearchField } from '../components/SearchField'
import { useCfT } from '../i18n'
import { percentOf } from '../lib/format'
import { useSort } from '../lib/sort'
import { BatchDeployDialog } from './workers/BatchDeployDialog'
import { DeployDialog } from './workers/DeployDialog'
import { LogsDrawer } from './workers/LogsDrawer'
import { PagesSettingsDrawer } from './workers/PagesSettingsDrawer'
import { WorkerSettingsDrawer } from './workers/WorkerSettingsDrawer'
import { WorkerTable, formatCpuTime } from './workers/WorkerTable'

const FREE_DAILY_REQUESTS = 100_000

export function WorkersScreen() {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const sorter = useSort<WorkerRow>()
  const [rows, setRows] = useState<WorkerRow[]>([])
  const [summary, setSummary] = useState<WorkerSummary[]>([])
  const [accounts, setAccounts] = useState<CloudflareAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [accountFilter, setAccountFilter] = useState('all')
  const [deployOpen, setDeployOpen] = useState(false)
  const [redeploy, setRedeploy] = useState<{ type: WorkerRow['type']; name: string; accountId: string } | null>(null)
  const [settings, setSettings] = useState<WorkerRow | null>(null)
  const [logs, setLogs] = useState<WorkerRow | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      setRows(await workersApi.list())
    } catch (reason) {
      setError(cfErrorText(reason))
    } finally {
      setLoading(false)
    }
    void workersApi.summary()
      .then(setSummary)
      .catch((reason: unknown) => {
        toast({
          title: t('common.action_failed'),
          description: cfErrorText(reason),
          tone: 'warning',
        })
      })
    void accountsApi.list({ pageSize: 100 })
      .then((page) => setAccounts(page.accounts))
      .catch((reason: unknown) => {
        console.warn('[inkstone] Cloudflare account list failed:', reason)
      })
  }, [t, toast])

  useEffect(() => {
    void load()
  }, [load])

  const summaryById = useMemo(
    () => new Map(summary.map((row) => [row.accountId, row])),
    [summary],
  )
  const accountById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts],
  )
  const deployableAccounts = useMemo(
    () => accounts.filter((account) => account.is_active === 1 && hasFeature(account.enabled_features, 'workers')),
    [accounts],
  )

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return rows.filter((row) => (
      (accountFilter === 'all' || row.accountId === accountFilter)
      && (!needle
        || row.name.toLowerCase().includes(needle)
        || row.accountName.toLowerCase().includes(needle))
    ))
  }, [rows, query, accountFilter])

  const sorted = useMemo(() => sorter.sorted(filtered, (row) => {
    const usage = summaryById.get(row.accountId)
    switch (sorter.state.key) {
      case 'type': return row.type
      case 'name': return row.name
      case 'account': return row.accountName
      case 'status': return row.status
      case 'modified': return row.modifiedOn ? Date.parse(row.modifiedOn) : null
      case 'deployments': return usage ? usage.workerCount + usage.pagesCount : null
      case 'requests': return usage?.requests ?? null
      case 'errors': return usage?.errors ?? null
      case 'cpu': return usage?.cpuTimeMs ?? null
      default: return row.name
    }
  }), [filtered, sorter.sorted, sorter.state.key, summaryById])

  const workerCount = filtered.filter((row) => row.type === 'worker').length
  const pagesCount = filtered.filter((row) => row.type === 'pages').length
  const selectedAccountName = accountFilter === 'all'
    ? ''
    : summaryById.get(accountFilter)?.accountName ?? ''

  function isDemo(accountId: string): boolean {
    return accountById.get(accountId)?.is_demo === true
  }

  function openDeploy(row: WorkerRow): void {
    setRedeploy({ type: row.type, name: row.name, accountId: row.accountId })
    setDeployOpen(true)
  }

  function openBatchDeploy(): void {
    setRedeploy(null)
    setDeployOpen(true)
  }

  function closeDeploy(): void {
    setDeployOpen(false)
    setRedeploy(null)
  }

  async function deleteRow(row: WorkerRow): Promise<void> {
    const ok = await confirm({
      title: uiT('common.delete'),
      description: t('cloudflare.workers.table.delete_confirm', {
        type: row.type === 'pages' ? t('cloudflare.workers.pages') : t('cloudflare.workers.worker'),
        name: row.name,
      }),
      confirmLabel: uiT('common.delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      if (row.type === 'pages') await workersApi.removePages(row.accountId, row.name)
      else await workersApi.remove(row.accountId, row.name)
      toast({
        title: row.type === 'pages'
          ? t('cloudflare.workers.msg.pages_deleted')
          : t('cloudflare.workers.msg.worker_deleted'),
        tone: 'success',
      })
      await load()
    } catch (reason) {
      toast({
        title: uiT('common.delete_failed'),
        description: cfErrorText(reason),
        tone: 'danger',
      })
    }
  }

  const accountFilterOptions = [
    { value: 'all', label: t('cloudflare.accounts.filter_all') },
    ...summary.map((row) => ({ value: row.accountId, label: row.accountName })),
  ]

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
        <h1 className="text-[length:var(--text-16)] font-semibold tracking-[-0.012em] text-[var(--text-primary)]">
          {t('cloudflare.workers.title')}
        </h1>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon={<RefreshCw size={14} />}
            loading={loading}
            onClick={() => void load()}
          >
            {uiT('common.refresh')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={deployableAccounts.length === 0}
            onClick={openBatchDeploy}
          >
            {t('cloudflare.workers.batch_deploy')}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label={t('cloudflare.workers.title')}>
          {summary.map((card) => {
            const pct = percentOf(card.requests, FREE_DAILY_REQUESTS)
            const selected = accountFilter === card.accountId
            return (
              <button
                key={card.accountId}
                type="button"
                aria-pressed={selected}
                onClick={() => setAccountFilter(selected ? 'all' : card.accountId)}
                className={`flex min-w-52 shrink-0 flex-col gap-1 rounded-[var(--r-md)] border p-2.5 text-left transition-colors ${
                  selected
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                    : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                <span className="truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">
                  {card.accountName}
                </span>
                <span className="flex items-center justify-between gap-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                  <span>{card.workerCount} {t('cloudflare.workers.worker')} · {card.pagesCount} {t('cloudflare.workers.pages')}</span>
                  <span className="tabular">
                    {card.requests.toLocaleString()} / {FREE_DAILY_REQUESTS.toLocaleString()}
                  </span>
                </span>
                <span
                  role="progressbar"
                  aria-label={t('cloudflare.workers.table.requests')}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={pct}
                  className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-sunken)]"
                >
                  <span
                    className="block h-full rounded-full"
                    style={{
                      width: `${pct}%`,
                      backgroundColor: pct > 90 ? 'var(--danger)' : pct > 70 ? 'var(--warning)' : 'var(--success)',
                    }}
                  />
                </span>
                <span className="flex items-center justify-between gap-2 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                  <span>{t('cloudflare.workers.table.errors')} {card.errors.toLocaleString()}</span>
                  <span>{t('cloudflare.workers.table.cpu_time')} {formatCpuTime(card.cpuTimeMs)}</span>
                </span>
              </button>
            )
          })}
          {summary.length === 0 && !loading && (
            <p className="py-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {t('cloudflare.workers.no_accounts')}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            value={query}
            onChange={setQuery}
            label={t('cloudflare.accounts.search_placeholder')}
            placeholder={t('cloudflare.accounts.search_placeholder')}
            className="w-64"
          />
          <div className="w-52">
            <SelectMenu
              label={t('cloudflare.workers.account')}
              value={accountFilter}
              options={accountFilterOptions}
              onChange={setAccountFilter}
              width={240}
            />
          </div>
        </div>

        {error && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--r-sm)] bg-[var(--bg-sunken)] p-2 text-[length:var(--text-12)] text-[var(--danger)]">
            <span>{error}</span>
            <Button size="sm" variant="secondary" onClick={() => void load()}>
              {uiT('common.retry')}
            </Button>
          </div>
        )}

        {!loading && !error && filtered.length === 0 ? (
          <Empty title={t('share.no_data_yet')} />
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <WorkerTable
              rows={sorted}
              summary={summaryById}
              loading={loading}
              sort={sorter.state}
              onToggleSort={sorter.toggle}
              onDeploy={openDeploy}
              onSettings={setSettings}
              onLogs={setLogs}
              onDelete={(row) => void deleteRow(row)}
              isDemo={isDemo}
            />
          </div>
        )}

        <div className="flex min-h-9 flex-wrap items-center gap-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          <span>{t('cloudflare.workers.total_deployments', { count: filtered.length })}</span>
          <span>{t('cloudflare.workers.worker')} {workerCount}</span>
          <span>{t('cloudflare.workers.pages')} {pagesCount}</span>
          {selectedAccountName && (
            <span>{t('cloudflare.workers.current_account', { name: selectedAccountName })}</span>
          )}
        </div>
      </div>

      {redeploy ? (
        <DeployDialog
          open={deployOpen}
          redeploy={redeploy}
          accounts={deployableAccounts}
          onClose={closeDeploy}
          onDeployed={() => void load()}
        />
      ) : (
        <BatchDeployDialog
          open={deployOpen}
          accounts={deployableAccounts}
          onClose={closeDeploy}
          onDeployed={() => void load()}
        />
      )}

      {logs && (
        <LogsDrawer
          open
          accountId={logs.accountId}
          name={logs.name}
          onClose={() => setLogs(null)}
        />
      )}

      {settings && settings.type === 'worker' && (
        <WorkerSettingsDrawer
          key={`worker-${settings.accountId}-${settings.name}`}
          open
          accountId={settings.accountId}
          name={settings.name}
          onClose={() => setSettings(null)}
        />
      )}
      {settings && settings.type === 'pages' && (
        <PagesSettingsDrawer
          key={`pages-${settings.accountId}-${settings.name}`}
          open
          accountId={settings.accountId}
          name={settings.name}
          onClose={() => setSettings(null)}
        />
      )}
    </section>
  )
}
