/**
 * The account's Cloudflare subscriptions (the plan behind the quota cards).
 *
 * A subscription row is account-level, so the panel needs an account even when the reader has only
 * one. An account whose token cannot read billing answers with Cloudflare's error, and that error is
 * shown instead of an empty "free" claim.
 */
import { useEffect, useState } from 'react'
import type { AccountQuotaView } from '@shared/cloudflare/model'
import { LoadingBlock } from '../../../../components/feedback'
import { SelectMenu } from '../../../../components/select-menu'
import { cfErrorText } from '../../api/client'
import { getSubscriptions, type CloudflareSubscription } from '../../api/dashboard'
import { useCfT } from '../../i18n'
import { Panel, PanelEmpty, PanelError } from './Panel'

export function SubscriptionPanel({ accounts }: { accounts: AccountQuotaView[] }) {
  const tcf = useCfT()
  const [accountId, setAccountId] = useState('')
  const [subscriptions, setSubscriptions] = useState<CloudflareSubscription[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    setAccountId((current) => (
      accounts.some((account) => account.account_id === current) ? current : accounts[0]?.account_id ?? ''
    ))
  }, [accounts])

  useEffect(() => {
    if (!accountId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void getSubscriptions(accountId)
      .then((body) => {
        if (!cancelled) setSubscriptions(body.subscriptions)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(cfErrorText(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [accountId, reload])

  return (
    <Panel
      title={tcf('cloudflare.dashboard.subscription')}
      actions={(
        <SelectMenu
          label={tcf('cloudflare.dashboard.account')}
          value={accountId}
          options={accounts.map((account) => ({ value: account.account_id, label: account.account_name }))}
          onChange={setAccountId}
          size="sm"
          width={170}
          className="w-40"
        />
      )}
      bodyClassName="space-y-2"
    >
      {error ? <PanelError message={error} onRetry={() => setReload((value) => value + 1)} /> : null}
      {loading && subscriptions.length === 0 ? (
        <LoadingBlock />
      ) : subscriptions.length === 0 && !error ? (
        <PanelEmpty>{tcf('cloudflare.dashboard.no_subscription')}</PanelEmpty>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {subscriptions.map((subscription) => (
            <div
              key={subscription.id}
              className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-2"
            >
              <p className="truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">
                {subscription.name || subscription.id}
              </p>
              <p className="mt-0.5 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                {subscription.state || '—'}
                {subscription.price !== null
                  ? ` · ${subscription.price} ${subscription.currency}${subscription.frequency ? ` / ${subscription.frequency}` : ''}`
                  : ''}
              </p>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}
