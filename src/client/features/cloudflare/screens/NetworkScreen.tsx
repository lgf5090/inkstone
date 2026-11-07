/**
 * Network & routing: load balancing, Bulk Redirects, Email Routing and Snippets.
 *
 * Four read-only surfaces that share one account/zone selector. Each tab owns its fetch and its
 * loading/empty/error states, so one Cloudflare product being unavailable (or not included in the
 * plan) never blanks the others. Each surface has a create/delete pair wired to an audited route;
 * edit-in-place is intentionally absent because Cloudflare's update payloads differ per product.
 */
import { useEffect, useMemo, useState } from 'react'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { CloudflareAccount } from '@shared/cloudflare/model'
import { Empty, LoadingBlock } from '../../../components/feedback'
import { Checkbox, Field, Input, Textarea } from '../../../components/form'
import { Modal, confirm } from '../../../components/overlay'
import { Badge, Button, IconButton } from '../../../components/primitives'
import { SelectMenu } from '../../../components/select-menu'
import { t as uiT } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { accountsApi } from '../api/accounts'
import { cfErrorText } from '../api/client'
import { getDashboardZones } from '../api/dashboard'
import {
  networkApi,
  type BulkRedirectItem,
  type BulkRedirectList,
  type EmailRoutingResponse,
  type LoadBalancerMonitor,
  type LoadBalancerPool,
  type PoolHealth,
  type SnippetsResponse,
  type ZoneLoadBalancer,
} from '../api/network'
import { useCfT, type CloudflareMessageKey } from '../i18n'
import { SearchField } from '../components/SearchField'
import { TBody, Table, TableScroll, Td, THead, Th, Tr } from '../components/Table'
import { Panel, PanelEmpty, PanelError } from './dashboard/Panel'

type NetworkTab = 'load-balancing' | 'bulk-redirects' | 'email-routing' | 'snippets'

const DEFAULT_SNIPPET = `export default {
  async fetch(request) {
    return fetch(request)
  },
}
`

const TABS: readonly { value: NetworkTab; labelKey: CloudflareMessageKey }[] = [
  { value: 'load-balancing', labelKey: 'cloudflare.network.tabs.load_balancing' },
  { value: 'bulk-redirects', labelKey: 'cloudflare.network.tabs.bulk_redirects' },
  { value: 'email-routing', labelKey: 'cloudflare.network.tabs.email_routing' },
  { value: 'snippets', labelKey: 'cloudflare.network.tabs.snippets' },
]

function BadgeForEnabled({ enabled }: { enabled: boolean }) {
  const tcf = useCfT()
  return (
    <Badge tone={enabled ? 'success' : 'neutral'}>
      {enabled ? tcf('cloudflare.network.enabled') : tcf('cloudflare.network.disabled')}
    </Badge>
  )
}

function LoadBalancingPanel({ accountId, zoneId, readOnly }: { accountId: string; zoneId: string; readOnly: boolean }) {
  const tcf = useCfT()
  const toast = useUi((state) => state.toast)
  const [pools, setPools] = useState<LoadBalancerPool[]>([])
  const [monitors, setMonitors] = useState<LoadBalancerMonitor[]>([])
  const [loadBalancers, setLoadBalancers] = useState<ZoneLoadBalancer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const [health, setHealth] = useState<PoolHealth | null>(null)
  const [busy, setBusy] = useState(false)
  const [poolOpen, setPoolOpen] = useState(false)
  const [poolName, setPoolName] = useState('')
  const [poolAddress, setPoolAddress] = useState('')
  const [poolMonitor, setPoolMonitor] = useState('')
  const [monitorOpen, setMonitorOpen] = useState(false)
  const [monitorDescription, setMonitorDescription] = useState('')
  const [monitorType, setMonitorType] = useState<'http' | 'https'>('http')
  const [monitorMethod, setMonitorMethod] = useState<'GET' | 'HEAD'>('GET')
  const [monitorPath, setMonitorPath] = useState('/')
  const [monitorCodes, setMonitorCodes] = useState('200')
  const [monitorInterval, setMonitorInterval] = useState('60')
  const [monitorTimeout, setMonitorTimeout] = useState('5')
  const [monitorRetries, setMonitorRetries] = useState('2')
  const [lbOpen, setLbOpen] = useState(false)
  const [lbName, setLbName] = useState('')
  const [lbPool, setLbPool] = useState('')

  useEffect(() => {
    if (!accountId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void Promise.all([
      networkApi.pools(accountId),
      networkApi.monitors(accountId),
      zoneId ? networkApi.zoneLoadBalancers(accountId, zoneId) : Promise.resolve({ loadBalancers: [] }),
    ])
      .then(([poolBody, monitorBody, lbBody]) => {
        if (cancelled) return
        setPools(poolBody.pools)
        setMonitors(monitorBody.monitors)
        setLoadBalancers(lbBody.loadBalancers)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(cfErrorText(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [accountId, zoneId, nonce])

  async function openHealth(pool: LoadBalancerPool): Promise<void> {
    try {
      setHealth(await networkApi.poolHealth(accountId, pool.id))
    } catch (reason) {
      setHealth({ poolId: pool.id, healthy: false, origins: [] })
      console.warn('[inkstone] Pool health failed:', cfErrorText(reason))
    }
  }

  async function createPool(): Promise<void> {
    setBusy(true)
    try {
      await networkApi.createPool(accountId, {
        name: poolName.trim(),
        address: poolAddress.trim(),
        ...(poolMonitor ? { monitorId: poolMonitor } : {}),
      })
      toast({ title: tcf('cloudflare.network.created'), tone: 'success' })
      setPoolOpen(false)
      setPoolName('')
      setPoolAddress('')
      setPoolMonitor('')
      setNonce((value) => value + 1)
    } catch (reason) {
      toast({ title: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function createMonitor(): Promise<void> {
    setBusy(true)
    try {
      await networkApi.createMonitor(accountId, {
        description: monitorDescription.trim(),
        type: monitorType,
        method: monitorMethod,
        path: monitorPath.trim(),
        expectedCodes: monitorCodes.trim(),
        interval: Number(monitorInterval),
        timeout: Number(monitorTimeout),
        retries: Number(monitorRetries),
      })
      toast({ title: tcf('cloudflare.network.created'), tone: 'success' })
      setMonitorOpen(false)
      setMonitorDescription('')
      setNonce((value) => value + 1)
    } catch (reason) {
      toast({ title: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function createLoadBalancer(): Promise<void> {
    if (!zoneId || !lbPool) return
    setBusy(true)
    try {
      await networkApi.createZoneLoadBalancer(accountId, zoneId, {
        name: lbName.trim(),
        fallbackPool: lbPool,
        defaultPools: [lbPool],
      })
      toast({ title: tcf('cloudflare.network.created'), tone: 'success' })
      setLbOpen(false)
      setLbName('')
      setNonce((value) => value + 1)
    } catch (reason) {
      toast({ title: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function removePool(pool: LoadBalancerPool): Promise<void> {
    const ok = await confirm({
      title: uiT('common.delete'),
      description: tcf('cloudflare.network.delete_confirm', { name: pool.name || pool.id }),
      confirmLabel: uiT('common.delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      await networkApi.deletePool(accountId, pool.id)
      toast({ title: tcf('cloudflare.network.deleted'), tone: 'success' })
      setNonce((value) => value + 1)
    } catch (reason) {
      toast({ title: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function removeMonitor(monitor: LoadBalancerMonitor): Promise<void> {
    const ok = await confirm({
      title: uiT('common.delete'),
      description: tcf('cloudflare.network.delete_confirm', { name: monitor.description || monitor.id }),
      confirmLabel: uiT('common.delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      await networkApi.deleteMonitor(accountId, monitor.id)
      toast({ title: tcf('cloudflare.network.deleted'), tone: 'success' })
      setNonce((value) => value + 1)
    } catch (reason) {
      toast({ title: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function removeLoadBalancer(loadBalancer: ZoneLoadBalancer): Promise<void> {
    if (!zoneId) return
    const ok = await confirm({
      title: uiT('common.delete'),
      description: tcf('cloudflare.network.delete_confirm', { name: loadBalancer.name || loadBalancer.id }),
      confirmLabel: uiT('common.delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      await networkApi.deleteZoneLoadBalancer(accountId, zoneId, loadBalancer.id)
      toast({ title: tcf('cloudflare.network.deleted'), tone: 'success' })
      setNonce((value) => value + 1)
    } catch (reason) {
      toast({ title: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <LoadingBlock />
  if (error) return <PanelError message={error} onRetry={() => setNonce((value) => value + 1)} />

  return (
    <div className="space-y-4">
      <Panel
        title={tcf('cloudflare.network.lb.pools')}
        bodyClassName="p-0"
        actions={(
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus size={13} />}
            disabled={readOnly}
            onClick={() => setPoolOpen(true)}
          >
            {tcf('cloudflare.network.lb.add_pool')}
          </Button>
        )}
      >
        {pools.length === 0 ? <PanelEmpty>{tcf('cloudflare.network.lb.no_pools')}</PanelEmpty> : (
          <TableScroll label={tcf('cloudflare.network.lb.pools')}>
            <Table>
              <THead><Tr>
                <Th>{tcf('cloudflare.network.lb.name')}</Th>
                <Th>{tcf('cloudflare.network.lb.origins')}</Th>
                <Th>{tcf('cloudflare.network.lb.monitor')}</Th>
                <Th>{tcf('cloudflare.network.lb.notification_email')}</Th>
                <Th>{tcf('cloudflare.network.status')}</Th>
                <Th>{tcf('cloudflare.network.actions')}</Th>
              </Tr></THead>
              <TBody>
                {pools.map((pool) => (
                  <Tr key={pool.id}>
                    <Td className="font-medium">{pool.name || pool.id}</Td>
                    <Td className="tabular">{pool.originCount}</Td>
                    <Td className="font-mono text-[length:var(--text-11-5)]">{pool.monitorId || '—'}</Td>
                    <Td className="max-w-48 truncate text-[var(--text-tertiary)]">{pool.notificationEmail || '—'}</Td>
                    <Td><BadgeForEnabled enabled={pool.enabled} /></Td>
                    <Td>
                      <div className="flex items-center gap-1">
                        <Button size="sm" variant="ghost" onClick={() => void openHealth(pool)}>{tcf('cloudflare.network.lb.health')}</Button>
                        <IconButton
                          label={uiT('common.delete')}
                          size="xs"
                          disabled={readOnly || busy}
                          onClick={() => { void removePool(pool) }}
                        >
                          <Trash2 size={13} />
                        </IconButton>
                      </div>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableScroll>
        )}
      </Panel>

      <Panel
        title={tcf('cloudflare.network.lb.monitors')}
        bodyClassName="p-0"
        actions={(
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus size={13} />}
            disabled={readOnly}
            onClick={() => setMonitorOpen(true)}
          >
            {tcf('cloudflare.network.lb.add_monitor')}
          </Button>
        )}
      >
        {monitors.length === 0 ? <PanelEmpty>{tcf('cloudflare.network.lb.no_monitors')}</PanelEmpty> : (
          <TableScroll label={tcf('cloudflare.network.lb.monitors')}>
            <Table>
              <THead><Tr>
                <Th>{tcf('cloudflare.network.lb.description')}</Th>
                <Th>{tcf('cloudflare.network.lb.type')}</Th>
                <Th>{tcf('cloudflare.network.lb.method_path')}</Th>
                <Th>{tcf('cloudflare.network.lb.expected_codes')}</Th>
                <Th>{tcf('cloudflare.network.lb.interval_timeout')}</Th>
                <Th>{tcf('cloudflare.network.actions')}</Th>
              </Tr></THead>
              <TBody>
                {monitors.map((monitor) => (
                  <Tr key={monitor.id}>
                    <Td>{monitor.description || monitor.id}</Td>
                    <Td>{monitor.type || '—'}</Td>
                    <Td className="font-mono text-[length:var(--text-11-5)]">
                      {[monitor.method, monitor.path].filter(Boolean).join(' ') || '—'}
                    </Td>
                    <Td>{monitor.expectedCodes || '—'}</Td>
                    <Td className="tabular text-[var(--text-tertiary)]">
                      {[monitor.interval, monitor.timeout, monitor.retries].map((value) => value ?? '—').join(' / ')}
                    </Td>
                    <Td>
                      <IconButton
                        label={uiT('common.delete')}
                        size="xs"
                        disabled={readOnly || busy}
                        onClick={() => { void removeMonitor(monitor) }}
                      >
                        <Trash2 size={13} />
                      </IconButton>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableScroll>
        )}
      </Panel>

      <Panel
        title={tcf('cloudflare.network.lb.zone_load_balancers')}
        bodyClassName="p-0"
        actions={(
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus size={13} />}
            disabled={readOnly || !zoneId}
            onClick={() => setLbOpen(true)}
          >
            {tcf('cloudflare.network.lb.add_load_balancer')}
          </Button>
        )}
      >
        {loadBalancers.length === 0 ? <PanelEmpty>{tcf('cloudflare.network.lb.no_load_balancers')}</PanelEmpty> : (
          <TableScroll label={tcf('cloudflare.network.lb.zone_load_balancers')}>
            <Table>
              <THead><Tr>
                <Th>{tcf('cloudflare.network.lb.name')}</Th>
                <Th>{tcf('cloudflare.network.lb.default_pools')}</Th>
                <Th>{tcf('cloudflare.network.lb.fallback_pool')}</Th>
                <Th>{tcf('cloudflare.network.lb.steering')}</Th>
                <Th>{tcf('cloudflare.network.status')}</Th>
                <Th>{tcf('cloudflare.network.actions')}</Th>
              </Tr></THead>
              <TBody>
                {loadBalancers.map((lb) => (
                  <Tr key={lb.id}>
                    <Td className="font-medium">{lb.name || lb.id}</Td>
                    <Td className="max-w-56 truncate text-[var(--text-secondary)]">{lb.defaultPools.join(', ') || '—'}</Td>
                    <Td className="font-mono text-[length:var(--text-11-5)]">{lb.fallbackPool || '—'}</Td>
                    <Td>{lb.steeringPolicy || '—'}</Td>
                    <Td><BadgeForEnabled enabled={lb.enabled} /></Td>
                    <Td>
                      <IconButton
                        label={uiT('common.delete')}
                        size="xs"
                        disabled={readOnly || busy}
                        onClick={() => { void removeLoadBalancer(lb) }}
                      >
                        <Trash2 size={13} />
                      </IconButton>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableScroll>
        )}
      </Panel>

      <Modal open={health !== null} onClose={() => setHealth(null)} title={tcf('cloudflare.network.lb.health')} width={520}>
        {health ? (
          <div className="space-y-2">
            <Badge tone={health.healthy ? 'success' : 'danger'}>
              {health.healthy ? tcf('cloudflare.network.lb.healthy') : tcf('cloudflare.network.lb.unhealthy')}
            </Badge>
            {health.origins.length === 0 ? <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{tcf('cloudflare.network.lb.no_origins')}</p> : (
              <ul className="space-y-1">
                {health.origins.map((origin) => (
                  <li key={origin.address} className="flex items-center justify-between gap-2 rounded-[var(--r-sm)] bg-[var(--bg-sunken)] px-2 py-1 text-[length:var(--text-12)]">
                    <span className="font-mono">{origin.address}</span>
                    <Badge tone={origin.disabled ? 'neutral' : origin.healthy ? 'success' : 'danger'}>
                      {origin.disabled
                        ? tcf('cloudflare.network.lb.disabled')
                        : origin.healthy ? tcf('cloudflare.network.lb.healthy') : tcf('cloudflare.network.lb.unhealthy')}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </Modal>

      <Modal
        open={poolOpen}
        onClose={() => setPoolOpen(false)}
        title={tcf('cloudflare.network.lb.add_pool')}
        width={520}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setPoolOpen(false)}>{uiT('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!poolName.trim() || !poolAddress.trim()}
              onClick={() => { void createPool() }}
            >
              {tcf('cloudflare.network.lb.add_pool')}
            </Button>
          </>
        )}
      >
        <div className="space-y-3">
          <Field label={tcf('cloudflare.network.lb.pool_name')}>
            <Input
              value={poolName}
              className="font-mono text-[length:var(--text-11-5)]"
              onChange={(event) => setPoolName(event.target.value)}
            />
          </Field>
          <Field label={tcf('cloudflare.network.lb.origin_address')}>
            <Input
              value={poolAddress}
              placeholder="192.0.2.1"
              className="font-mono text-[length:var(--text-11-5)]"
              onChange={(event) => setPoolAddress(event.target.value)}
            />
          </Field>
          <div>
            <p className="mb-1.5 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
              {tcf('cloudflare.network.lb.monitor_optional')}
            </p>
            <SelectMenu
              label={tcf('cloudflare.network.lb.monitor_optional')}
              value={poolMonitor}
              options={monitors.map((monitor) => ({ value: monitor.id, label: monitor.description || monitor.id }))}
              placeholder={tcf('cloudflare.network.lb.monitor_optional')}
              onChange={setPoolMonitor}
            />
          </div>
        </div>
      </Modal>

      <Modal
        open={monitorOpen}
        onClose={() => setMonitorOpen(false)}
        title={tcf('cloudflare.network.lb.add_monitor')}
        width={560}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setMonitorOpen(false)}>{uiT('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!monitorDescription.trim() || !monitorPath.trim()}
              onClick={() => { void createMonitor() }}
            >
              {tcf('cloudflare.network.lb.add_monitor')}
            </Button>
          </>
        )}
      >
        <div className="space-y-3">
          <Field label={tcf('cloudflare.network.lb.monitor_description')}>
            <Input value={monitorDescription} onChange={(event) => setMonitorDescription(event.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <div className="w-28">
              <SelectMenu
                label={tcf('cloudflare.network.lb.type')}
                value={monitorType}
                options={[{ value: 'http', label: 'HTTP' }, { value: 'https', label: 'HTTPS' }]}
                onChange={setMonitorType}
              />
            </div>
            <div className="w-28">
              <SelectMenu
                label={tcf('cloudflare.network.lb.method_path')}
                value={monitorMethod}
                options={[{ value: 'GET', label: 'GET' }, { value: 'HEAD', label: 'HEAD' }]}
                onChange={setMonitorMethod}
              />
            </div>
            <Field label={tcf('cloudflare.network.lb.method_path')} className="min-w-40 flex-1">
              <Input value={monitorPath} onChange={(event) => setMonitorPath(event.target.value)} />
            </Field>
          </div>
          <Field label={tcf('cloudflare.network.lb.expected_codes')}>
            <Input value={monitorCodes} onChange={(event) => setMonitorCodes(event.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Field label={tcf('cloudflare.network.lb.monitor_interval')} className="w-32">
              <Input type="number" min={1} max={3600} value={monitorInterval} onChange={(event) => setMonitorInterval(event.target.value)} />
            </Field>
            <Field label={tcf('cloudflare.network.lb.monitor_timeout')} className="w-32">
              <Input type="number" min={1} max={30} value={monitorTimeout} onChange={(event) => setMonitorTimeout(event.target.value)} />
            </Field>
            <Field label={tcf('cloudflare.network.lb.monitor_retries')} className="w-32">
              <Input type="number" min={0} max={10} value={monitorRetries} onChange={(event) => setMonitorRetries(event.target.value)} />
            </Field>
          </div>
        </div>
      </Modal>

      <Modal
        open={lbOpen}
        onClose={() => setLbOpen(false)}
        title={tcf('cloudflare.network.lb.add_load_balancer')}
        width={520}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setLbOpen(false)}>{uiT('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!lbName.trim() || !lbPool}
              onClick={() => { void createLoadBalancer() }}
            >
              {tcf('cloudflare.network.lb.add_load_balancer')}
            </Button>
          </>
        )}
      >
        <div className="space-y-3">
          <Field label={tcf('cloudflare.network.lb.load_balancer_name')}>
            <Input
              value={lbName}
              className="font-mono text-[length:var(--text-11-5)]"
              onChange={(event) => setLbName(event.target.value)}
            />
          </Field>
          <div>
            <p className="mb-1.5 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
              {tcf('cloudflare.network.lb.pool')}
            </p>
            {pools.length === 0 ? (
              <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                {tcf('cloudflare.network.lb.no_pools')}
              </p>
            ) : (
              <SelectMenu
                label={tcf('cloudflare.network.lb.pool')}
                value={lbPool}
                options={pools.map((pool) => ({ value: pool.id, label: pool.name || pool.id }))}
                placeholder={tcf('cloudflare.network.lb.pool')}
                onChange={setLbPool}
              />
            )}
          </div>
        </div>
      </Modal>
    </div>
  )
}

function BulkRedirectsPanel({ accountId, readOnly }: { accountId: string; readOnly: boolean }) {
  const tcf = useCfT()
  const toast = useUi((state) => state.toast)
  const [supported, setSupported] = useState(true)
  const [reason, setReason] = useState('')
  const [lists, setLists] = useState<BulkRedirectList[]>([])
  const [listId, setListId] = useState('')
  const [items, setItems] = useState<BulkRedirectItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [itemsLoading, setItemsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const [busy, setBusy] = useState(false)
  const [listOpen, setListOpen] = useState(false)
  const [listName, setListName] = useState('')
  const [itemOpen, setItemOpen] = useState(false)
  const [sourceUrl, setSourceUrl] = useState('')
  const [targetUrl, setTargetUrl] = useState('')
  const [statusCode, setStatusCode] = useState<'301' | '302' | '307' | '308'>('301')
  const [preserveQuery, setPreserveQuery] = useState(false)
  const [includeSubdomains, setIncludeSubdomains] = useState(false)

  useEffect(() => {
    if (!accountId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void networkApi.redirectLists(accountId)
      .then((body) => {
        if (cancelled) return
        setSupported(body.supported)
        setReason(body.reason ?? '')
        setLists(body.lists)
        setListId(body.lists[0]?.id ?? '')
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(cfErrorText(failure))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [accountId, nonce])

  useEffect(() => {
    if (!accountId || !listId) {
      setItems([])
      setCursor(null)
      return
    }
    let cancelled = false
    setItemsLoading(true)
    void networkApi.redirectItems(accountId, listId)
      .then((body) => {
        if (cancelled) return
        setItems(body.items)
        setCursor(body.cursor)
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(cfErrorText(failure))
      })
      .finally(() => {
        if (!cancelled) setItemsLoading(false)
      })
    return () => { cancelled = true }
  }, [accountId, listId])

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return items
    return items.filter((item) => `${item.sourceUrl} ${item.targetUrl}`.toLowerCase().includes(query))
  }, [items, search])

  async function loadMore(): Promise<void> {
    if (!cursor || !listId) return
    setItemsLoading(true)
    try {
      const body = await networkApi.redirectItems(accountId, listId, cursor)
      setItems((current) => [...current, ...body.items])
      setCursor(body.cursor)
    } catch (failure) {
      setError(cfErrorText(failure))
    } finally {
      setItemsLoading(false)
    }
  }

  async function createList(): Promise<void> {
    setBusy(true)
    try {
      await networkApi.createRedirectList(accountId, listName.trim())
      toast({ title: tcf('cloudflare.network.created'), tone: 'success' })
      setListOpen(false)
      setListName('')
      setNonce((value) => value + 1)
    } catch (failure) {
      toast({ title: cfErrorText(failure), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function createItem(): Promise<void> {
    if (!listId) return
    setBusy(true)
    try {
      await networkApi.createRedirectItem(accountId, listId, {
        sourceUrl: sourceUrl.trim(),
        targetUrl: targetUrl.trim(),
        statusCode: Number(statusCode),
        preserveQueryString: preserveQuery,
        includeSubdomains,
      })
      toast({ title: tcf('cloudflare.network.created'), tone: 'success' })
      setItemOpen(false)
      setSourceUrl('')
      setTargetUrl('')
      setPreserveQuery(false)
      setIncludeSubdomains(false)
      setNonce((value) => value + 1)
    } catch (failure) {
      toast({ title: cfErrorText(failure), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function deleteList(): Promise<void> {
    if (!listId) return
    const list = lists.find((entry) => entry.id === listId)
    const ok = await confirm({
      title: uiT('common.delete'),
      description: tcf('cloudflare.network.delete_confirm', { name: list?.name || listId }),
      confirmLabel: uiT('common.delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      await networkApi.deleteRedirectList(accountId, listId)
      toast({ title: tcf('cloudflare.network.deleted'), tone: 'success' })
      setListId('')
      setNonce((value) => value + 1)
    } catch (failure) {
      toast({ title: cfErrorText(failure), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <LoadingBlock />
  if (error) return <PanelError message={error} onRetry={() => setNonce((value) => value + 1)} />
  if (!supported) {
    return (
      <Panel title={tcf('cloudflare.network.redirects.title')}>
        <div className="space-y-2">
          <PanelEmpty>{tcf('cloudflare.network.redirects.unsupported')}</PanelEmpty>
          {reason ? <p className="text-center text-[length:var(--text-11)] text-[var(--text-tertiary)]">{reason}</p> : null}
        </div>
      </Panel>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-56">
          <Field label={tcf('cloudflare.network.redirects.list')}>
            <div>
              <SelectMenu
                label={tcf('cloudflare.network.redirects.list')}
                value={listId}
                options={lists.map((list) => ({ value: list.id, label: `${list.name || list.id} (${list.itemCount})` }))}
                onChange={setListId}
                width={220}
              />
            </div>
          </Field>
        </div>
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder={tcf('cloudflare.network.redirects.search')}
          label={tcf('cloudflare.network.redirects.search')}
          className="w-56"
        />
        <Button
          size="sm"
          variant="secondary"
          icon={<Plus size={13} />}
          disabled={readOnly}
          onClick={() => setListOpen(true)}
        >
          {tcf('cloudflare.network.redirects.new_list')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon={<Plus size={13} />}
          disabled={readOnly || !listId}
          onClick={() => setItemOpen(true)}
        >
          {tcf('cloudflare.network.redirects.add_item')}
        </Button>
        <IconButton
          label={uiT('common.delete')}
          size="xs"
          disabled={readOnly || !listId || busy}
          onClick={() => { void deleteList() }}
        >
          <Trash2 size={13} />
        </IconButton>
        <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{tcf('cloudflare.network.redirects.search_hint')}</p>
      </div>
      <Panel title={tcf('cloudflare.network.redirects.items')} bodyClassName="p-0">
        {itemsLoading && items.length === 0 ? <LoadingBlock /> : visible.length === 0 ? (
          <PanelEmpty>{tcf('cloudflare.network.redirects.no_items')}</PanelEmpty>
        ) : (
          <>
            <TableScroll label={tcf('cloudflare.network.redirects.items')}>
              <Table>
                <THead><Tr>
                  <Th>{tcf('cloudflare.network.redirects.source')}</Th>
                  <Th>{tcf('cloudflare.network.redirects.target')}</Th>
                  <Th>{tcf('cloudflare.network.redirects.status_code')}</Th>
                  <Th>{tcf('cloudflare.network.redirects.flags')}</Th>
                </Tr></THead>
                <TBody>
                  {visible.map((item) => (
                    <Tr key={item.id}>
                      <Td className="max-w-72 truncate font-mono text-[length:var(--text-11-5)]" title={item.sourceUrl}>{item.sourceUrl}</Td>
                      <Td className="max-w-72 truncate font-mono text-[length:var(--text-11-5)]" title={item.targetUrl}>{item.targetUrl}</Td>
                      <Td className="tabular">{item.statusCode ?? '—'}</Td>
                      <Td>
                        <div className="flex flex-wrap gap-1">
                          {item.enabled ? null : <Badge tone="neutral">{tcf('cloudflare.network.disabled')}</Badge>}
                          {item.preserveQueryString ? <Badge tone="accent">{tcf('cloudflare.network.redirects.preserve_query')}</Badge> : null}
                          {item.includeSubdomains ? <Badge tone="accent">{tcf('cloudflare.network.redirects.include_subdomains')}</Badge> : null}
                        </div>
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </TableScroll>
            {cursor ? (
              <div className="flex justify-end px-3 py-2">
                <Button size="sm" variant="secondary" loading={itemsLoading} onClick={() => void loadMore()}>
                  {tcf('cloudflare.network.load_more')}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </Panel>

      <Modal
        open={listOpen}
        onClose={() => setListOpen(false)}
        title={tcf('cloudflare.network.redirects.new_list')}
        width={480}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setListOpen(false)}>{uiT('common.cancel')}</Button>
            <Button variant="primary" loading={busy} disabled={!listName.trim()} onClick={() => { void createList() }}>
              {tcf('cloudflare.network.redirects.new_list')}
            </Button>
          </>
        )}
      >
        <Field label={tcf('cloudflare.network.redirects.list_name')}>
          <Input value={listName} onChange={(event) => setListName(event.target.value)} />
        </Field>
      </Modal>

      <Modal
        open={itemOpen}
        onClose={() => setItemOpen(false)}
        title={tcf('cloudflare.network.redirects.add_item')}
        width={560}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setItemOpen(false)}>{uiT('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!sourceUrl.trim() || !targetUrl.trim()}
              onClick={() => { void createItem() }}
            >
              {tcf('cloudflare.network.redirects.add_item')}
            </Button>
          </>
        )}
      >
        <div className="space-y-3">
          <Field label={tcf('cloudflare.network.redirects.source_url')}>
            <Input
              value={sourceUrl}
              placeholder="https://example.com/old"
              className="font-mono text-[length:var(--text-11-5)]"
              onChange={(event) => setSourceUrl(event.target.value)}
            />
          </Field>
          <Field label={tcf('cloudflare.network.redirects.target_url')}>
            <Input
              value={targetUrl}
              placeholder="https://example.com/new"
              className="font-mono text-[length:var(--text-11-5)]"
              onChange={(event) => setTargetUrl(event.target.value)}
            />
          </Field>
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-32">
              <SelectMenu
                label={tcf('cloudflare.network.redirects.status_code')}
                value={statusCode}
                options={[
                  { value: '301', label: '301' },
                  { value: '302', label: '302' },
                  { value: '307', label: '307' },
                  { value: '308', label: '308' },
                ]}
                onChange={setStatusCode}
              />
            </div>
            <Checkbox checked={preserveQuery} onChange={setPreserveQuery} label={tcf('cloudflare.network.redirects.preserve_query')} />
            <Checkbox checked={includeSubdomains} onChange={setIncludeSubdomains} label={tcf('cloudflare.network.redirects.include_subdomains')} />
          </div>
        </div>
      </Modal>
    </div>
  )
}

function EmailRoutingPanel({ accountId, zoneId, readOnly }: { accountId: string; zoneId: string; readOnly: boolean }) {
  const tcf = useCfT()
  const toast = useUi((state) => state.toast)
  const { data, loading, error, reload } = useNetworkLoad(
    () => networkApi.emailRouting(accountId, zoneId),
    `${accountId}:${zoneId}:email`,
  )
  const [busy, setBusy] = useState(false)
  const [ruleOpen, setRuleOpen] = useState(false)
  const [ruleName, setRuleName] = useState('')
  const [recipient, setRecipient] = useState('')
  const [action, setAction] = useState<'drop' | 'forward'>('drop')
  const [destination, setDestination] = useState('')
  const [addressOpen, setAddressOpen] = useState(false)
  const [addressEmail, setAddressEmail] = useState('')

  async function toggleRouting(next: boolean): Promise<void> {
    const ok = await confirm({
      title: next ? tcf('cloudflare.network.email.enable') : tcf('cloudflare.network.email.disable'),
      description: next ? tcf('cloudflare.network.email.enable_confirm') : tcf('cloudflare.network.email.disable_confirm'),
      confirmLabel: next ? tcf('cloudflare.network.email.enable') : tcf('cloudflare.network.email.disable'),
      cancelLabel: uiT('common.cancel'),
      tone: next ? 'default' : 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      await networkApi.setEmailRoutingEnabled(accountId, zoneId, next)
      toast({
        title: next ? tcf('cloudflare.network.email.enable') : tcf('cloudflare.network.email.disable'),
        tone: 'success',
      })
      reload()
    } catch (failure) {
      toast({ title: cfErrorText(failure), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function createRule(): Promise<void> {
    setBusy(true)
    try {
      await networkApi.createEmailRule(accountId, zoneId, {
        name: ruleName.trim(),
        recipient: recipient.trim(),
        action,
        ...(action === 'forward' ? { destination: destination.trim() } : {}),
      })
      toast({ title: tcf('cloudflare.network.created'), tone: 'success' })
      setRuleOpen(false)
      setRecipient('')
      setDestination('')
      reload()
    } catch (failure) {
      toast({ title: cfErrorText(failure), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function createAddress(): Promise<void> {
    setBusy(true)
    try {
      await networkApi.createEmailAddress(accountId, addressEmail.trim())
      toast({ title: tcf('cloudflare.network.created'), tone: 'success' })
      setAddressOpen(false)
      setAddressEmail('')
      reload()
    } catch (failure) {
      toast({ title: cfErrorText(failure), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function removeRule(ruleId: string, name: string): Promise<void> {
    const ok = await confirm({
      title: uiT('common.delete'),
      description: tcf('cloudflare.network.delete_confirm', { name: name || ruleId }),
      confirmLabel: uiT('common.delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      await networkApi.deleteEmailRule(accountId, zoneId, ruleId)
      toast({ title: tcf('cloudflare.network.deleted'), tone: 'success' })
      reload()
    } catch (failure) {
      toast({ title: cfErrorText(failure), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function removeAddress(addressId: string, email: string): Promise<void> {
    const ok = await confirm({
      title: uiT('common.delete'),
      description: tcf('cloudflare.network.delete_confirm', { name: email }),
      confirmLabel: uiT('common.delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      await networkApi.deleteEmailAddress(accountId, addressId)
      toast({ title: tcf('cloudflare.network.deleted'), tone: 'success' })
      reload()
    } catch (failure) {
      toast({ title: cfErrorText(failure), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  if (!zoneId) return <Empty compact title={tcf('cloudflare.network.select_zone')} />
  if (loading) return <LoadingBlock />
  if (error || !data) return <PanelError message={error ?? '—'} onRetry={reload} />

  const routing = data as EmailRoutingResponse
  return (
    <div className="space-y-3">
      <Panel
        title={tcf('cloudflare.network.email.settings')}
        actions={(
          <Button
            size="sm"
            variant={routing.settings.enabled ? 'danger' : 'primary'}
            loading={busy}
            disabled={readOnly}
            onClick={() => { void toggleRouting(!routing.settings.enabled) }}
          >
            {routing.settings.enabled
              ? tcf('cloudflare.network.email.disable')
              : tcf('cloudflare.network.email.enable')}
          </Button>
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          <BadgeForEnabled enabled={routing.settings.enabled} />
          <Badge tone="neutral">{routing.settings.status || '—'}</Badge>
          <span className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{routing.zoneName}</span>
        </div>
      </Panel>
      <Panel
        title={tcf('cloudflare.network.email.rules')}
        bodyClassName="p-0"
        actions={(
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus size={13} />}
            disabled={readOnly}
            onClick={() => setRuleOpen(true)}
          >
            {tcf('cloudflare.network.email.add_rule')}
          </Button>
        )}
      >
        {routing.rules.length === 0 ? <PanelEmpty>{tcf('cloudflare.network.email.no_rules')}</PanelEmpty> : (
          <TableScroll label={tcf('cloudflare.network.email.rules')}>
            <Table>
              <THead><Tr>
                <Th>{tcf('cloudflare.network.email.name')}</Th>
                <Th>{tcf('cloudflare.network.email.matchers')}</Th>
                <Th>{tcf('cloudflare.network.email.actions')}</Th>
                <Th>{tcf('cloudflare.network.status')}</Th>
                <Th>{tcf('cloudflare.network.actions')}</Th>
              </Tr></THead>
              <TBody>
                {routing.rules.map((rule) => (
                  <Tr key={rule.id}>
                    <Td className="font-medium">{rule.name || rule.id}</Td>
                    <Td className="max-w-64 truncate text-[var(--text-secondary)]">
                      {rule.matchers.map((matcher) => `${matcher.type}:${matcher.field}:${matcher.value}`).join(' · ') || '—'}
                    </Td>
                    <Td className="max-w-56 truncate text-[var(--text-secondary)]">
                      {rule.actions.map((action) => `${action.type}${action.value.length ? `: ${action.value.join(', ')}` : ''}`).join(' · ') || '—'}
                    </Td>
                    <Td><BadgeForEnabled enabled={rule.enabled} /></Td>
                    <Td>
                      <IconButton
                        label={uiT('common.delete')}
                        size="xs"
                        disabled={readOnly || busy}
                        onClick={() => { void removeRule(rule.id, rule.name) }}
                      >
                        <Trash2 size={13} />
                      </IconButton>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableScroll>
        )}
      </Panel>
      <Panel
        title={tcf('cloudflare.network.email.destinations')}
        bodyClassName="p-0"
        actions={(
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus size={13} />}
            disabled={readOnly}
            onClick={() => setAddressOpen(true)}
          >
            {tcf('cloudflare.network.email.add_address')}
          </Button>
        )}
      >
        {routing.addresses.length === 0 ? <PanelEmpty>{tcf('cloudflare.network.email.no_destinations')}</PanelEmpty> : (
          <TableScroll label={tcf('cloudflare.network.email.destinations')}>
            <Table>
              <THead><Tr>
                <Th>{tcf('cloudflare.network.email.address')}</Th>
                <Th>{tcf('cloudflare.network.email.verified')}</Th>
                <Th>{tcf('cloudflare.network.actions')}</Th>
              </Tr></THead>
              <TBody>
                {routing.addresses.map((address) => (
                  <Tr key={address.id}>
                    <Td className="font-mono text-[length:var(--text-11-5)]">{address.email}</Td>
                    <Td><BadgeForEnabled enabled={address.verified} /></Td>
                    <Td>
                      <IconButton
                        label={uiT('common.delete')}
                        size="xs"
                        disabled={readOnly || busy}
                        onClick={() => { void removeAddress(address.id, address.email) }}
                      >
                        <Trash2 size={13} />
                      </IconButton>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableScroll>
        )}
      </Panel>

      <Modal
        open={ruleOpen}
        onClose={() => setRuleOpen(false)}
        title={tcf('cloudflare.network.email.add_rule')}
        width={560}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setRuleOpen(false)}>{uiT('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!recipient.trim() || (action === 'forward' && !destination.trim())}
              onClick={() => { void createRule() }}
            >
              {tcf('cloudflare.network.email.add_rule')}
            </Button>
          </>
        )}
      >
        <div className="space-y-3">
          <Field label={tcf('cloudflare.network.email.rule_name')}>
            <Input value={ruleName} onChange={(event) => setRuleName(event.target.value)} />
          </Field>
          <Field label={tcf('cloudflare.network.email.recipient')}>
            <Input
              value={recipient}
              placeholder={tcf('cloudflare.network.email.recipient_placeholder')}
              className="font-mono text-[length:var(--text-11-5)]"
              onChange={(event) => setRecipient(event.target.value)}
            />
          </Field>
          <div>
            <p className="mb-1.5 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
              {tcf('cloudflare.network.email.action')}
            </p>
            <SelectMenu
              label={tcf('cloudflare.network.email.action')}
              value={action}
              options={[
                { value: 'drop', label: tcf('cloudflare.network.email.action_drop') },
                { value: 'forward', label: tcf('cloudflare.network.email.action_forward') },
              ]}
              onChange={setAction}
            />
          </div>
          {action === 'forward' ? (
            <Field label={tcf('cloudflare.network.email.destination')}>
              <Input
                value={destination}
                className="font-mono text-[length:var(--text-11-5)]"
                onChange={(event) => setDestination(event.target.value)}
              />
            </Field>
          ) : null}
        </div>
      </Modal>

      <Modal
        open={addressOpen}
        onClose={() => setAddressOpen(false)}
        title={tcf('cloudflare.network.email.add_address')}
        width={460}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setAddressOpen(false)}>{uiT('common.cancel')}</Button>
            <Button variant="primary" loading={busy} disabled={!addressEmail.trim()} onClick={() => { void createAddress() }}>
              {tcf('cloudflare.network.email.add_address')}
            </Button>
          </>
        )}
      >
        <Field label={tcf('cloudflare.network.email.address')}>
          <Input
            value={addressEmail}
            className="font-mono text-[length:var(--text-11-5)]"
            onChange={(event) => setAddressEmail(event.target.value)}
          />
        </Field>
      </Modal>
    </div>
  )
}

function SnippetsPanel({ accountId, zoneId, readOnly }: { accountId: string; zoneId: string; readOnly: boolean }) {
  const tcf = useCfT()
  const toast = useUi((state) => state.toast)
  const { data, loading, error, reload } = useNetworkLoad(
    () => networkApi.snippets(accountId, zoneId),
    `${accountId}:${zoneId}:snippets`,
  )
  const [busy, setBusy] = useState(false)
  const [snippetOpen, setSnippetOpen] = useState(false)
  const [name, setName] = useState('')
  const [content, setContent] = useState(DEFAULT_SNIPPET)
  const [expression, setExpression] = useState('')
  const [description, setDescription] = useState('')

  async function createSnippet(): Promise<void> {
    setBusy(true)
    try {
      await networkApi.createSnippet(accountId, zoneId, {
        name: name.trim(),
        content,
        ...(expression.trim() ? { expression: expression.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      })
      toast({ title: tcf('cloudflare.network.created'), tone: 'success' })
      setSnippetOpen(false)
      setName('')
      setExpression('')
      setDescription('')
      reload()
    } catch (reason) {
      toast({ title: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function removeSnippet(snippetName: string): Promise<void> {
    const ok = await confirm({
      title: uiT('common.delete'),
      description: tcf('cloudflare.network.delete_confirm', { name: snippetName }),
      confirmLabel: uiT('common.delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      await networkApi.deleteSnippet(accountId, zoneId, snippetName)
      toast({ title: tcf('cloudflare.network.deleted'), tone: 'success' })
      reload()
    } catch (reason) {
      toast({ title: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function removeRule(ruleId: string): Promise<void> {
    const ok = await confirm({
      title: uiT('common.delete'),
      description: tcf('cloudflare.network.delete_confirm', { name: ruleId }),
      confirmLabel: uiT('common.delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      await networkApi.deleteSnippetRule(accountId, zoneId, ruleId)
      toast({ title: tcf('cloudflare.network.deleted'), tone: 'success' })
      reload()
    } catch (reason) {
      toast({ title: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }
  if (!zoneId) return <Empty compact title={tcf('cloudflare.network.select_zone')} />
  if (loading) return <LoadingBlock />
  if (error || !data) return <PanelError message={error ?? '—'} onRetry={reload} />

  const snippets = data as SnippetsResponse
  if (!snippets.supported) {
    return (
      <Panel title={tcf('cloudflare.network.snippets.title')}>
        <div className="space-y-2">
          <PanelEmpty>{tcf('cloudflare.network.snippets.unsupported')}</PanelEmpty>
          {snippets.reason ? <p className="text-center text-[length:var(--text-11)] text-[var(--text-tertiary)]">{snippets.reason}</p> : null}
        </div>
      </Panel>
    )
  }

  return (
    <div className="space-y-3">
      <Panel
        title={tcf('cloudflare.network.snippets.list')}
        bodyClassName="p-0"
        actions={(
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus size={13} />}
            disabled={readOnly}
            onClick={() => setSnippetOpen(true)}
          >
            {tcf('cloudflare.network.snippets.add')}
          </Button>
        )}
      >
        {snippets.snippets.length === 0 ? <PanelEmpty>{tcf('cloudflare.network.snippets.no_snippets')}</PanelEmpty> : (
          <TableScroll label={tcf('cloudflare.network.snippets.list')}>
            <Table>
              <THead><Tr>
                <Th>{tcf('cloudflare.network.lb.name')}</Th>
                <Th>{tcf('cloudflare.network.snippets.modified')}</Th>
                <Th>{tcf('cloudflare.network.actions')}</Th>
              </Tr></THead>
              <TBody>
                {snippets.snippets.map((snippet) => (
                  <Tr key={snippet.id}>
                    <Td className="font-mono text-[length:var(--text-11-5)]">{snippet.name || snippet.id}</Td>
                    <Td className="whitespace-nowrap text-[var(--text-tertiary)]">{snippet.modifiedOn || '—'}</Td>
                    <Td>
                      <IconButton
                        label={uiT('common.delete')}
                        size="xs"
                        disabled={readOnly || busy}
                        onClick={() => { void removeSnippet(snippet.name || snippet.id) }}
                      >
                        <Trash2 size={13} />
                      </IconButton>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableScroll>
        )}
      </Panel>
      <Panel title={tcf('cloudflare.network.snippets.rules')} bodyClassName="p-0">
        {snippets.rules.length === 0 ? <PanelEmpty>{tcf('cloudflare.network.snippets.no_rules')}</PanelEmpty> : (
          <TableScroll label={tcf('cloudflare.network.snippets.rules')}>
            <Table>
              <THead><Tr>
                <Th>{tcf('cloudflare.network.snippets.snippet')}</Th>
                <Th>{tcf('cloudflare.network.snippets.phase')}</Th>
                <Th>{tcf('cloudflare.network.snippets.expression')}</Th>
                <Th>{tcf('cloudflare.network.status')}</Th>
                <Th>{tcf('cloudflare.network.actions')}</Th>
              </Tr></THead>
              <TBody>
                {snippets.rules.map((rule) => (
                  <Tr key={rule.id}>
                    <Td className="font-mono text-[length:var(--text-11-5)]">{rule.snippetName || rule.id}</Td>
                    <Td>{rule.phase || '—'}</Td>
                    <Td className="max-w-80 truncate font-mono text-[length:var(--text-11-5)]" title={rule.expression}>{rule.expression || '—'}</Td>
                    <Td><BadgeForEnabled enabled={rule.enabled} /></Td>
                    <Td>
                      <IconButton
                        label={uiT('common.delete')}
                        size="xs"
                        disabled={readOnly || busy}
                        onClick={() => { void removeRule(rule.id) }}
                      >
                        <Trash2 size={13} />
                      </IconButton>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableScroll>
        )}
      </Panel>

      <Modal
        open={snippetOpen}
        onClose={() => setSnippetOpen(false)}
        title={tcf('cloudflare.network.snippets.add')}
        width={680}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setSnippetOpen(false)}>{uiT('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!name.trim() || !content.trim()}
              onClick={() => { void createSnippet() }}
            >
              {tcf('cloudflare.network.snippets.add')}
            </Button>
          </>
        )}
      >
        <div className="space-y-3">
          <Field label={tcf('cloudflare.network.snippets.name')}>
            <Input
              value={name}
              className="font-mono text-[length:var(--text-11-5)]"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label={tcf('cloudflare.network.snippets.content')}>
            <Textarea
              value={content}
              rows={8}
              className="font-mono text-[length:var(--text-11-5)]"
              onChange={(event) => setContent(event.target.value)}
            />
          </Field>
          <Field label={tcf('cloudflare.network.snippets.expression')}>
            <Input
              value={expression}
              className="font-mono text-[length:var(--text-11-5)]"
              onChange={(event) => setExpression(event.target.value)}
            />
          </Field>
          <Field label={tcf('cloudflare.network.snippets.description')}>
            <Input value={description} onChange={(event) => setDescription(event.target.value)} />
          </Field>
        </div>
      </Modal>
    </div>
  )
}

function useNetworkLoad<T>(loader: () => Promise<T>, key: string) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    loader()
      .then((value) => { if (!cancelled) setData(value) })
      .catch((reason: unknown) => { if (!cancelled) setError(cfErrorText(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [key, nonce])
  return { data, loading, error, reload: () => setNonce((value) => value + 1) }
}

export function NetworkScreen() {
  const tcf = useCfT()
  const [accounts, setAccounts] = useState<CloudflareAccount[]>([])
  const [accountId, setAccountId] = useState('')
  const [zones, setZones] = useState<Array<{ id: string; name: string }>>([])
  const [zoneId, setZoneId] = useState('')
  const [tab, setTab] = useState<NetworkTab>('load-balancing')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadAccounts, setReloadAccounts] = useState(0)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void accountsApi.list({ pageSize: 100, filter: 'active' })
      .then((body) => {
        if (cancelled) return
        setAccounts(body.accounts)
        setAccountId((current) => current || body.accounts[0]?.id || '')
      })
      .catch((failure: unknown) => { if (!cancelled) setError(cfErrorText(failure)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [reloadAccounts])

  useEffect(() => {
    if (!accountId) return
    let cancelled = false
    void getDashboardZones(accountId)
      .then((body) => {
        if (cancelled) return
        setZones(body.zones)
        setZoneId((current) => body.zones.some((zone) => zone.id === current) ? current : body.zones[0]?.id ?? '')
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(cfErrorText(failure))
      })
    return () => { cancelled = true }
  }, [accountId])

  if (loading) return <div className="flex h-full items-center justify-center"><LoadingBlock /></div>
  if (error) return <div className="p-3"><PanelError message={error} onRetry={() => setReloadAccounts((value) => value + 1)} /></div>

  const accountOptions = accounts.map((account) => ({ value: account.id, label: account.name }))
  const zoneOptions = zones.map((zone) => ({ value: zone.id, label: zone.name }))
  const readOnly = accounts.find((account) => account.id === accountId)?.is_demo ?? false

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]">
          {tcf('cloudflare.network.title')}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <SelectMenu
            label={tcf('cloudflare.network.account')}
            value={accountId}
            options={accountOptions}
            onChange={setAccountId}
            size="sm"
            width={170}
            className="w-40"
          />
          <SelectMenu
            label={tcf('cloudflare.network.zone')}
            value={zoneId}
            options={zoneOptions}
            onChange={setZoneId}
            size="sm"
            width={190}
            className="w-44"
          />
          <Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} onClick={() => setRefreshKey((value) => value + 1)}>
            {uiT('common.refresh')}
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap gap-1">
        {TABS.map((item) => (
          <Button
            key={item.value}
            size="sm"
            variant={tab === item.value ? 'primary' : 'secondary'}
            onClick={() => setTab(item.value)}
          >
            {tcf(item.labelKey)}
          </Button>
        ))}
      </div>

      <div key={`${tab}:${accountId}:${zoneId}:${refreshKey}`}>
        {tab === 'load-balancing' ? <LoadBalancingPanel accountId={accountId} zoneId={zoneId} readOnly={readOnly} /> : null}
        {tab === 'bulk-redirects' ? <BulkRedirectsPanel accountId={accountId} readOnly={readOnly} /> : null}
        {tab === 'email-routing' ? <EmailRoutingPanel accountId={accountId} zoneId={zoneId} readOnly={readOnly} /> : null}
        {tab === 'snippets' ? <SnippetsPanel accountId={accountId} zoneId={zoneId} readOnly={readOnly} /> : null}
      </div>
    </div>
  )
}
