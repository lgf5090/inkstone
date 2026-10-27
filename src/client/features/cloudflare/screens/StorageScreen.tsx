/**
 * Storage: one account, three products, each panel owning its own data.
 *
 * The Account selector is the only state this screen shares with its panels: switching it remounts the
 * panel, so no namespace, database or bucket from the previous account can leak into the next one.
 * R2 is dropped from the tabs when the account has already reported that it is not enabled.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { CloudflareAccount } from '@shared/cloudflare/model'
import { Empty, LoadingBlock } from '../../../components/feedback'
import { Segmented } from '../../../components/form'
import { Button } from '../../../components/primitives'
import { SelectMenu } from '../../../components/select-menu'
import { t as uiT } from '../../../lib/i18n'
import { cfErrorText } from '../api/client'
import { accountsApi } from '../api/accounts'
import { useCfT } from '../i18n'
import { D1Panel } from './storage/D1Panel'
import { KvPanel } from './storage/KvPanel'
import { R2Panel } from './storage/R2Panel'
import { StorageError } from './storage/StorageError'

type StorageTab = 'kv' | 'd1' | 'r2'

function hasStorageFeature(account: CloudflareAccount): boolean {
  const features = (account.enabled_features || '').split(',').map((item) => item.trim()).filter(Boolean)
  return features.length === 0 || features.includes('storage')
}

function r2AvailableFor(account: CloudflareAccount | null): boolean {
  if (!account) return false
  return !(account.available_features || '').split(',').map((item) => item.trim()).includes('-r2')
}

export function StorageScreen() {
  const t = useCfT()
  const [accounts, setAccounts] = useState<CloudflareAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [activeTab, setActiveTab] = useState<StorageTab>('kv')
  const [reloadKey, setReloadKey] = useState(0)

  const loadAccounts = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const page = await accountsApi.list({ filter: 'active', pageSize: 100 })
      const storageAccounts = page.accounts.filter(hasStorageFeature)
      setAccounts(storageAccounts)
      setSelectedId((current) => (
        current && storageAccounts.some((account) => account.id === current)
          ? current
          : storageAccounts[0]?.id ?? ''
      ))
    } catch (reason) {
      setError(cfErrorText(reason))
      setAccounts([])
      setSelectedId('')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadAccounts()
  }, [loadAccounts])

  const account = useMemo(
    () => accounts.find((candidate) => candidate.id === selectedId) ?? null,
    [accounts, selectedId],
  )
  const r2Available = r2AvailableFor(account)

  useEffect(() => {
    if (activeTab === 'r2' && !r2Available) setActiveTab('kv')
  }, [activeTab, r2Available])

  const tabOptions = [
    { value: 'kv' as const, label: t('cloudflare.storage.kv') },
    { value: 'd1' as const, label: t('cloudflare.storage.d1') },
    ...(r2Available ? [{ value: 'r2' as const, label: t('cloudflare.storage.r2') }] : []),
  ]

  const accountOptions = accounts.map((candidate) => ({
    value: candidate.id,
    label: candidate.name || candidate.id,
  }))

  function refresh(): void {
    setReloadKey((value) => value + 1)
    void loadAccounts()
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
        <h1 className="text-[length:var(--text-16)] font-semibold tracking-[-0.012em] text-[var(--text-primary)]">
          {t('cloudflare.storage.title')}
        </h1>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {t('cloudflare.storage.account_label')}
            </span>
            <div className="w-52">
              <SelectMenu
                label={t('cloudflare.storage.account_label')}
                value={selectedId}
                options={accountOptions}
                placeholder={t('cloudflare.storage.search_account')}
                disabled={accounts.length === 0}
                onChange={setSelectedId}
              />
            </div>
          </div>
          <Button
            size="sm"
            variant="secondary"
            loading={loading}
            icon={<RefreshCw size={14} />}
            onClick={refresh}
          >
            {uiT('common.refresh')}
          </Button>
        </div>
      </header>

      {account && (
        <div className="border-b border-[var(--border-subtle)] px-4 py-2">
          <Segmented<StorageTab>
            value={activeTab}
            options={tabOptions}
            onChange={setActiveTab}
            label={uiT('common.navigation')}
          />
        </div>
      )}

      <div className="min-h-0 flex-1">
        {error ? (
          <div className="p-4"><StorageError message={error} onRetry={() => { void loadAccounts() }} /></div>
        ) : loading && accounts.length === 0 ? (
          <div className="flex h-full items-center justify-center"><LoadingBlock /></div>
        ) : !account ? (
          <div className="p-4">
            <Empty art="select" title={t('cloudflare.storage.search_account')} />
          </div>
        ) : activeTab === 'kv' ? (
          <KvPanel key={`kv:${account.id}:${reloadKey}`} account={account} />
        ) : activeTab === 'd1' ? (
          <D1Panel key={`d1:${account.id}:${reloadKey}`} account={account} />
        ) : (
          <R2Panel key={`r2:${account.id}:${reloadKey}`} account={account} />
        )}
      </div>
    </section>
  )
}
