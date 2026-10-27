/**
 * DNS management: the domain list on the left, the selected zone's four panels on the right.
 *
 * The screen owns only what is shared between the panels — which domain is open, the filters, the
 * selection and the add/result dialogs. Each panel fetches its own data and draws its own
 * loading/empty/error states, so a slow ruleset list never blanks the records table.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import { Segmented } from '../../../components/form'
import { Empty } from '../../../components/feedback'
import { confirm } from '../../../components/overlay'
import { Badge, Button } from '../../../components/primitives'
import { t as uiT } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { cfErrorText } from '../api/client'
import { dnsApi, type DnsDomainsResponse, type DomainBatchResult, type DnsZone } from '../api/dns'
import { useCfT } from '../i18n'
import { AddDomainDialog, DomainResultDialog } from './dns/AddDomainDialog'
import { CachePanel } from './dns/CachePanel'
import { DomainList } from './dns/DomainList'
import { RecordsPanel } from './dns/RecordsPanel'
import { RulesPanel } from './dns/RulesPanel'
import { statusText, statusTone } from './dns/options'
import { ZoneSettingsPanel } from './dns/ZoneSettingsPanel'

type DnsTab = 'records' | 'settings' | 'cache' | 'rules'

export function DnsScreen() {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const [data, setData] = useState<DnsDomainsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [accountFilter, setAccountFilter] = useState('')
  const [tab, setTab] = useState<DnsTab>('records')
  const [addOpen, setAddOpen] = useState(false)
  const [createResult, setCreateResult] = useState<DomainBatchResult | null>(null)

  const loadDomains = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await dnsApi.listDomains()
      setData(next)
      setSelected((current) => (
        current && next.domains.some((domain) => domain.name === current) ? current : null
      ))
      setSelection((current) => new Set(
        [...current].filter((name) => next.domains.some((domain) => domain.name === name)),
      ))
    } catch (reason) {
      setError(cfErrorText(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadDomains()
  }, [loadDomains])

  const domains = data?.domains ?? []
  const accounts = data?.accounts ?? []

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return domains.filter((domain) => (
      (!accountFilter || domain.cfAccountId === accountFilter)
      && (!needle || domain.name.toLowerCase().includes(needle))
    ))
  }, [domains, accountFilter, query])

  const zone: DnsZone | null = domains.find((domain) => domain.name === selected) ?? null

  function toggleSelected(name: string): void {
    setSelection((current) => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  function selectAll(list: DnsZone[], checked: boolean): void {
    setSelection((current) => {
      const next = new Set(current)
      for (const domain of list) {
        if (checked) next.add(domain.name)
        else next.delete(domain.name)
      }
      return next
    })
  }

  async function deleteDomains(names: string[]): Promise<void> {
    if (names.length === 0) return
    const ok = await confirm({
      title: t('cloudflare.dns.msg.delete_confirm'),
      description: t('cloudflare.dns.msg.batch_delete_confirm', { count: names.length }),
      confirmLabel: uiT('common.delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      const outcome = await dnsApi.deleteDomains(names)
      toast({
        title: t('cloudflare.dns.msg.batch_delete_complete', {
          succeeded: outcome.succeeded,
          failed: outcome.failed,
        }),
        tone: outcome.failed > 0 ? 'warning' : 'success',
      })
      setSelection(new Set())
      await loadDomains()
    } catch (reason) {
      toast({
        title: t('cloudflare.dns.msg.delete_failed'),
        description: cfErrorText(reason),
        tone: 'danger',
      })
    }
  }

  async function handleCreated(outcome: DomainBatchResult): Promise<void> {
    setAddOpen(false)
    setCreateResult(outcome)
    await loadDomains()
    const first = outcome.results.find((item) => item.success)
    if (first) setSelected(first.name)
  }

  const tabOptions = [
    { value: 'records' as const, label: t('cloudflare.dns.records') },
    { value: 'settings' as const, label: t('cloudflare.dns.zone_settings') },
    { value: 'cache' as const, label: t('cloudflare.dns.cache_and_status') },
    { value: 'rules' as const, label: t('cloudflare.tunnels.rules_engine') },
  ]

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
        <h1 className="text-[length:var(--text-16)] font-semibold tracking-[-0.012em] text-[var(--text-primary)]">
          {t('cloudflare.dns.title')}
        </h1>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            loading={loading}
            icon={<RefreshCw size={14} />}
            onClick={() => void loadDomains()}
          >
            {uiT('common.refresh')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<Plus size={14} />}
            onClick={() => setAddOpen(true)}
          >
            {t('cloudflare.dns.add_domain')}
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 lg:grid-cols-[19rem_minmax(0,1fr)]">
        <DomainList
          domains={filtered}
          accounts={accounts}
          loading={loading}
          error={error}
          selected={selected}
          selection={selection}
          query={query}
          accountFilter={accountFilter}
          onQueryChange={setQuery}
          onAccountFilterChange={setAccountFilter}
          onSelect={setSelected}
          onToggleSelected={toggleSelected}
          onSelectAll={selectAll}
          onReload={() => void loadDomains()}
          onAdd={() => setAddOpen(true)}
          onDelete={(names) => void deleteDomains(names)}
        />

        <div className="min-h-0 overflow-y-auto rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
          {zone ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="truncate text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">
                    {zone.name}
                  </h2>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                    <span className="truncate">{zone.accountName}</span>
                    <Badge tone={statusTone(zone.status)}>{statusText(t, zone.status)}</Badge>
                  </p>
                </div>
                <Segmented<DnsTab>
                  value={tab}
                  options={tabOptions}
                  onChange={setTab}
                  label={uiT('common.navigation')}
                />
              </div>

              {tab === 'records' && <RecordsPanel key={zone.name} domain={zone.name} />}
              {tab === 'settings' && <ZoneSettingsPanel key={zone.name} domain={zone.name} />}
              {tab === 'cache' && (
                <CachePanel
                  key={zone.name}
                  domain={zone.name}
                  zone={zone}
                  onZoneChanged={() => void loadDomains()}
                />
              )}
              {tab === 'rules' && <RulesPanel key={zone.name} domain={zone.name} />}
            </div>
          ) : (
            <Empty title={t('cloudflare.dns.select_from_left')} />
          )}
        </div>
      </div>

      {addOpen && (
        <AddDomainDialog
          accounts={accounts}
          onClose={() => setAddOpen(false)}
          onCreated={(outcome) => void handleCreated(outcome)}
        />
      )}
      {createResult && (
        <DomainResultDialog result={createResult} onClose={() => setCreateResult(null)} />
      )}
    </section>
  )
}
