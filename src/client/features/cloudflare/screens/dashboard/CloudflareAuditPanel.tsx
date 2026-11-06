/**
 * Cloudflare's own account audit log, separate from the module's local activity table below.
 *
 * The v2 endpoint is cursor-paged and needs a time window, so the panel offers an account, a window
 * and a "load more" that continues from Cloudflare's cursor. A failure (a token without
 * `account-settings.read`, for example) is shown as Cloudflare said it, never as an empty page.
 */
import { useEffect, useState } from 'react'
import type { AccountQuotaView } from '@shared/cloudflare/model'
import { LoadingBlock } from '../../../../components/feedback'
import { Badge, Button } from '../../../../components/primitives'
import { SelectMenu } from '../../../../components/select-menu'
import { t as uiT } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { cfErrorText } from '../../api/client'
import { getCloudflareAudit, type CfAuditEntry } from '../../api/dashboard'
import { useCfT } from '../../i18n'
import { formatDateTime } from '../../lib/format'
import { TBody, Table, TableScroll, Td, THead, Th, Tr } from '../../components/Table'
import { Panel, PanelEmpty, PanelError } from './Panel'

const WINDOWS = [
  { value: '1', labelKey: 'cloudflare.dashboard.audit_window_1d' },
  { value: '7', labelKey: 'cloudflare.dashboard.audit_window_7d' },
  { value: '30', labelKey: 'cloudflare.dashboard.audit_window_30d' },
] as const

function timeText(value: string | null): string {
  if (!value) return '—'
  const timestamp = Number.isNaN(Date.parse(value)) ? 0 : Date.parse(value)
  return timestamp ? formatDateTime(timestamp) : value
}

export function CloudflareAuditPanel({ accounts }: { accounts: AccountQuotaView[] }) {
  const tcf = useCfT()
  const toast = useUi((state) => state.toast)
  const [accountId, setAccountId] = useState('')
  const [days, setDays] = useState('7')
  const [entries, setEntries] = useState<CfAuditEntry[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    setAccountId((current) => (
      accounts.some((account) => account.account_id === current) ? current : accounts[0]?.account_id ?? ''
    ))
  }, [accounts])

  useEffect(() => {
    if (!accountId) {
      setEntries([])
      setCursor(null)
      return
    }
    let cancelled = false
    const before = Date.now()
    const since = before - Number(days) * 86_400_000
    setLoading(true)
    setError(null)
    setEntries([])
    setCursor(null)
    void getCloudflareAudit({ accountId, since, before, limit: 50 })
      .then((page) => {
        if (cancelled) return
        setEntries(page.entries)
        setCursor(page.cursor)
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        const message = cfErrorText(reason)
        setError(message)
        toast({ title: uiT('common.action_failed'), description: message, tone: 'danger' })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [accountId, days, reload, toast])

  async function loadMore(): Promise<void> {
    if (!accountId || !cursor) return
    const before = Date.now()
    const since = before - Number(days) * 86_400_000
    setLoading(true)
    try {
      const page = await getCloudflareAudit({ accountId, since, before, limit: 50, cursor })
      setEntries((current) => [...current, ...page.entries])
      setCursor(page.cursor)
    } catch (reason) {
      const message = cfErrorText(reason)
      setError(message)
      toast({ title: uiT('common.action_failed'), description: message, tone: 'danger' })
    } finally {
      setLoading(false)
    }
  }

  const accountOptions = accounts.map((account) => ({
    value: account.account_id,
    label: account.account_name,
  }))

  return (
    <Panel
      title={tcf('cloudflare.dashboard.cloudflare_audit')}
      actions={(
        <div className="flex flex-wrap items-center gap-2">
          <SelectMenu
            label={tcf('cloudflare.dashboard.account')}
            value={accountId}
            options={accountOptions}
            onChange={setAccountId}
            size="sm"
            width={170}
            className="w-40"
          />
          <SelectMenu
            label={tcf('cloudflare.dashboard.audit_window')}
            value={days}
            options={WINDOWS.map((window) => ({ value: window.value, label: tcf(window.labelKey) }))}
            onChange={setDays}
            size="sm"
            width={130}
            className="w-32"
          />
        </div>
      )}
      bodyClassName="space-y-2"
    >
      {error ? <PanelError message={error} onRetry={() => setReload((value) => value + 1)} /> : null}
      {loading && entries.length === 0 ? (
        <LoadingBlock />
      ) : entries.length === 0 && !error ? (
        <PanelEmpty>{tcf('cloudflare.dashboard.no_cf_audit')}</PanelEmpty>
      ) : (
        <>
          <TableScroll label={tcf('cloudflare.dashboard.cloudflare_audit')}>
            <Table>
              <THead>
                <Tr>
                  <Th>{tcf('cloudflare.dashboard.time')}</Th>
                  <Th>{tcf('cloudflare.dashboard.actor')}</Th>
                  <Th>{tcf('cloudflare.dashboard.action')}</Th>
                  <Th>{tcf('cloudflare.dashboard.target')}</Th>
                  <Th>{tcf('cloudflare.dashboard.status')}</Th>
                </Tr>
              </THead>
              <TBody>
                {entries.map((entry) => (
                  <Tr key={entry.id}>
                    <Td className="whitespace-nowrap text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                      {timeText(entry.time)}
                    </Td>
                    <Td className="whitespace-nowrap">
                      <span className="block max-w-40 truncate" title={entry.actor_email ?? undefined}>
                        {entry.actor_email || entry.actor_ip || entry.actor_type || '—'}
                      </span>
                    </Td>
                    <Td>
                      <span className="block max-w-64 truncate" title={entry.description ?? undefined}>
                        {entry.description || '—'}
                      </span>
                    </Td>
                    <Td className="whitespace-nowrap text-[var(--text-tertiary)]">
                      {[entry.resource_product, entry.resource_type, entry.zone_name].filter(Boolean).join(' · ') || '—'}
                    </Td>
                    <Td>
                      <Badge tone={entry.result?.toLowerCase() === 'success' ? 'success' : entry.result ? 'danger' : 'neutral'}>
                        {entry.result || '—'}
                      </Badge>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableScroll>
          {cursor ? (
            <div className="flex justify-end">
              <Button size="sm" variant="secondary" loading={loading} onClick={() => void loadMore()}>
                {tcf('cloudflare.dashboard.load_more')}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </Panel>
  )
}
