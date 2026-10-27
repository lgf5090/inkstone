/**
 * Tunnels: the tunnels themselves, their ingress configuration, the one-step origin wizard, and the
 * zone rulesets that sit in front of them.
 *
 * A tunnel is a connector a reader runs on their own machine; this screen can create it, hand over the
 * token and describe where traffic should go, but it cannot run `cloudflared`. The configuration editor
 * is therefore the important half: the ingress list is what the connector reads on connect, and the
 * catch-all rule has to stay last or Cloudflare refuses the configuration.
 */
import { useEffect, useMemo, useState } from 'react'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Badge, Button, IconButton } from '../../../components/primitives'
import { Field, Input, Segmented, Switch, Textarea } from '../../../components/form'
import { SelectMenu } from '../../../components/select-menu'
import { Modal, confirm } from '../../../components/overlay'
import { LoadingBlock, Empty } from '../../../components/feedback'
import { TBody, THead, Table, TableScroll, Td, Th, Tr } from '../components/Table'
import { CopyButton } from '../components/CopyButton'
import { useCfT } from '../i18n'
import { useUi } from '../../../store/ui'
import { cfErrorText } from '../api/client'
import {
  INGRESS_PROTOCOLS,
  RULE_PHASES,
  WIZARD_PROTOCOLS,
  tunnelsApi,
  type IngressProtocol,
  type IngressRule,
  type RuleInput,
  type RulePhase,
  type Tunnel,
  type TunnelAccount,
  type TunnelConnection,
  type TunnelRule,
  type TunnelZone,
  type WizardProtocol,
  type WizardResult,
} from '../api/tunnels'

const CATCH_ALL = 'http_status:404'

type Tab = 'tunnels' | 'rules'

function statusTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  const value = status.toLowerCase()
  if (value === 'healthy' || value === 'active') return 'success'
  if (value === 'degraded' || value === 'inactive') return 'warning'
  if (value === 'down' || value === 'error') return 'danger'
  return 'neutral'
}

function splitService(service: string): { protocol: IngressProtocol; target: string } {
  const match = /^([a-z]+):\/\/(.*)$/i.exec(service)
  if (!match) return { protocol: 'custom', target: service }
  const protocol = INGRESS_PROTOCOLS.includes(match[1]!.toLowerCase() as IngressProtocol)
    ? match[1]!.toLowerCase() as IngressProtocol
    : 'custom'
  return { protocol, target: match[2] ?? '' }
}

export function TunnelsScreen() {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const [tab, setTab] = useState<Tab>('tunnels')
  const [accounts, setAccounts] = useState<TunnelAccount[]>([])
  const [accountId, setAccountId] = useState('')
  const [tunnels, setTunnels] = useState<Tunnel[]>([])
  const [zones, setZones] = useState<TunnelZone[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)

  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  const [tokenFor, setTokenFor] = useState<Tunnel | null>(null)
  const [token, setToken] = useState('')
  const [connectionsFor, setConnectionsFor] = useState<Tunnel | null>(null)
  const [connections, setConnections] = useState<TunnelConnection[]>([])

  const [configFor, setConfigFor] = useState<Tunnel | null>(null)
  const [ingress, setIngress] = useState<IngressRule[]>([])

  const [wizardOpen, setWizardOpen] = useState(false)
  const [wizardResult, setWizardResult] = useState<WizardResult | null>(null)

  const [zoneId, setZoneId] = useState('')
  const [phase, setPhase] = useState<RulePhase>('origin')
  const [rules, setRules] = useState<TunnelRule[]>([])
  const [ruleEditing, setRuleEditing] = useState<TunnelRule | 'new' | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await tunnelsApi.accounts()
        if (cancelled) return
        setAccounts(list)
        setAccountId((current) => current || list[0]?.id || '')
      } catch (failure) {
        if (!cancelled) setError(cfErrorText(failure))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!accountId) return
    let cancelled = false
    setLoading(true)
    setError('')
    void (async () => {
      try {
        const [tunnelList, zoneList] = await Promise.all([
          tunnelsApi.list(accountId),
          tunnelsApi.zones(accountId),
        ])
        if (cancelled) return
        setTunnels(tunnelList)
        setZones(zoneList)
        setZoneId((current) => current || zoneList[0]?.id || '')
      } catch (failure) {
        if (!cancelled) setError(cfErrorText(failure))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [accountId, refreshKey])

  useEffect(() => {
    if (!accountId || !zoneId) { setRules([]); return }
    let cancelled = false
    void (async () => {
      try {
        const result = await tunnelsApi.rules.list(accountId, zoneId, phase)
        if (!cancelled) setRules(result.rules)
      } catch (failure) {
        if (!cancelled) toast({ title: cfErrorText(failure), tone: 'danger' })
      }
    })()
    return () => { cancelled = true }
  }, [accountId, zoneId, phase, refreshKey, toast])

  const accountOptions = useMemo(
    () => accounts.map((account) => ({ value: account.id, label: account.name })),
    [accounts],
  )

  async function createTunnel(): Promise<void> {
    if (!accountId || !newName.trim()) return
    setBusy(true)
    try {
      await tunnelsApi.create(accountId, newName.trim())
      toast({ title: t('cloudflare.tunnels.msg.tunnel_created'), tone: 'success' })
      setCreating(false)
      setNewName('')
      setRefreshKey((value) => value + 1)
    } catch (failure) {
      toast({ title: cfErrorText(failure), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function removeTunnel(tunnel: Tunnel): Promise<void> {
    const ok = await confirm({
      title: t('cloudflare.tunnels.table.delete_confirm', { name: tunnel.name }),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await tunnelsApi.remove(accountId, tunnel.id)
      toast({ title: t('cloudflare.tunnels.msg.tunnel_deleted'), tone: 'success' })
      setRefreshKey((value) => value + 1)
    } catch (failure) {
      toast({ title: cfErrorText(failure), tone: 'danger' })
    }
  }

  async function openToken(tunnel: Tunnel): Promise<void> {
    setTokenFor(tunnel)
    setToken('')
    try {
      const result = await tunnelsApi.token(accountId, tunnel.id)
      setToken(result.token)
    } catch (failure) {
      toast({ title: cfErrorText(failure), tone: 'danger' })
      setTokenFor(null)
    }
  }

  async function openConnections(tunnel: Tunnel): Promise<void> {
    setConnectionsFor(tunnel)
    setConnections([])
    try {
      setConnections(await tunnelsApi.connections(accountId, tunnel.id))
    } catch (failure) {
      toast({ title: cfErrorText(failure), tone: 'danger' })
    }
  }

  async function openConfig(tunnel: Tunnel): Promise<void> {
    setConfigFor(tunnel)
    setIngress([])
    try {
      const result = await tunnelsApi.config(accountId, tunnel.id)
      setIngress(result.ingress.length > 0 ? result.ingress : [{ service: CATCH_ALL }])
    } catch (failure) {
      toast({ title: cfErrorText(failure), tone: 'danger' })
    }
  }

  async function saveConfig(): Promise<void> {
    if (!configFor) return
    setBusy(true)
    try {
      const result = await tunnelsApi.saveConfig(accountId, configFor.id, ingress)
      setIngress(result.ingress)
      toast({ title: t('cloudflare.tunnels.msg.config_saved'), tone: 'success' })
    } catch (failure) {
      toast({ title: cfErrorText(failure), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function removeRule(rule: TunnelRule): Promise<void> {
    if (!rule.id) return
    const ok = await confirm({
      title: t('cloudflare.tunnels.table.rule_delete_confirm', { name: rule.description ?? rule.expression }),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await tunnelsApi.rules.remove(accountId, zoneId, phase, rule.id)
      toast({ title: t('cloudflare.tunnels.msg.rule_deleted'), tone: 'success' })
      setRefreshKey((value) => value + 1)
    } catch (failure) {
      toast({ title: cfErrorText(failure), tone: 'danger' })
    }
  }

  if (loading && accounts.length === 0) {
    return <div className="flex h-full items-center justify-center"><LoadingBlock /></div>
  }
  if (error && accounts.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-[length:var(--text-13)] text-[var(--text-secondary)]">{error}</p>
        <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={() => setRefreshKey((value) => value + 1)}>
          {t('common.retry')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-[length:var(--text-17)] font-semibold text-[var(--text-primary)]">
            {t('cloudflare.tunnels.tunnel_management')}
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <SelectMenu
              label={t('cloudflare.tunnels.select_account')}
              value={accountId}
              onChange={setAccountId}
              options={accountOptions}
              placeholder={t('cloudflare.tunnels.select_account')}
              size="sm"
            />
            <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={() => setRefreshKey((value) => value + 1)}>
              {t('common.refresh')}
            </Button>
          </div>
        </div>

        <Segmented
          label={t('cloudflare.tunnels.tunnel_management')}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'tunnels', label: t('cloudflare.tunnels.tunnel_management') },
            { value: 'rules', label: t('cloudflare.tunnels.rules_engine') },
          ]}
        />

        {tab === 'tunnels' ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" icon={<Plus size={14} />} onClick={() => setCreating(true)} disabled={!accountId}>
                {t('cloudflare.tunnels.create_tunnel')}
              </Button>
              <Button variant="secondary" onClick={() => setWizardOpen(true)} disabled={!accountId}>
                {t('cloudflare.tunnels.wizard')}
              </Button>
            </div>
            {tunnels.length === 0 ? <Empty title={t('cloudflare.tunnels.no_tunnel', {})} /> : (
              <TableScroll label={t('cloudflare.tunnels.tunnel_management')}>
                <Table>
                  <THead>
                    <tr>
                      <Th>{t('cloudflare.tunnels.table.name')}</Th>
                      <Th>{t('cloudflare.tunnels.table.id')}</Th>
                      <Th>{t('cloudflare.tunnels.table.status')}</Th>
                      <Th>{t('cloudflare.tunnels.table.connections')}</Th>
                      <Th>{t('cloudflare.tunnels.table.actions')}</Th>
                    </tr>
                  </THead>
                  <TBody>
                    {tunnels.map((tunnel) => (
                      <Tr key={tunnel.id}>
                        <Td className="max-w-48 truncate">{tunnel.name}</Td>
                        <Td className="max-w-40 truncate font-mono text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{tunnel.id}</Td>
                        <Td><Badge tone={statusTone(tunnel.status)}>{tunnel.status}</Badge></Td>
                        <Td className="tabular-nums">{tunnel.connections.length}</Td>
                        <Td>
                          <div className="flex flex-wrap items-center gap-1">
                            <Button size="sm" variant="ghost" onClick={() => void openToken(tunnel)}>{t('cloudflare.tunnels.table.token')}</Button>
                            <Button size="sm" variant="ghost" onClick={() => void openConfig(tunnel)}>{t('cloudflare.tunnels.table.config')}</Button>
                            <Button size="sm" variant="ghost" onClick={() => void openConnections(tunnel)}>{t('cloudflare.tunnels.table.connections')}</Button>
                            <IconButton label={t('common.delete')} size="sm" variant="ghost" onClick={() => void removeTunnel(tunnel)}>
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
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <SelectMenu
                label={t('cloudflare.tunnels.domain')}
                value={zoneId}
                onChange={setZoneId}
                options={zones.map((zone) => ({ value: zone.id, label: zone.name }))}
                placeholder={t('cloudflare.tunnels.select_domain')}
                size="sm"
              />
              <SelectMenu
                label={t('cloudflare.tunnels.rule_phase')}
                value={phase}
                onChange={setPhase}
                options={RULE_PHASES.map((value) => ({ value, label: t(`cloudflare.tunnels.rule_phases.${value}`) }))}
                size="sm"
              />
              <Button variant="secondary" icon={<Plus size={14} />} onClick={() => setRuleEditing('new')} disabled={!zoneId}>
                {t('cloudflare.tunnels.add_rule')}
              </Button>
            </div>
            {rules.length === 0 ? <Empty title={t('cloudflare.tunnels.no_rules', {})} /> : (
              <TableScroll label={t('cloudflare.tunnels.rules_engine')}>
                <Table>
                  <THead>
                    <tr>
                      <Th>{t('cloudflare.tunnels.table.description')}</Th>
                      <Th>{t('cloudflare.tunnels.table.expression')}</Th>
                      <Th>{t('cloudflare.tunnels.table.action')}</Th>
                      <Th>{t('cloudflare.tunnels.table.enabled')}</Th>
                      <Th>{t('cloudflare.tunnels.table.actions')}</Th>
                    </tr>
                  </THead>
                  <TBody>
                    {rules.map((rule) => (
                      <Tr key={rule.id ?? rule.expression}>
                        <Td className="max-w-40 truncate">{rule.description || '—'}</Td>
                        <Td className="max-w-72 truncate font-mono text-[length:var(--text-11-5)]">{rule.expression}</Td>
                        <Td>{rule.action}</Td>
                        <Td><Badge tone={rule.enabled === false ? 'neutral' : 'success'}>{rule.enabled === false ? t('cloudflare.settings.disabled') : t('cloudflare.settings.enabled')}</Badge></Td>
                        <Td>
                          <div className="flex items-center gap-1">
                            <Button size="sm" variant="ghost" onClick={() => setRuleEditing(rule)}>{t('common.edit')}</Button>
                            <IconButton label={t('common.delete')} size="sm" variant="ghost" onClick={() => void removeRule(rule)}>
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
          </>
        )}
      </div>

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title={t('cloudflare.tunnels.create_tunnel_title')}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={busy} onClick={() => void createTunnel()}>{t('cloudflare.tunnels.create_tunnel')}</Button>
          </>
        )}
      >
        <Field label={t('cloudflare.tunnels.tunnel_name')} required>
          <Input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder={t('cloudflare.tunnels.tunnel_name_placeholder')} />
        </Field>
      </Modal>

      <Modal open={tokenFor !== null} onClose={() => setTokenFor(null)} title={t('cloudflare.tunnels.token_title')}>
        <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('cloudflare.tunnels.token_hint')}</p>
        <div className="mt-3 flex items-start gap-2">
          <Textarea readOnly value={token} rows={4} aria-label={t('cloudflare.tunnels.token_title')} />
          <CopyButton text={token} label={t('cloudflare.tunnels.copy_token')} />
        </div>
      </Modal>

      <Modal open={connectionsFor !== null} onClose={() => setConnectionsFor(null)} title={t('cloudflare.tunnels.connections_title')} width={640}>
        {connections.length === 0
          ? <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('cloudflare.tunnels.no_connections', {})}</p>
          : (
            <TableScroll label={t('cloudflare.tunnels.connections_title')}>
              <Table>
                <THead><tr><Th>{t('cloudflare.tunnels.table.colo')}</Th><Th>{t('cloudflare.tunnels.table.version')}</Th><Th>{t('cloudflare.tunnels.table.ip')}</Th></tr></THead>
                <TBody>
                  {connections.map((connection) => (
                    <Tr key={connection.id}>
                      <Td>{connection.colo_name}</Td>
                      <Td>{connection.version}</Td>
                      <Td className="font-mono text-[length:var(--text-11-5)]">{connection.ip}</Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </TableScroll>
          )}
      </Modal>

      <Modal
        open={configFor !== null}
        onClose={() => setConfigFor(null)}
        title={t('cloudflare.tunnels.config_title', { name: configFor?.name ?? '' })}
        width={720}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setConfigFor(null)}>{t('common.close')}</Button>
            <Button variant="primary" loading={busy} onClick={() => void saveConfig()}>{t('cloudflare.tunnels.save_config')}</Button>
          </>
        )}
      >
        <p className="mb-3 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('cloudflare.tunnels.config_hint')}</p>
        <div className="flex flex-col gap-2">
          {ingress.map((rule, index) => {
            const last = index === ingress.length - 1
            const { protocol, target } = splitService(rule.service)
            const custom = protocol === 'custom'
            return (
              <div key={index} className="grid gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2 md:grid-cols-[1fr_1fr_auto]">
                <Input
                  value={rule.hostname ?? ''}
                  aria-label={t('cloudflare.tunnels.domain_placeholder')}
                  placeholder={t('cloudflare.tunnels.domain_placeholder')}
                  onChange={(event) => {
                    setIngress((rows) => rows.map((row, at) => at === index ? { ...row, hostname: event.target.value } : row))
                  }}
                />
                <div className="flex gap-1">
                  <SelectMenu
                    label={t('cloudflare.tunnels.protocol')}
                    value={protocol}
                    onChange={(value) => {
                      setIngress((rows) => rows.map((row, at) => at === index
                        ? { ...row, service: value === 'custom' ? target : `${value}://${target}` }
                        : row))
                    }}
                    options={INGRESS_PROTOCOLS.map((value) => ({ value, label: value }))}
                    size="sm"
                  />
                  <Input
                    value={target}
                    aria-label={t('cloudflare.tunnels.custom_service')}
                    placeholder={t('cloudflare.tunnels.custom_service')}
                    onChange={(event) => {
                      setIngress((rows) => rows.map((row, at) => at === index
                        ? { ...row, service: custom ? event.target.value : `${protocol}://${event.target.value}` }
                        : row))
                    }}
                  />
                </div>
                <IconButton
                  label={t('common.delete')}
                  size="sm"
                  variant="ghost"
                  disabled={last}
                  onClick={() => setIngress((rows) => rows.filter((_row, at) => at !== index))}
                >
                  <Trash2 size={13} />
                </IconButton>
                {last && <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)] md:col-span-3">{CATCH_ALL}</p>}
              </div>
            )
          })}
          <Button
            variant="secondary"
            icon={<Plus size={14} />}
            onClick={() => setIngress((rows) => {
              const catchAll = rows.filter((row) => row.service === CATCH_ALL)
              const others = rows.filter((row) => row.service !== CATCH_ALL)
              return [...others, { hostname: '', service: 'http://' }, ...catchAll]
            })}
          >
            {t('cloudflare.tunnels.add_rule')}
          </Button>
        </div>
      </Modal>

      <WizardDialog
        open={wizardOpen}
        accountId={accountId}
        zones={zones}
        tunnels={tunnels}
        onClose={() => setWizardOpen(false)}
        onDone={(result) => {
          setWizardOpen(false)
          setWizardResult(result)
          setRefreshKey((value) => value + 1)
        }}
      />

      <Modal open={wizardResult !== null} onClose={() => setWizardResult(null)} title={t('cloudflare.tunnels.wizard_result_title')}>
        <dl className="grid gap-2 text-[length:var(--text-12-5)]">
          <div className="flex justify-between gap-3"><dt className="text-[var(--text-tertiary)]">{t('cloudflare.tunnels.tunnel_id')}</dt><dd className="font-mono">{wizardResult?.tunnelId}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-[var(--text-tertiary)]">{t('cloudflare.tunnels.cname_target')}</dt><dd className="font-mono">{wizardResult?.cnameTarget}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-[var(--text-tertiary)]">{t('cloudflare.tunnels.hostname')}</dt><dd className="font-mono">{wizardResult?.hostname}</dd></div>
        </dl>
        <p className="mt-3 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {wizardResult?.mode === 'create' ? t('cloudflare.tunnels.wizard_create_hint') : t('cloudflare.tunnels.wizard_reuse_hint')}
        </p>
      </Modal>

      {ruleEditing && (
        <RuleDialog
          accountId={accountId}
          zoneId={zoneId}
          phase={phase}
          rule={ruleEditing === 'new' ? null : ruleEditing}
          onClose={() => setRuleEditing(null)}
          onSaved={() => { setRuleEditing(null); setRefreshKey((value) => value + 1) }}
        />
      )}
    </div>
  )
}

function WizardDialog({
  open,
  accountId,
  zones,
  tunnels,
  onClose,
  onDone,
}: {
  open: boolean
  accountId: string
  zones: TunnelZone[]
  tunnels: Tunnel[]
  onClose: () => void
  onDone: (result: WizardResult) => void
}) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const [mode, setMode] = useState<'create' | 'reuse'>('create')
  const [tunnelId, setTunnelId] = useState('')
  const [tunnelName, setTunnelName] = useState('')
  const [subdomain, setSubdomain] = useState('')
  const [domain, setDomain] = useState(zones[0]?.name ?? '')
  const [protocol, setProtocol] = useState<WizardProtocol>('http')
  const [port, setPort] = useState('80')
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => { if (!domain && zones[0]) setDomain(zones[0].name) }, [zones, domain])

  async function run(): Promise<void> {
    const hostname = subdomain.trim() ? `${subdomain.trim()}.${domain}` : domain
    if (!hostname || !domain) {
      toast({ title: t('cloudflare.settings.msg.info_required'), tone: 'warning' })
      return
    }
    setBusy(true)
    try {
      const result = await tunnelsApi.wizard(accountId, {
        mode,
        ...(mode === 'reuse' ? { tunnelId } : { tunnelName: tunnelName.trim() || undefined }),
        hostname,
        protocol,
        port: Number(port) || 80,
        ...(path.trim() ? { path: path.trim() } : {}),
      })
      toast({ title: t('cloudflare.tunnels.msg.wizard_success'), tone: 'success' })
      onDone(result)
    } catch (failure) {
      toast({ title: cfErrorText(failure), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('cloudflare.tunnels.wizard_title')}
      width={620}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} onClick={() => void run()}>{t('cloudflare.tunnels.execute')}</Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        <Segmented
          label={t('cloudflare.tunnels.mode')}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'create', label: t('cloudflare.tunnels.mode_create') },
            { value: 'reuse', label: t('cloudflare.tunnels.mode_reuse') },
          ]}
        />
        {mode === 'create' ? (
          <Field label={t('cloudflare.tunnels.wizard_tunnel_name')}>
            <Input value={tunnelName} onChange={(event) => setTunnelName(event.target.value)} placeholder={t('cloudflare.tunnels.wizard_tunnel_name_placeholder')} />
          </Field>
        ) : (
          <div className="flex flex-col gap-1">
            <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('cloudflare.tunnels.select_tunnel')}</span>
            <SelectMenu
              label={t('cloudflare.tunnels.select_tunnel')}
              value={tunnelId}
              onChange={setTunnelId}
              options={tunnels.map((tunnel) => ({ value: tunnel.id, label: tunnel.name }))}
              placeholder={t('cloudflare.tunnels.select_existing_tunnel')}
            />
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('cloudflare.tunnels.subdomain')}>
            <Input value={subdomain} onChange={(event) => setSubdomain(event.target.value)} placeholder={t('cloudflare.tunnels.subdomain_placeholder')} />
          </Field>
          <div className="flex flex-col gap-1">
            <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('cloudflare.tunnels.domain')}</span>
            <SelectMenu
              label={t('cloudflare.tunnels.domain')}
              value={domain}
              onChange={setDomain}
              options={zones.map((zone) => ({ value: zone.name, label: zone.name }))}
              placeholder={t('cloudflare.tunnels.select_domain')}
            />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('cloudflare.tunnels.protocol')}</span>
            <SelectMenu
              label={t('cloudflare.tunnels.protocol')}
              value={protocol}
              onChange={setProtocol}
              options={WIZARD_PROTOCOLS.map((value) => ({ value, label: value }))}
            />
          </div>
          <Field label={t('cloudflare.tunnels.port')} required>
            <Input type="number" min={1} max={65535} value={port} onChange={(event) => setPort(event.target.value)} />
          </Field>
          <Field label={t('cloudflare.tunnels.path')}>
            <Input value={path} onChange={(event) => setPath(event.target.value)} placeholder={t('cloudflare.tunnels.path_placeholder')} />
          </Field>
        </div>
      </div>
    </Modal>
  )
}

function RuleDialog({
  accountId,
  zoneId,
  phase,
  rule,
  onClose,
  onSaved,
}: {
  accountId: string
  zoneId: string
  phase: RulePhase
  rule: TunnelRule | null
  onClose: () => void
  onSaved: () => void
}) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const [description, setDescription] = useState(rule?.description ?? '')
  const [expression, setExpression] = useState(rule?.expression ?? '')
  const [action, setAction] = useState(rule?.action ?? 'block')
  const [parameters, setParameters] = useState(JSON.stringify(rule?.action_parameters ?? {}, null, 2))
  const [enabled, setEnabled] = useState(rule?.enabled !== false)
  const [saving, setSaving] = useState(false)

  async function save(): Promise<void> {
    if (!expression.trim()) {
      toast({ title: t('cloudflare.settings.msg.info_required'), tone: 'warning' })
      return
    }
    let actionParameters: Record<string, unknown> | undefined
    if (parameters.trim()) {
      try {
        actionParameters = JSON.parse(parameters) as Record<string, unknown>
      } catch {
        toast({ title: t('cloudflare.tunnels.msg.rule_create_failed', { error: 'JSON' }), tone: 'danger' })
        return
      }
    }
    const input: RuleInput = {
      ...(description.trim() ? { description: description.trim() } : {}),
      expression: expression.trim(),
      action,
      ...(actionParameters && Object.keys(actionParameters).length > 0 ? { action_parameters: actionParameters } : {}),
      enabled,
    }
    setSaving(true)
    try {
      if (rule?.id) await tunnelsApi.rules.update(accountId, zoneId, phase, rule.id, input)
      else await tunnelsApi.rules.create(accountId, zoneId, phase, input)
      toast({ title: rule?.id ? t('cloudflare.tunnels.msg.rule_updated') : t('cloudflare.tunnels.msg.rule_created'), tone: 'success' })
      onSaved()
    } catch (failure) {
      toast({ title: cfErrorText(failure), tone: 'danger' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={rule?.id ? t('cloudflare.tunnels.rule_modal_title_edit') : t('cloudflare.tunnels.rule_modal_title_add')}
      width={680}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>{t('common.save')}</Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        <Field label={t('cloudflare.tunnels.rule_description')}>
          <Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t('cloudflare.tunnels.rule_desc_placeholder')} />
        </Field>
        <Field label={t('cloudflare.tunnels.expression')} required>
          <Textarea value={expression} onChange={(event) => setExpression(event.target.value)} rows={3} placeholder={t('cloudflare.tunnels.expression_placeholder')} />
        </Field>
        <Field label={t('cloudflare.tunnels.table.action')} required>
          <Input value={action} onChange={(event) => setAction(event.target.value)} />
        </Field>
        <Field label={t('cloudflare.tunnels.action_json')} hint={t('cloudflare.tunnels.advanced_mode_hint')}>
          <Textarea value={parameters} onChange={(event) => setParameters(event.target.value)} rows={4} spellCheck={false} />
        </Field>
        <Switch checked={enabled} onChange={setEnabled} label={t('cloudflare.tunnels.table.enabled')} />
      </div>
    </Modal>
  )
}
