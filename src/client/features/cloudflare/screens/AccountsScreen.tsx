/**
 * The accounts screen: the table, the filter row, and every dialog a row can open.
 *
 * The list is server-paged and server-filtered, so the screen holds the query (page, filter, search)
 * rather than a copy of every account. Sorting is local because a page is at most a hundred rows and
 * the server's order is the useful default; a search is debounced because every keystroke would
 * otherwise be a round trip.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Upload } from 'lucide-react'
import type { AccountQuotaView, CloudflareAccount } from '@shared/cloudflare/model'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { Button } from '../../../components/primitives'
import { Empty, LoadingBlock } from '../../../components/feedback'
import { Segmented } from '../../../components/form'
import { confirm } from '../../../components/overlay'
import { SearchField } from '../components/SearchField'
import { useSort } from '../lib/sort'
import {
  accountsApi,
  type AccountFilter,
  type AccountsResponse,
  type BatchSummary,
} from '../api/accounts'
import { cfErrorText } from '../api/client'
import { cfT } from '../i18n'
import { AccountTable } from './accounts/AccountTable'
import { AccountFormDialog } from './accounts/AccountFormDialog'
import { BatchFeaturesDialog, BatchResultDialog, FeaturesDialog, toResultRows, type ResultRow } from './accounts/BatchDialogs'
import { CredentialsDialog } from './accounts/CredentialsDialog'
import { ImportCsvDialog } from './accounts/ImportCsvDialog'

const PAGE_SIZE = 20
const SEARCH_DEBOUNCE_MS = 300

interface ResultState {
  title: string
  summary: BatchSummary
  rows: ResultRow[]
}

export function AccountsScreen() {
  const toast = useUi((state) => state.toast)
  const [filter, setFilter] = useState<AccountFilter>('all')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<AccountsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [testingId, setTestingId] = useState<string | null>(null)
  const [batchTesting, setBatchTesting] = useState(false)
  const [batchBusy, setBatchBusy] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [formAccount, setFormAccount] = useState<CloudflareAccount | null>(null)
  const [credentialsFor, setCredentialsFor] = useState<CloudflareAccount | null>(null)
  const [featuresFor, setFeaturesFor] = useState<CloudflareAccount | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [batchFeaturesOpen, setBatchFeaturesOpen] = useState(false)
  const [result, setResult] = useState<ResultState | null>(null)
  const { state: sort, toggle: toggleSort, sorted } = useSort<CloudflareAccount>()

  const refresh = useCallback(() => setReload((value) => value + 1), [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    accountsApi.list({ page, pageSize: PAGE_SIZE, filter, search })
      .then((next) => {
        if (cancelled) return
        setData(next)
        setErrorText(null)
      })
      .catch((caught: unknown) => {
        if (cancelled) return
        setErrorText(cfErrorText(caught))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [page, filter, search, reload])

  useEffect(() => {
    const trimmed = searchInput.trim()
    if (trimmed === search) return
    const timer = window.setTimeout(() => {
      setSearch(trimmed)
      setPage(1)
      setSelected([])
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [searchInput, search])

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE))
  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  const accounts = data?.accounts
  const rows = useMemo(
    () => (accounts ? sorted(accounts, (row) => sortValue(row, sort.key)) : []),
    [accounts, sorted, sort.key],
  )
  const quota = useMemo(
    () => new Map<string, AccountQuotaView>((data?.quota ?? []).map((entry) => [entry.account_id, entry])),
    [data],
  )
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const pageIds = useMemo(() => rows.map((row) => row.id), [rows])
  const allChecked = pageIds.length > 0 && pageIds.every((id) => selectedSet.has(id))

  function changeFilter(next: AccountFilter): void {
    setFilter(next)
    setPage(1)
    setSelected([])
  }

  function toggleRow(id: string): void {
    setSelected((previous) => (
      previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id]
    ))
  }

  function toggleAll(): void {
    if (allChecked) {
      setSelected((previous) => previous.filter((id) => !pageIds.includes(id)))
      return
    }
    setSelected((previous) => [...previous, ...pageIds.filter((id) => !previous.includes(id))])
  }

  async function testOne(account: CloudflareAccount): Promise<void> {
    setTestingId(account.id)
    try {
      await accountsApi.test(account.id)
      toast({ title: cfT('cloudflare.accounts.msg.test_success'), tone: 'success' })
      refresh()
    } catch (caught) {
      toast({ title: t('common.action_failed'), description: cfErrorText(caught), tone: 'danger' })
    } finally {
      setTestingId(null)
    }
  }

  async function clearExhausted(account: CloudflareAccount): Promise<void> {
    try {
      await accountsApi.clearExhausted(account.id)
      toast({ title: cfT('cloudflare.accounts.msg.clear_exhausted_success'), tone: 'success' })
      refresh()
    } catch (caught) {
      toast({
        title: cfT('cloudflare.accounts.msg.clear_exhausted_failed', { error: cfErrorText(caught) }),
        tone: 'danger',
      })
    }
  }

  async function removeOne(account: CloudflareAccount): Promise<void> {
    const ok = await confirm({
      title: cfT('cloudflare.accounts.msg.delete_account_title'),
      description: cfT('cloudflare.accounts.msg.delete_account_confirm', { name: account.name }),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await accountsApi.remove(account.id)
      setSelected((previous) => previous.filter((id) => id !== account.id))
      toast({ title: cfT('cloudflare.accounts.msg.deleted'), tone: 'success' })
      refresh()
    } catch (caught) {
      toast({ title: t('common.action_failed'), description: cfErrorText(caught), tone: 'danger' })
    }
  }

  async function runBatchTest(): Promise<void> {
    setBatchTesting(true)
    try {
      const response = await accountsApi.testBatch({ onlyUnverified: filter === 'unverified' })
      setResult({
        title: cfT('cloudflare.accounts.batch_result_title'),
        summary: response.summary,
        rows: toResultRows(response.results),
      })
      toast({
        title: cfT('cloudflare.accounts.msg.batch_test_complete', {
          success: response.summary.success,
          error: response.summary.error,
        }),
        tone: response.summary.error > 0 ? 'warning' : 'success',
      })
      refresh()
    } catch (caught) {
      toast({
        title: cfT('cloudflare.accounts.msg.batch_test_failed', { error: cfErrorText(caught) }),
        tone: 'danger',
      })
    } finally {
      setBatchTesting(false)
    }
  }

  async function runBatchFeatures(enabledFeatures: string): Promise<void> {
    setBatchBusy(true)
    try {
      const response = await accountsApi.batchFeatures(selected, enabledFeatures)
      setBatchFeaturesOpen(false)
      setResult({
        title: cfT('cloudflare.accounts.batch_op_result_title'),
        summary: response.summary,
        rows: toResultRows(response.results),
      })
      toast({
        title: cfT('cloudflare.accounts.msg.batch_features_complete', {
          success: response.summary.success,
          skipped: response.summary.skipped,
          error: response.summary.error,
        }),
        tone: response.summary.error > 0 ? 'warning' : 'success',
      })
      setSelected([])
      refresh()
    } catch (caught) {
      toast({
        title: cfT('cloudflare.accounts.msg.batch_features_failed', { error: cfErrorText(caught) }),
        tone: 'danger',
      })
    } finally {
      setBatchBusy(false)
    }
  }

  async function runBatchDelete(): Promise<void> {
    const count = selected.length
    const ok = await confirm({
      title: cfT('cloudflare.accounts.batch_delete_title'),
      description: cfT('cloudflare.accounts.batch_delete_confirm', { count }),
      confirmLabel: cfT('cloudflare.accounts.confirm_delete'),
      tone: 'danger',
    })
    if (!ok) return
    setBatchBusy(true)
    try {
      const response = await accountsApi.batchDelete(selected)
      setResult({
        title: cfT('cloudflare.accounts.batch_op_result_title'),
        summary: response.summary,
        rows: toResultRows(response.results),
      })
      toast({
        title: cfT('cloudflare.accounts.msg.batch_delete_complete', {
          success: response.summary.success,
          skipped: response.summary.skipped,
          error: response.summary.error,
        }),
        tone: response.summary.error > 0 ? 'warning' : 'success',
      })
      setSelected([])
      refresh()
    } catch (caught) {
      toast({
        title: cfT('cloudflare.accounts.msg.batch_delete_failed', { error: cfErrorText(caught) }),
        tone: 'danger',
      })
    } finally {
      setBatchBusy(false)
    }
  }

  const emptyAction = (
    <Empty
      compact
      art={search ? 'search' : 'select'}
      title={cfT('cloudflare.accounts.table.total_items', { count: 0 })}
      action={(
        <div className="flex flex-wrap justify-center gap-2">
          {search && (
            <Button size="sm" variant="secondary" onClick={() => setSearchInput('')}>
              {t('common.clear')}
            </Button>
          )}
          <Button size="sm" onClick={() => { setFormAccount(null); setFormOpen(true) }}>
            {cfT('cloudflare.accounts.add_account')}
          </Button>
        </div>
      )}
    />
  )

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3">
        <h1 className="m-0 min-w-0 flex-1 truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {cfT('cloudflare.accounts.title')}
        </h1>
        <Button size="sm" variant="secondary" icon={<Upload size={14} />} onClick={() => setImportOpen(true)}>
          {cfT('cloudflare.accounts.import_csv')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon={<Plus size={14} />}
          onClick={() => { setFormAccount(null); setFormOpen(true) }}
        >
          {cfT('cloudflare.accounts.add_account')}
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-3 p-3 md:p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              value={filter}
              onChange={changeFilter}
              size="sm"
              label={cfT('cloudflare.accounts.title')}
              options={[
                { value: 'all', label: `${cfT('cloudflare.accounts.filter_all')} (${data?.counts.all ?? 0})` },
                { value: 'active', label: `${cfT('cloudflare.accounts.filter_active')} (${data?.counts.active ?? 0})` },
                { value: 'unverified', label: `${cfT('cloudflare.accounts.filter_unverified')} (${data?.counts.unverified ?? 0})` },
              ]}
            />
            <Button
              size="sm"
              variant="secondary"
              loading={batchTesting}
              disabled={filter === 'unverified' && (data?.counts.unverified ?? 0) === 0}
              onClick={() => { void runBatchTest() }}
            >
              {filter === 'unverified'
                ? cfT('cloudflare.accounts.batch_test_unverified')
                : cfT('cloudflare.accounts.batch_test_all')}
            </Button>
            <SearchField
              className="ml-auto w-full sm:w-60"
              value={searchInput}
              onChange={setSearchInput}
              label={cfT('cloudflare.accounts.search_placeholder')}
              placeholder={cfT('cloudflare.accounts.search_placeholder')}
            />
          </div>

          {selected.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2.5 py-2">
              <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
                {cfT('cloudflare.accounts.selected_items', { count: selected.length })}
              </span>
              <Button size="sm" variant="secondary" onClick={() => setBatchFeaturesOpen(true)}>
                {cfT('cloudflare.accounts.batch_features')}
              </Button>
              <Button
                size="sm"
                variant="danger"
                loading={batchBusy}
                onClick={() => { void runBatchDelete() }}
              >
                {cfT('cloudflare.accounts.batch_delete')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
                {t('common.clear')}
              </Button>
            </div>
          )}

          {errorText && (
            <div role="alert" className="flex flex-wrap items-center gap-2 rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-1.5 text-[length:var(--text-11-5)] text-[var(--danger)]">
              <span className="min-w-0 flex-1">{errorText}</span>
              <Button size="sm" variant="ghost" onClick={refresh}>{t('common.retry')}</Button>
            </div>
          )}

          {!data && loading && <LoadingBlock />}
          {!data && !loading && (
            <Empty
              art="select"
              title={t('common.action_failed')}
              description={errorText ?? undefined}
              action={<Button size="sm" onClick={refresh}>{t('common.retry')}</Button>}
            />
          )}

          {data && (
            <>
              <AccountTable
                accounts={rows}
                quota={quota}
                sort={sort}
                onToggleSort={toggleSort}
                selected={selectedSet}
                allChecked={allChecked}
                onToggleAll={toggleAll}
                onToggleRow={toggleRow}
                loading={loading}
                testingId={testingId}
                onEdit={(account) => { setFormAccount(account); setFormOpen(true) }}
                onCredentials={setCredentialsFor}
                onTest={(account) => { void testOne(account) }}
                onFeatures={setFeaturesFor}
                onClearExhausted={(account) => { void clearExhausted(account) }}
                onDelete={(account) => { void removeOne(account) }}
                emptyAction={emptyAction}
              />
              <div className="flex flex-wrap items-center justify-end gap-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                <span>{cfT('cloudflare.accounts.table.total_items', { count: data.total })}</span>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={t('email.list.page_prev')}
                  disabled={page <= 1}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                >
                  ‹
                </Button>
                <span aria-live="polite">{page} / {totalPages}</span>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={t('email.list.page_next')}
                  disabled={page >= totalPages}
                  onClick={() => setPage((value) => value + 1)}
                >
                  ›
                </Button>
              </div>
            </>
          )}
        </div>
      </div>

      <AccountFormDialog
        open={formOpen}
        account={formAccount}
        onClose={() => setFormOpen(false)}
        onSaved={refresh}
      />
      <CredentialsDialog
        open={credentialsFor !== null}
        account={credentialsFor}
        onClose={() => setCredentialsFor(null)}
      />
      <FeaturesDialog
        open={featuresFor !== null}
        account={featuresFor}
        onClose={() => setFeaturesFor(null)}
        onSaved={refresh}
      />
      <ImportCsvDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={refresh}
      />
      <BatchFeaturesDialog
        open={batchFeaturesOpen}
        count={selected.length}
        busy={batchBusy}
        onClose={() => setBatchFeaturesOpen(false)}
        onConfirm={(enabledFeatures) => { void runBatchFeatures(enabledFeatures) }}
      />
      <BatchResultDialog
        open={result !== null}
        title={result?.title ?? ''}
        summary={result?.summary ?? { total: 0, success: 0, skipped: 0, error: 0 }}
        rows={result?.rows ?? []}
        onClose={() => setResult(null)}
      />
    </div>
  )
}

function sortValue(row: CloudflareAccount, key: string | null): unknown {
  switch (key) {
    case 'name': return row.name
    case 'cf_account_id': return row.cf_account_id
    case 'auth_type': return row.auth_type
    case 'features': return row.enabled_features
    case 'created_at': return row.created_at
    case 'status': return row.is_active
    default: return row.name
  }
}
