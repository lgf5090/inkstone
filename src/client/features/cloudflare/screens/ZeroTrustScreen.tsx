/**
 * Zero Trust: Access applications, groups, service tokens, identity providers and devices.
 *
 * Applications, groups and service tokens have the create/delete pair this screen exposes. Identity
 * providers, the organization and device policies are read-only: the account already has them and the
 * panel must not rewrite configuration that was set up outside it.
 */
import { useEffect, useState } from 'react'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { CloudflareAccount } from '@shared/cloudflare/model'
import { Field, Input } from '../../../components/form'
import { LoadingBlock } from '../../../components/feedback'
import { Modal, confirm } from '../../../components/overlay'
import { Badge, Button, IconButton } from '../../../components/primitives'
import { SelectMenu } from '../../../components/select-menu'
import { t as uiT } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { accountsApi } from '../api/accounts'
import { cfErrorText } from '../api/client'
import {
  zeroTrustApi,
  type AccessApp,
  type AccessDevice,
  type AccessGroup,
  type AccessOrganization,
  type AccessPolicy,
  type DevicePolicy,
  type IdentityProvider,
  type ServiceToken,
} from '../api/zero-trust'
import { useCfT, type CloudflareMessageKey } from '../i18n'
import { TBody, Table, TableScroll, Td, THead, Th, Tr } from '../components/Table'
import { Panel, PanelEmpty, PanelError } from './dashboard/Panel'

type ZeroTrustTab = 'apps' | 'groups' | 'tokens' | 'providers' | 'devices'

const TABS: readonly { value: ZeroTrustTab; labelKey: CloudflareMessageKey }[] = [
  { value: 'apps', labelKey: 'cloudflare.zt.tabs.apps' },
  { value: 'groups', labelKey: 'cloudflare.zt.tabs.groups' },
  { value: 'tokens', labelKey: 'cloudflare.zt.tabs.tokens' },
  { value: 'providers', labelKey: 'cloudflare.zt.tabs.providers' },
  { value: 'devices', labelKey: 'cloudflare.zt.tabs.devices' },
]

function AppsPanel({ accountId, readOnly }: { accountId: string; readOnly: boolean }) {
  const tcf = useCfT()
  const toast = useUi((state) => state.toast)
  const [apps, setApps] = useState<AccessApp[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const [busy, setBusy] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [domain, setDomain] = useState('')
  const [detail, setDetail] = useState<AccessApp | null>(null)
  const [policies, setPolicies] = useState<AccessPolicy[] | null>(null)
  const [policyError, setPolicyError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    zeroTrustApi.apps(accountId)
      .then((body) => { if (!cancelled) setApps(body.apps) })
      .catch((reason: unknown) => { if (!cancelled) setError(cfErrorText(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [accountId, nonce])

  async function openDetail(app: AccessApp): Promise<void> {
    setDetail(app)
    setPolicies(null)
    setPolicyError(null)
    try {
      setPolicies((await zeroTrustApi.appPolicies(accountId, app.id)).policies)
    } catch (reason) {
      setPolicyError(cfErrorText(reason))
    }
  }

  async function create(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await zeroTrustApi.createApp(accountId, name.trim(), domain.trim())
      toast({ title: tcf('cloudflare.zt.apps.created'), tone: 'success' })
      setCreateOpen(false)
      setName('')
      setDomain('')
      setNonce((value) => value + 1)
    } catch (reason) {
      toast({ title: uiT('common.action_failed'), description: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function remove(app: AccessApp): Promise<void> {
    const ok = await confirm({
      title: tcf('cloudflare.zt.delete_title'),
      description: tcf('cloudflare.zt.apps.delete_confirm', { name: app.name }),
      confirmLabel: tcf('cloudflare.zt.delete'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      await zeroTrustApi.deleteApp(accountId, app.id)
      toast({ title: tcf('cloudflare.zt.deleted'), tone: 'success' })
      setNonce((value) => value + 1)
    } catch (reason) {
      toast({ title: uiT('common.action_failed'), description: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel
      title={tcf('cloudflare.zt.apps.title')}
      actions={(
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} onClick={() => setNonce((value) => value + 1)}>
            {uiT('common.refresh')}
          </Button>
          <Button size="sm" icon={<Plus size={14} />} disabled={readOnly} onClick={() => setCreateOpen(true)}>
            {tcf('cloudflare.zt.apps.create')}
          </Button>
        </div>
      )}
    >
      {loading ? <LoadingBlock /> : error ? <PanelError message={error} onRetry={() => setNonce((value) => value + 1)} /> : apps.length === 0 ? (
        <PanelEmpty>{tcf('cloudflare.zt.apps.empty')}</PanelEmpty>
      ) : (
        <TableScroll label={tcf('cloudflare.zt.apps.title')}>
          <Table>
            <THead><Tr>
              <Th>{tcf('cloudflare.zt.name')}</Th>
              <Th>{tcf('cloudflare.zt.apps.domain')}</Th>
              <Th>{tcf('cloudflare.zt.type')}</Th>
              <Th>{tcf('cloudflare.zt.apps.session')}</Th>
              <Th sticky>{tcf('cloudflare.zt.actions')}</Th>
            </Tr></THead>
            <TBody>
              {apps.map((app) => (
                <Tr key={app.id}>
                  <Td>{app.name}</Td>
                  <Td className="break-all font-mono text-[length:var(--text-11)]">{app.domain}</Td>
                  <Td>{app.type}</Td>
                  <Td>{app.sessionDuration || '—'}</Td>
                  <Td sticky>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="ghost" onClick={() => void openDetail(app)}>{tcf('cloudflare.zt.detail')}</Button>
                      <IconButton label={tcf('cloudflare.zt.delete')} size="sm" variant="ghost" disabled={readOnly || busy} onClick={() => void remove(app)}>
                        <Trash2 size={14} />
                      </IconButton>
                    </div>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </TableScroll>
      )}

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={tcf('cloudflare.zt.apps.create')}
        footer={(
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>{uiT('common.cancel')}</Button>
            <Button loading={busy} disabled={!name.trim() || !domain.trim()} onClick={() => void create()}>{tcf('cloudflare.zt.create')}</Button>
          </div>
        )}
      >
        <div className="grid grid-cols-1 gap-3">
          <Field label={tcf('cloudflare.zt.apps.name')} required>
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={128} />
          </Field>
          <Field label={tcf('cloudflare.zt.apps.domain')} hint={tcf('cloudflare.zt.apps.domain_hint')} required>
            <Input value={domain} onChange={(event) => setDomain(event.target.value)} autoComplete="off" placeholder="zt-test.example.com" />
          </Field>
        </div>
      </Modal>

      <Modal open={detail !== null} onClose={() => setDetail(null)} title={detail?.name ?? tcf('cloudflare.zt.apps.title')}>
        {detail ? (
          <div className="flex flex-col gap-3 text-[length:var(--text-12-5)]">
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.zt.id')}</dt><dd className="break-all font-mono">{detail.id}</dd></div>
              <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.zt.apps.domain')}</dt><dd className="break-all font-mono">{detail.domain}</dd></div>
            </dl>
            <div>
              <p className="mb-1 font-medium">{tcf('cloudflare.zt.apps.policies')}</p>
              {policyError ? <PanelError message={policyError} onRetry={() => void openDetail(detail)} /> : policies === null ? <LoadingBlock /> : policies.length === 0 ? (
                <PanelEmpty>{tcf('cloudflare.zt.apps.no_policies')}</PanelEmpty>
              ) : (
                <ul className="flex flex-col gap-1">
                  {policies.map((policy) => (
                    <li key={policy.id} className="flex justify-between rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-2 py-1">
                      <span>{policy.name}</span><span className="text-[var(--text-tertiary)]">{policy.decision}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : null}
      </Modal>
    </Panel>
  )
}

function GroupsPanel({ accountId, readOnly }: { accountId: string; readOnly: boolean }) {
  const tcf = useCfT()
  const toast = useUi((state) => state.toast)
  const [groups, setGroups] = useState<AccessGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const [busy, setBusy] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('lgf5481@gmail.com')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    zeroTrustApi.groups(accountId)
      .then((body) => { if (!cancelled) setGroups(body.groups) })
      .catch((reason: unknown) => { if (!cancelled) setError(cfErrorText(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [accountId, nonce])

  async function create(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await zeroTrustApi.createGroup(accountId, name.trim(), email.trim())
      toast({ title: tcf('cloudflare.zt.groups.created'), tone: 'success' })
      setCreateOpen(false)
      setName('')
      setNonce((value) => value + 1)
    } catch (reason) {
      toast({ title: uiT('common.action_failed'), description: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function remove(group: AccessGroup): Promise<void> {
    const ok = await confirm({
      title: tcf('cloudflare.zt.delete_title'),
      description: tcf('cloudflare.zt.groups.delete_confirm', { name: group.name }),
      confirmLabel: tcf('cloudflare.zt.delete'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      await zeroTrustApi.deleteGroup(accountId, group.id)
      toast({ title: tcf('cloudflare.zt.deleted'), tone: 'success' })
      setNonce((value) => value + 1)
    } catch (reason) {
      toast({ title: uiT('common.action_failed'), description: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel
      title={tcf('cloudflare.zt.groups.title')}
      actions={(
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} onClick={() => setNonce((value) => value + 1)}>
            {uiT('common.refresh')}
          </Button>
          <Button size="sm" icon={<Plus size={14} />} disabled={readOnly} onClick={() => setCreateOpen(true)}>
            {tcf('cloudflare.zt.groups.create')}
          </Button>
        </div>
      )}
    >
      {loading ? <LoadingBlock /> : error ? <PanelError message={error} onRetry={() => setNonce((value) => value + 1)} /> : groups.length === 0 ? (
        <PanelEmpty>{tcf('cloudflare.zt.groups.empty')}</PanelEmpty>
      ) : (
        <TableScroll label={tcf('cloudflare.zt.groups.title')}>
          <Table>
            <THead><Tr>
              <Th>{tcf('cloudflare.zt.name')}</Th>
              <Th>{tcf('cloudflare.zt.groups.id')}</Th>
              <Th sticky>{tcf('cloudflare.zt.actions')}</Th>
            </Tr></THead>
            <TBody>
              {groups.map((group) => (
                <Tr key={group.id}>
                  <Td>{group.name}</Td>
                  <Td className="break-all font-mono text-[length:var(--text-11)]">{group.id}</Td>
                  <Td sticky>
                    <IconButton label={tcf('cloudflare.zt.delete')} size="sm" variant="ghost" disabled={readOnly || busy} onClick={() => void remove(group)}>
                      <Trash2 size={14} />
                    </IconButton>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </TableScroll>
      )}

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={tcf('cloudflare.zt.groups.create')}
        footer={(
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>{uiT('common.cancel')}</Button>
            <Button loading={busy} disabled={!name.trim() || !email.trim()} onClick={() => void create()}>{tcf('cloudflare.zt.create')}</Button>
          </div>
        )}
      >
        <div className="grid grid-cols-1 gap-3">
          <Field label={tcf('cloudflare.zt.groups.name')} required>
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={128} />
          </Field>
          <Field label={tcf('cloudflare.zt.groups.member')} required>
            <Input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="off" />
          </Field>
        </div>
      </Modal>
    </Panel>
  )
}

function TokensPanel({ accountId, readOnly }: { accountId: string; readOnly: boolean }) {
  const tcf = useCfT()
  const toast = useUi((state) => state.toast)
  const [tokens, setTokens] = useState<ServiceToken[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const [busy, setBusy] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [issued, setIssued] = useState<ServiceToken | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    zeroTrustApi.tokens(accountId)
      .then((body) => { if (!cancelled) setTokens(body.tokens) })
      .catch((reason: unknown) => { if (!cancelled) setError(cfErrorText(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [accountId, nonce])

  async function create(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      const token = await zeroTrustApi.createToken(accountId, name.trim())
      setCreateOpen(false)
      setName('')
      setIssued(token)
      toast({ title: tcf('cloudflare.zt.tokens.created'), tone: 'success' })
      setNonce((value) => value + 1)
    } catch (reason) {
      toast({ title: uiT('common.action_failed'), description: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function remove(token: ServiceToken): Promise<void> {
    const ok = await confirm({
      title: tcf('cloudflare.zt.delete_title'),
      description: tcf('cloudflare.zt.tokens.delete_confirm', { name: token.name }),
      confirmLabel: tcf('cloudflare.zt.delete'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      await zeroTrustApi.deleteToken(accountId, token.id)
      toast({ title: tcf('cloudflare.zt.deleted'), tone: 'success' })
      setNonce((value) => value + 1)
    } catch (reason) {
      toast({ title: uiT('common.action_failed'), description: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel
      title={tcf('cloudflare.zt.tokens.title')}
      actions={(
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} onClick={() => setNonce((value) => value + 1)}>
            {uiT('common.refresh')}
          </Button>
          <Button size="sm" icon={<Plus size={14} />} disabled={readOnly} onClick={() => setCreateOpen(true)}>
            {tcf('cloudflare.zt.tokens.create')}
          </Button>
        </div>
      )}
    >
      <p className="mb-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{tcf('cloudflare.zt.tokens.note')}</p>
      {loading ? <LoadingBlock /> : error ? <PanelError message={error} onRetry={() => setNonce((value) => value + 1)} /> : tokens.length === 0 ? (
        <PanelEmpty>{tcf('cloudflare.zt.tokens.empty')}</PanelEmpty>
      ) : (
        <TableScroll label={tcf('cloudflare.zt.tokens.title')}>
          <Table>
            <THead><Tr>
              <Th>{tcf('cloudflare.zt.name')}</Th>
              <Th>{tcf('cloudflare.zt.tokens.client_id')}</Th>
              <Th>{tcf('cloudflare.zt.tokens.expires')}</Th>
              <Th sticky>{tcf('cloudflare.zt.actions')}</Th>
            </Tr></THead>
            <TBody>
              {tokens.map((token) => (
                <Tr key={token.id}>
                  <Td>{token.name}</Td>
                  <Td className="break-all font-mono text-[length:var(--text-11)]">{token.clientId}</Td>
                  <Td>{token.expiresAt || '—'}</Td>
                  <Td sticky>
                    <IconButton label={tcf('cloudflare.zt.delete')} size="sm" variant="ghost" disabled={readOnly || busy} onClick={() => void remove(token)}>
                      <Trash2 size={14} />
                    </IconButton>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </TableScroll>
      )}

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={tcf('cloudflare.zt.tokens.create')}
        footer={(
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>{uiT('common.cancel')}</Button>
            <Button loading={busy} disabled={!name.trim()} onClick={() => void create()}>{tcf('cloudflare.zt.create')}</Button>
          </div>
        )}
      >
        <Field label={tcf('cloudflare.zt.tokens.name')} required>
          <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={128} />
        </Field>
      </Modal>

      <Modal open={issued !== null} onClose={() => setIssued(null)} title={tcf('cloudflare.zt.tokens.issued')} width={640}>
        {issued ? (
          <div className="flex flex-col gap-3">
            <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{tcf('cloudflare.zt.tokens.secret_note')}</p>
            <Field label={tcf('cloudflare.zt.tokens.client_id')}>
              <Input readOnly value={issued.clientId} />
            </Field>
            <Field label={tcf('cloudflare.zt.tokens.client_secret')}>
              <Input readOnly value={issued.clientSecret ?? ''} />
            </Field>
          </div>
        ) : null}
      </Modal>
    </Panel>
  )
}

function ProvidersPanel({ accountId }: { accountId: string }) {
  const tcf = useCfT()
  const [providers, setProviders] = useState<IdentityProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    zeroTrustApi.providers(accountId)
      .then((body) => { if (!cancelled) setProviders(body.providers) })
      .catch((reason: unknown) => { if (!cancelled) setError(cfErrorText(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [accountId, nonce])

  return (
    <Panel
      title={tcf('cloudflare.zt.providers.title')}
      actions={<Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} onClick={() => setNonce((value) => value + 1)}>{uiT('common.refresh')}</Button>}
    >
      {loading ? <LoadingBlock /> : error ? <PanelError message={error} onRetry={() => setNonce((value) => value + 1)} /> : providers.length === 0 ? (
        <PanelEmpty>{tcf('cloudflare.zt.providers.empty')}</PanelEmpty>
      ) : (
        <TableScroll label={tcf('cloudflare.zt.providers.title')}>
          <Table>
            <THead><Tr><Th>{tcf('cloudflare.zt.name')}</Th><Th>{tcf('cloudflare.zt.type')}</Th><Th>{tcf('cloudflare.zt.id')}</Th></Tr></THead>
            <TBody>
              {providers.map((provider) => (
                <Tr key={provider.id}>
                  <Td>{provider.name}</Td>
                  <Td>{provider.type}</Td>
                  <Td className="break-all font-mono text-[length:var(--text-11)]">{provider.id}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </TableScroll>
      )}
    </Panel>
  )
}

function DevicesPanel({ accountId }: { accountId: string }) {
  const tcf = useCfT()
  const [devices, setDevices] = useState<AccessDevice[]>([])
  const [policies, setPolicies] = useState<DevicePolicy[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void Promise.all([zeroTrustApi.devices(accountId), zeroTrustApi.devicePolicies(accountId)])
      .then(([deviceBody, policyBody]) => {
        if (cancelled) return
        setDevices(deviceBody.devices)
        setPolicies(policyBody.policies)
      })
      .catch((reason: unknown) => { if (!cancelled) setError(cfErrorText(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [accountId, nonce])

  return (
    <Panel
      title={tcf('cloudflare.zt.devices.title')}
      actions={<Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} onClick={() => setNonce((value) => value + 1)}>{uiT('common.refresh')}</Button>}
    >
      {loading ? <LoadingBlock /> : error ? <PanelError message={error} onRetry={() => setNonce((value) => value + 1)} /> : (
        <div className="flex flex-col gap-3">
          <div>
            <p className="mb-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{tcf('cloudflare.zt.devices.policies')}</p>
            {policies.length === 0 ? <PanelEmpty>{tcf('cloudflare.zt.devices.no_policies')}</PanelEmpty> : (
              <ul className="flex flex-col gap-1">
                {policies.map((policy) => (
                  <li key={policy.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-2 py-1">
                    <span className="break-all font-mono text-[length:var(--text-11)]">{policy.id}</span>
                    <span className="flex items-center gap-2">
                      {policy.default ? <Badge tone="accent">{tcf('cloudflare.zt.devices.default')}</Badge> : null}
                      <Badge tone={policy.enabled ? 'success' : 'neutral'}>{policy.enabled ? tcf('cloudflare.zt.enabled') : tcf('cloudflare.zt.disabled')}</Badge>
                      <span className="text-[var(--text-tertiary)]">{policy.profileType}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="mb-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{tcf('cloudflare.zt.devices.inventory')}</p>
            {devices.length === 0 ? <PanelEmpty>{tcf('cloudflare.zt.devices.empty')}</PanelEmpty> : (
              <TableScroll label={tcf('cloudflare.zt.devices.inventory')}>
                <Table>
                  <THead><Tr><Th>{tcf('cloudflare.zt.name')}</Th><Th>{tcf('cloudflare.zt.devices.type')}</Th><Th>{tcf('cloudflare.zt.devices.os')}</Th><Th>{tcf('cloudflare.zt.devices.last_seen')}</Th></Tr></THead>
                  <TBody>
                    {devices.map((device) => (
                      <Tr key={device.id}>
                        <Td>{device.name}</Td>
                        <Td>{device.deviceType}</Td>
                        <Td>{device.osVersion}</Td>
                        <Td>{device.lastSeen}</Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </TableScroll>
            )}
          </div>
        </div>
      )}
    </Panel>
  )
}

function OrganizationCard({ accountId }: { accountId: string }) {
  const tcf = useCfT()
  const [organization, setOrganization] = useState<AccessOrganization | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    zeroTrustApi.organization(accountId)
      .then((body) => { if (!cancelled) setOrganization(body.organization) })
      .catch((reason: unknown) => { if (!cancelled) setError(cfErrorText(reason)) })
    return () => { cancelled = true }
  }, [accountId])

  return (
    <Panel title={tcf('cloudflare.zt.organization.title')}>
      {error ? <PanelError message={error} onRetry={() => setError(null)} /> : organization ? (
        <dl className="grid grid-cols-1 gap-3 text-[length:var(--text-12-5)] sm:grid-cols-2 xl:grid-cols-4">
          <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.zt.organization.auth_domain')}</dt><dd className="break-all font-mono">{organization.authDomain || '—'}</dd></div>
          <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.zt.organization.name')}</dt><dd className="break-all">{organization.name || '—'}</dd></div>
          <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.zt.organization.deny_unmatched')}</dt><dd>{organization.denyUnmatchedRequests ? tcf('cloudflare.zt.enabled') : tcf('cloudflare.zt.disabled')}</dd></div>
          <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.zt.organization.strict_token')}</dt><dd>{organization.strictServiceTokenAuth ? tcf('cloudflare.zt.enabled') : tcf('cloudflare.zt.disabled')}</dd></div>
        </dl>
      ) : <LoadingBlock />}
    </Panel>
  )
}

export function ZeroTrustScreen() {
  const tcf = useCfT()
  const [accounts, setAccounts] = useState<CloudflareAccount[]>([])
  const [accountId, setAccountId] = useState('')
  const [tab, setTab] = useState<ZeroTrustTab>('apps')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void accountsApi.list({ pageSize: 100, filter: 'active' })
      .then((body) => {
        if (cancelled) return
        setAccounts(body.accounts)
        setAccountId((current) => current || body.accounts[0]?.id || '')
      })
      .catch((reason: unknown) => { if (!cancelled) setError(cfErrorText(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [nonce])

  if (loading) return <div className="flex h-full items-center justify-center"><LoadingBlock /></div>
  if (error) return <div className="p-3"><PanelError message={error} onRetry={() => setNonce((value) => value + 1)} /></div>

  const readOnly = accounts.find((account) => account.id === accountId)?.is_demo ?? false
  const accountOptions = accounts.map((account) => ({ value: account.id, label: account.name }))

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]">
          {tcf('cloudflare.zt.title')}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <SelectMenu
            label={tcf('cloudflare.zt.account')}
            value={accountId}
            options={accountOptions}
            onChange={setAccountId}
            size="sm"
            width={170}
            className="w-40"
          />
          <Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} onClick={() => setNonce((value) => value + 1)}>
            {uiT('common.refresh')}
          </Button>
        </div>
      </header>

      <OrganizationCard accountId={accountId} />

      <div className="flex flex-wrap gap-1">
        {TABS.map((item) => (
          <Button key={item.value} size="sm" variant={tab === item.value ? 'primary' : 'secondary'} onClick={() => setTab(item.value)}>
            {tcf(item.labelKey)}
          </Button>
        ))}
      </div>

      {tab === 'apps' ? <AppsPanel accountId={accountId} readOnly={readOnly} /> : null}
      {tab === 'groups' ? <GroupsPanel accountId={accountId} readOnly={readOnly} /> : null}
      {tab === 'tokens' ? <TokensPanel accountId={accountId} readOnly={readOnly} /> : null}
      {tab === 'providers' ? <ProvidersPanel accountId={accountId} /> : null}
      {tab === 'devices' ? <DevicesPanel accountId={accountId} /> : null}
    </div>
  )
}
