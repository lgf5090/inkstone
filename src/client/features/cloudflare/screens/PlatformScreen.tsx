/**
 * Developer platform: Queues, Durable Object namespaces and Hyperdrive.
 *
 * One account selector and three panels, each with its own fetch. Queues and Hyperdrive have the
 * create/delete pair Cloudflare offers; Durable Object namespaces are read-only because they are
 * created by deploying a Worker that declares the class.
 */
import { useEffect, useState } from 'react'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { CloudflareAccount } from '@shared/cloudflare/model'
import { LoadingBlock } from '../../../components/feedback'
import { Field, Input } from '../../../components/form'
import { Modal, confirm } from '../../../components/overlay'
import { Badge, Button, IconButton } from '../../../components/primitives'
import { SelectMenu } from '../../../components/select-menu'
import { t as uiT } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { accountsApi } from '../api/accounts'
import { cfErrorText } from '../api/client'
import {
  platformApi,
  type DurableObjectInstance,
  type DurableObjectNamespace,
  type HyperdriveConfig,
  type HyperdriveOriginInput,
  type PlatformQueue,
} from '../api/platform'
import { useCfT, type CloudflareMessageKey } from '../i18n'
import { TBody, Table, TableScroll, Td, THead, Th, Tr } from '../components/Table'
import { Panel, PanelEmpty, PanelError } from './dashboard/Panel'

type PlatformTab = 'queues' | 'durable-objects' | 'hyperdrive'

const TABS: readonly { value: PlatformTab; labelKey: CloudflareMessageKey }[] = [
  { value: 'queues', labelKey: 'cloudflare.platform.tabs.queues' },
  { value: 'durable-objects', labelKey: 'cloudflare.platform.tabs.durable_objects' },
  { value: 'hyperdrive', labelKey: 'cloudflare.platform.tabs.hyperdrive' },
]

function QueuePanel({ accountId, readOnly }: { accountId: string; readOnly: boolean }) {
  const tcf = useCfT()
  const toast = useUi((state) => state.toast)
  const [queues, setQueues] = useState<PlatformQueue[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const [busy, setBusy] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [detail, setDetail] = useState<PlatformQueue | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    platformApi.queues(accountId)
      .then((body) => { if (!cancelled) setQueues(body.queues) })
      .catch((reason: unknown) => { if (!cancelled) setError(cfErrorText(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [accountId, nonce])

  async function create(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await platformApi.createQueue(accountId, name.trim())
      toast({ title: tcf('cloudflare.platform.queues.created'), tone: 'success' })
      setCreateOpen(false)
      setName('')
      setNonce((value) => value + 1)
    } catch (reason) {
      toast({ title: uiT('common.action_failed'), description: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function remove(queue: PlatformQueue): Promise<void> {
    const ok = await confirm({
      title: tcf('cloudflare.platform.delete_title'),
      description: tcf('cloudflare.platform.queues.delete_confirm', { name: queue.name }),
      confirmLabel: tcf('cloudflare.platform.delete'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      await platformApi.deleteQueue(accountId, queue.id)
      toast({ title: tcf('cloudflare.platform.deleted'), tone: 'success' })
      setNonce((value) => value + 1)
    } catch (reason) {
      toast({ title: uiT('common.action_failed'), description: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel
      title={tcf('cloudflare.platform.queues.title')}
      actions={(
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} onClick={() => setNonce((value) => value + 1)}>
            {uiT('common.refresh')}
          </Button>
          <Button size="sm" icon={<Plus size={14} />} disabled={readOnly} onClick={() => setCreateOpen(true)}>
            {tcf('cloudflare.platform.queues.create')}
          </Button>
        </div>
      )}
    >
      {loading ? <LoadingBlock /> : error ? <PanelError message={error} onRetry={() => setNonce((value) => value + 1)} /> : queues.length === 0 ? (
        <PanelEmpty>{tcf('cloudflare.platform.queues.empty')}</PanelEmpty>
      ) : (
        <>
          <div className="hidden md:block">
            <TableScroll label={tcf('cloudflare.platform.queues.title')}>
              <Table>
                <THead>
                  <Tr>
                    <Th>{tcf('cloudflare.platform.name')}</Th>
                    <Th>{tcf('cloudflare.platform.id')}</Th>
                    <Th>{tcf('cloudflare.platform.queues.producers')}</Th>
                    <Th>{tcf('cloudflare.platform.queues.consumers')}</Th>
                    <Th>{tcf('cloudflare.platform.created')}</Th>
                    <Th sticky>{tcf('cloudflare.platform.actions')}</Th>
                  </Tr>
                </THead>
                <TBody>
                  {queues.map((queue) => (
                    <Tr key={queue.id}>
                      <Td>{queue.name}</Td>
                      <Td className="font-mono text-[length:var(--text-11)]">{queue.id}</Td>
                      <Td>{queue.producerCount}</Td>
                      <Td>{queue.consumerCount}</Td>
                      <Td>{queue.createdOn}</Td>
                      <Td sticky>
                        <div className="flex items-center gap-1">
                          <Button size="sm" variant="ghost" onClick={() => setDetail(queue)}>{tcf('cloudflare.platform.detail')}</Button>
                          <IconButton label={tcf('cloudflare.platform.delete')} size="sm" variant="ghost" disabled={readOnly || busy} onClick={() => void remove(queue)}>
                            <Trash2 size={14} />
                          </IconButton>
                        </div>
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </TableScroll>
          </div>
          <div className="flex flex-col gap-2 md:hidden">
            {queues.map((queue) => (
              <div key={queue.id} className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-[var(--text-primary)]">{queue.name}</p>
                    <p className="break-all font-mono text-[length:var(--text-11)] text-[var(--text-tertiary)]">{queue.id}</p>
                  </div>
                  <Badge tone="neutral">{queue.producerCount} / {queue.consumerCount}</Badge>
                </div>
                <div className="mt-2 flex justify-end gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setDetail(queue)}>{tcf('cloudflare.platform.detail')}</Button>
                  <Button size="sm" variant="ghost" disabled={readOnly || busy} icon={<Trash2 size={14} />} onClick={() => void remove(queue)}>
                    {tcf('cloudflare.platform.delete')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={tcf('cloudflare.platform.queues.create')}
        footer={(
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>{uiT('common.cancel')}</Button>
            <Button loading={busy} disabled={!name.trim()} onClick={() => void create()}>{tcf('cloudflare.platform.create')}</Button>
          </div>
        )}
      >
        <Field label={tcf('cloudflare.platform.queues.name')} required>
          <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={64} />
        </Field>
      </Modal>

      <Modal open={detail !== null} onClose={() => setDetail(null)} title={detail?.name ?? ''}>
        {detail ? (
          <dl className="grid grid-cols-1 gap-3 text-[length:var(--text-12-5)] sm:grid-cols-2">
            <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.platform.id')}</dt><dd className="break-all font-mono">{detail.id}</dd></div>
            <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.platform.queues.delivery_delay')}</dt><dd>{detail.settings?.deliveryDelay ?? '—'}</dd></div>
            <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.platform.queues.retention')}</dt><dd>{detail.settings?.messageRetention ?? '—'}</dd></div>
            <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.platform.queues.paused')}</dt><dd>{detail.settings?.deliveryPaused ? tcf('cloudflare.platform.yes') : tcf('cloudflare.platform.no')}</dd></div>
            <div className="sm:col-span-2">
              <dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.platform.queues.producers')}</dt>
              <dd>{detail.producers.length ? detail.producers.map((item) => `${item.type}: ${item.label}`).join(', ') : tcf('cloudflare.platform.none')}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.platform.queues.consumers')}</dt>
              <dd>{detail.consumers.length ? detail.consumers.map((item) => `${item.type}: ${item.script}`).join(', ') : tcf('cloudflare.platform.none')}</dd>
            </div>
          </dl>
        ) : null}
      </Modal>
    </Panel>
  )
}

function DurableObjectsPanel({ accountId, readOnly }: { accountId: string; readOnly: boolean }) {
  const tcf = useCfT()
  const toast = useUi((state) => state.toast)
  const [namespaces, setNamespaces] = useState<DurableObjectNamespace[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const [busy, setBusy] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [detail, setDetail] = useState<DurableObjectNamespace | null>(null)
  const [objects, setObjects] = useState<DurableObjectInstance[] | null>(null)
  const [objectsError, setObjectsError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    platformApi.durableObjectNamespaces(accountId)
      .then((body) => { if (!cancelled) setNamespaces(body.namespaces) })
      .catch((reason: unknown) => { if (!cancelled) setError(cfErrorText(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [accountId, nonce])

  async function openDetail(namespace: DurableObjectNamespace): Promise<void> {
    setDetail(namespace)
    setObjects(null)
    setObjectsError(null)
    try {
      const body = await platformApi.durableObjectInstances(accountId, namespace.id)
      setObjects(body.objects)
    } catch (reason) {
      setObjectsError(cfErrorText(reason))
    }
  }

  async function create(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await platformApi.createDurableObjectNamespace(accountId, name.trim())
      toast({ title: tcf('cloudflare.platform.dos.created'), tone: 'success' })
      setCreateOpen(false)
      setName('')
      setNonce((value) => value + 1)
    } catch (reason) {
      toast({ title: uiT('common.action_failed'), description: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function remove(namespace: DurableObjectNamespace): Promise<void> {
    const ok = await confirm({
      title: tcf('cloudflare.platform.delete_title'),
      description: tcf('cloudflare.platform.dos.delete_confirm', { name: namespace.name }),
      confirmLabel: tcf('cloudflare.platform.delete'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      await platformApi.deleteDurableObjectNamespace(accountId, namespace.id)
      toast({ title: tcf('cloudflare.platform.deleted'), tone: 'success' })
      setNonce((value) => value + 1)
    } catch (reason) {
      toast({ title: uiT('common.action_failed'), description: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel
      title={tcf('cloudflare.platform.dos.title')}
      actions={(
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} onClick={() => setNonce((value) => value + 1)}>
            {uiT('common.refresh')}
          </Button>
          <Button size="sm" icon={<Plus size={14} />} disabled={readOnly} onClick={() => setCreateOpen(true)}>
            {tcf('cloudflare.platform.dos.create')}
          </Button>
        </div>
      )}
    >
      <p className="mb-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{tcf('cloudflare.platform.dos.note')}</p>
      {loading ? <LoadingBlock /> : error ? <PanelError message={error} onRetry={() => setNonce((value) => value + 1)} /> : namespaces.length === 0 ? (
        <PanelEmpty>{tcf('cloudflare.platform.dos.empty')}</PanelEmpty>
      ) : (
        <TableScroll label={tcf('cloudflare.platform.dos.title')}>
          <Table>
            <THead>
              <Tr>
                <Th>{tcf('cloudflare.platform.name')}</Th>
                <Th>{tcf('cloudflare.platform.dos.class')}</Th>
                <Th>{tcf('cloudflare.platform.dos.script')}</Th>
                <Th>{tcf('cloudflare.platform.dos.sqlite')}</Th>
                <Th sticky>{tcf('cloudflare.platform.actions')}</Th>
              </Tr>
            </THead>
            <TBody>
              {namespaces.map((namespace) => (
                <Tr key={namespace.id}>
                  <Td>{namespace.name || '—'}</Td>
                  <Td>{namespace.className || '—'}</Td>
                  <Td>{namespace.script || '—'}</Td>
                  <Td>{namespace.useSqlite ? tcf('cloudflare.platform.yes') : tcf('cloudflare.platform.no')}</Td>
                  <Td sticky>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="ghost" onClick={() => void openDetail(namespace)}>{tcf('cloudflare.platform.detail')}</Button>
                      <IconButton label={tcf('cloudflare.platform.delete')} size="sm" variant="ghost" disabled={readOnly || busy} onClick={() => void remove(namespace)}>
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
        title={tcf('cloudflare.platform.dos.create')}
        footer={(
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>{uiT('common.cancel')}</Button>
            <Button loading={busy} disabled={!name.trim()} onClick={() => void create()}>{tcf('cloudflare.platform.create')}</Button>
          </div>
        )}
      >
        <Field label={tcf('cloudflare.platform.dos.name')} hint={tcf('cloudflare.platform.dos.note')} required>
          <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={64} />
        </Field>
      </Modal>

      <Modal open={detail !== null} onClose={() => setDetail(null)} title={detail?.name ?? tcf('cloudflare.platform.dos.title')}>
        {detail ? (
          <div className="flex flex-col gap-3 text-[length:var(--text-12-5)]">
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.platform.id')}</dt><dd className="break-all font-mono">{detail.id}</dd></div>
              <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.platform.dos.class')}</dt><dd>{detail.className || '—'}</dd></div>
              <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.platform.dos.script')}</dt><dd>{detail.script || '—'}</dd></div>
              <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.platform.dos.sqlite')}</dt><dd>{detail.useSqlite ? tcf('cloudflare.platform.yes') : tcf('cloudflare.platform.no')}</dd></div>
            </dl>
            <div>
              <p className="mb-1 font-medium">{tcf('cloudflare.platform.dos.objects')}</p>
              {objectsError ? <PanelError message={objectsError} onRetry={() => void openDetail(detail)} /> : objects === null ? <LoadingBlock /> : objects.length === 0 ? <PanelEmpty>{tcf('cloudflare.platform.dos.no_objects')}</PanelEmpty> : (
                <ul className="flex flex-col gap-1">
                  {objects.map((object) => (
                    <li key={object.id} className="break-all rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-2 py-1 font-mono text-[length:var(--text-11)]">{object.id}</li>
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

function HyperdrivePanel({ accountId, readOnly }: { accountId: string; readOnly: boolean }) {
  const tcf = useCfT()
  const toast = useUi((state) => state.toast)
  const [configs, setConfigs] = useState<HyperdriveConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const [busy, setBusy] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [scheme, setScheme] = useState<HyperdriveOriginInput['scheme']>('postgres')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('5432')
  const [database, setDatabase] = useState('')
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [detail, setDetail] = useState<HyperdriveConfig | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    platformApi.hyperdriveConfigs(accountId)
      .then((body) => { if (!cancelled) setConfigs(body.configs) })
      .catch((reason: unknown) => { if (!cancelled) setError(cfErrorText(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [accountId, nonce])

  async function create(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await platformApi.createHyperdriveConfig(accountId, name.trim(), {
        scheme,
        host: host.trim(),
        port: Number(port),
        database: database.trim(),
        user: user.trim(),
        password,
      })
      toast({ title: tcf('cloudflare.platform.hyperdrive.created'), tone: 'success' })
      setCreateOpen(false)
      setName('')
      setHost('')
      setDatabase('')
      setUser('')
      setPassword('')
      setNonce((value) => value + 1)
    } catch (reason) {
      toast({ title: uiT('common.action_failed'), description: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function remove(config: HyperdriveConfig): Promise<void> {
    const ok = await confirm({
      title: tcf('cloudflare.platform.delete_title'),
      description: tcf('cloudflare.platform.hyperdrive.delete_confirm', { name: config.name }),
      confirmLabel: tcf('cloudflare.platform.delete'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      await platformApi.deleteHyperdriveConfig(accountId, config.id)
      toast({ title: tcf('cloudflare.platform.deleted'), tone: 'success' })
      setNonce((value) => value + 1)
    } catch (reason) {
      toast({ title: uiT('common.action_failed'), description: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const schemeOptions = [
    { value: 'postgres', label: 'PostgreSQL' },
    { value: 'mysql', label: 'MySQL' },
  ] as const

  return (
    <Panel
      title={tcf('cloudflare.platform.hyperdrive.title')}
      actions={(
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} onClick={() => setNonce((value) => value + 1)}>
            {uiT('common.refresh')}
          </Button>
          <Button size="sm" icon={<Plus size={14} />} disabled={readOnly} onClick={() => setCreateOpen(true)}>
            {tcf('cloudflare.platform.hyperdrive.create')}
          </Button>
        </div>
      )}
    >
      {loading ? <LoadingBlock /> : error ? <PanelError message={error} onRetry={() => setNonce((value) => value + 1)} /> : configs.length === 0 ? (
        <PanelEmpty>{tcf('cloudflare.platform.hyperdrive.empty')}</PanelEmpty>
      ) : (
        <TableScroll label={tcf('cloudflare.platform.hyperdrive.title')}>
          <Table>
            <THead>
              <Tr>
                <Th>{tcf('cloudflare.platform.name')}</Th>
                <Th>{tcf('cloudflare.platform.hyperdrive.origin')}</Th>
                <Th>{tcf('cloudflare.platform.id')}</Th>
                <Th sticky>{tcf('cloudflare.platform.actions')}</Th>
              </Tr>
            </THead>
            <TBody>
              {configs.map((config) => (
                <Tr key={config.id}>
                  <Td>{config.name}</Td>
                  <Td className="font-mono text-[length:var(--text-11)]">{config.scheme}://{config.host}:{config.port}/{config.database}</Td>
                  <Td className="break-all font-mono text-[length:var(--text-11)]">{config.id}</Td>
                  <Td sticky>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setDetail(config)}>{tcf('cloudflare.platform.detail')}</Button>
                      <IconButton label={tcf('cloudflare.platform.delete')} size="sm" variant="ghost" disabled={readOnly || busy} onClick={() => void remove(config)}>
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
        title={tcf('cloudflare.platform.hyperdrive.create')}
        width={640}
        footer={(
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>{uiT('common.cancel')}</Button>
            <Button loading={busy} disabled={!name.trim() || !host.trim() || !database.trim() || !user.trim() || !password} onClick={() => void create()}>
              {tcf('cloudflare.platform.create')}
            </Button>
          </div>
        )}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={tcf('cloudflare.platform.hyperdrive.name')} required>
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={64} />
          </Field>
          <Field label={tcf('cloudflare.platform.hyperdrive.scheme')}>
            <SelectMenu
              label={tcf('cloudflare.platform.hyperdrive.scheme')}
              value={scheme}
              options={schemeOptions}
              onChange={(next) => { setScheme(next); setPort(next === 'mysql' ? '3306' : '5432') }}
            />
          </Field>
          <Field label={tcf('cloudflare.platform.hyperdrive.host')} required>
            <Input value={host} onChange={(event) => setHost(event.target.value)} autoComplete="off" />
          </Field>
          <Field label={tcf('cloudflare.platform.hyperdrive.port')} required>
            <Input value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" />
          </Field>
          <Field label={tcf('cloudflare.platform.hyperdrive.database')} required>
            <Input value={database} onChange={(event) => setDatabase(event.target.value)} autoComplete="off" />
          </Field>
          <Field label={tcf('cloudflare.platform.hyperdrive.user')} required>
            <Input value={user} onChange={(event) => setUser(event.target.value)} autoComplete="off" />
          </Field>
          <Field label={tcf('cloudflare.platform.hyperdrive.password')} hint={tcf('cloudflare.platform.hyperdrive.password_hint')} required>
            <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" />
          </Field>
        </div>
      </Modal>

      <Modal open={detail !== null} onClose={() => setDetail(null)} title={detail?.name ?? ''}>
        {detail ? (
          <dl className="grid grid-cols-1 gap-3 text-[length:var(--text-12-5)] sm:grid-cols-2">
            <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.platform.id')}</dt><dd className="break-all font-mono">{detail.id}</dd></div>
            <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.platform.hyperdrive.origin')}</dt><dd className="break-all font-mono">{detail.scheme}://{detail.host}:{detail.port}/{detail.database}</dd></div>
            <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.platform.hyperdrive.user')}</dt><dd>{detail.user}</dd></div>
            <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.platform.hyperdrive.caching')}</dt><dd>{detail.cachingDisabled ? tcf('cloudflare.platform.disabled') : tcf('cloudflare.platform.enabled')}{detail.maxAge !== null ? ` · ${detail.maxAge}s` : ''}</dd></div>
            <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.platform.created')}</dt><dd>{detail.createdOn}</dd></div>
            <div><dt className="text-[var(--text-tertiary)]">{tcf('cloudflare.platform.modified')}</dt><dd>{detail.modifiedOn}</dd></div>
          </dl>
        ) : null}
      </Modal>
    </Panel>
  )
}

export function PlatformScreen() {
  const tcf = useCfT()
  const [accounts, setAccounts] = useState<CloudflareAccount[]>([])
  const [accountId, setAccountId] = useState('')
  const [tab, setTab] = useState<PlatformTab>('queues')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
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
  }, [nonce])

  if (loading) return <div className="flex h-full items-center justify-center"><LoadingBlock /></div>
  if (error) return <div className="p-3"><PanelError message={error} onRetry={() => setNonce((value) => value + 1)} /></div>

  const readOnly = accounts.find((account) => account.id === accountId)?.is_demo ?? false
  const accountOptions = accounts.map((account) => ({ value: account.id, label: account.name }))

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]">
          {tcf('cloudflare.platform.title')}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <SelectMenu
            label={tcf('cloudflare.platform.account')}
            value={accountId}
            options={accountOptions}
            onChange={setAccountId}
            size="sm"
            width={170}
            className="w-40"
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

      <div key={`${tab}:${accountId}:${refreshKey}`}>
        {tab === 'queues' ? <QueuePanel accountId={accountId} readOnly={readOnly} /> : null}
        {tab === 'durable-objects' ? <DurableObjectsPanel accountId={accountId} readOnly={readOnly} /> : null}
        {tab === 'hyperdrive' ? <HyperdrivePanel accountId={accountId} readOnly={readOnly} /> : null}
      </div>
    </div>
  )
}
