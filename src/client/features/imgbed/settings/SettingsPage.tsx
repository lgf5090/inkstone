import { useEffect, useState, type ReactElement } from 'react'
import { Check, KeyRound, Plus, RefreshCw, Trash2, Zap } from 'lucide-react'
import { useRef } from 'react'
import { Button, Badge, IconButton } from '../../../components/primitives'
import { Checkbox, Field, Input, Select, Switch, Textarea } from '../../../components/form'
import { Empty, LoadingBlock } from '../../../components/feedback'
import { confirm as confirmDialog } from '../../../components/overlay'
import { Modal, confirm } from '../../../components/overlay'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { imgbedApi, type ImgbedChannelResponse, type ImgbedStatsResponse, type ImgbedToken } from '../api'
import { AiSettingsForm, OthersSettingsForm, PageSettingsForm, SecuritySettingsForm, UploadSettingsForm } from './forms'

type Tab = 'status' | 'upload' | 'security' | 'page' | 'others' | 'ai'

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'status', label: 'imgbed.settings.status' },
  { id: 'upload', label: 'imgbed.settings.upload' },
  { id: 'security', label: 'imgbed.settings.security' },
  { id: 'page', label: 'imgbed.settings.page' },
  { id: 'others', label: 'imgbed.settings.others' },
  { id: 'ai', label: 'imgbed.settings.ai' },
]

export function SettingsPage(): ReactElement {
  const [tab, setTab] = useState<Tab>('status')
  return (
    <div className="flex flex-col gap-3 p-3 md:p-5">
      <div className="flex flex-wrap gap-1" role="tablist" aria-label={t('imgbed.settings.title')}>
        {TABS.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={`rounded-[var(--r-md)] px-2.5 py-1.5 text-[length:var(--text-12)] ${tab === item.id ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent-on-soft)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}>
            {t(item.label as never)}
          </button>
        ))}
      </div>
      {tab === 'status' && <StatusTab />}
      {tab === 'upload' && <div className="flex flex-col gap-3"><UploadSettingsForm /><ChannelsPanel /></div>}
      {tab === 'security' && <div className="flex flex-col gap-3"><SecuritySettingsForm /><TokensPanel /></div>}
      {tab === 'page' && <PageSettingsForm />}
      {tab === 'others' && <OthersSettingsForm />}
      {tab === 'ai' && <AiSettingsForm />}
    </div>
  )
}

function StatusTab(): ReactElement {
  const [stats, setStats] = useState<ImgbedStatsResponse | null>(null)
  const [error, setError] = useState('')
  const restoreRef = useRef<HTMLInputElement>(null)
  const toast = useUi((state) => state.toast)
  const restore = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const input = event.currentTarget
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    if (!(await confirmDialog({ title: t('imgbed.settings.restore_confirm' as never), tone: 'danger', confirmLabel: t('imgbed.settings.restore' as never) }))) return
    try {
      const payload = JSON.parse(await file.text()) as { files?: unknown[]; settings?: unknown }
      const files = Array.isArray(payload.files) ? payload.files : []
      for (let index = 0; index < files.length; index += 50) {
        await imgbedApi('/api/imgbed/manage/restore', { method: 'POST', body: { format: 'inkstone-imgbed-backup', version: 1, files: files.slice(index, index + 50), settings: index === 0 ? payload.settings : undefined } })
      }
      toast({ title: t('imgbed.settings.restore_done' as never), tone: 'success' })
      load()
    } catch (reason) { toast({ title: reason instanceof Error ? reason.message : t('imgbed.common.error'), tone: 'danger' }) }
  }
  const load = (): void => {
    imgbedApi<ImgbedStatsResponse>('/api/imgbed/manage/stats').then(setStats).catch((reason: Error) => setError(reason.message))
  }
  useEffect(load, [])
  if (error) return <Empty art="search" title={error} action={<Button onClick={load}>{t('imgbed.common.retry')}</Button>} />
  if (!stats) return <LoadingBlock label={t('imgbed.common.loading')} />
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2 sm:grid-cols-4">
        <Metric label={t('imgbed.settings.total_files')} value={String(stats.totalFiles)} />
        <Metric label={t('imgbed.settings.total_size')} value={`${(stats.totalBytes / 1024 / 1024).toFixed(1)} MB`} />
        <Metric label={t('imgbed.library.normal')} value={String(stats.accessStats.normal)} />
        <Metric label={t('imgbed.library.blocked')} value={String(stats.accessStats.blocked)} />
      </div>
      <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{t('imgbed.settings.status')}</span>
          <IconButton label={t('imgbed.common.retry')} onClick={load}><RefreshCw size={14} /></IconButton>
        </div>
        {!stats.uploadTrend.labels.length ? <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('imgbed.settings.no_data')}</p> : (
          <div className="flex h-32 items-end gap-1">
            {stats.uploadTrend.total.map((value, index) => (
              <div key={index} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                <div className="w-full rounded-t bg-[var(--accent-soft)]" style={{ height: `${Math.max(2, value / Math.max(1, ...stats.uploadTrend.total) * 100)}%` }} title={`${stats.uploadTrend.labels[index]}: ${value}`} />
                <span className="max-w-full truncate text-[length:var(--text-9)] text-[var(--text-quaternary)]">{stats.uploadTrend.labels[index]}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2"><a href="/api/imgbed/manage/backup" className="inline-flex min-h-8 items-center rounded-[var(--r-sm)] border border-[var(--border-default)] px-2 text-[length:var(--text-11-5)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">{t('imgbed.settings.export' as never)}</a><Button size="sm" variant="secondary" onClick={() => restoreRef.current?.click()}>{t('imgbed.settings.restore' as never)}</Button><input ref={restoreRef} type="file" accept="application/json,.json" hidden onChange={(event) => void restore(event)} /></div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }): ReactElement {
  return <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3"><div className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{label}</div><div className="mt-1 text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]">{value}</div></div>
}

function ChannelsPanel(): ReactElement {
  const [channels, setChannels] = useState<ImgbedChannelResponse[] | null>(null)
  const [editing, setEditing] = useState<ImgbedChannelResponse | null>(null)
  const toast = useUi((state) => state.toast)
  const load = (): void => {
    imgbedApi<{ channels: ImgbedChannelResponse[] }>('/api/imgbed/channels?includeDisabled=true').then((result) => setChannels(result.channels)).catch((error: Error) => toast({ title: error.message, tone: 'danger' }))
  }
  useEffect(load, [])
  const test = async (channel: ImgbedChannelResponse): Promise<void> => {
    try { const result = await imgbedApi<{ ok: boolean; message: string }>(`/api/imgbed/channels/${channel.id}/test`, { method: 'POST' }); toast({ title: result.message, tone: result.ok ? 'success' : 'danger' }) }
    catch (error) { toast({ title: error instanceof Error ? error.message : t('imgbed.common.error'), tone: 'danger' }) }
  }
  const remove = async (channel: ImgbedChannelResponse): Promise<void> => {
    if (!(await confirm({ title: t('imgbed.settings.delete_channel'), tone: 'danger', confirmLabel: t('imgbed.library.delete') }))) return
    try { await imgbedApi(`/api/imgbed/channels/${channel.id}`, { method: 'DELETE' }); load() }
    catch (error) { toast({ title: error instanceof Error ? error.message : t('imgbed.common.error'), tone: 'danger' }) }
  }
  return (
    <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{t('imgbed.settings.channels')}</span>
        <Button size="sm" icon={<Plus size={13} />} onClick={() => setEditing({ id: '', type: 'telegram', name: '', config: {}, enabled: true, fixed: false, quota: { enabled: false, limitGB: null, threshold: 95 }, hasCredentials: false })}>{t('imgbed.settings.add_channel')}</Button>
      </div>
      {!channels ? <LoadingBlock label={t('imgbed.common.loading')} /> : channels.length === 0 ? <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('imgbed.settings.no_data')}</p> : (
        <ul className="divide-y divide-[var(--border-subtle)]">
          {channels.map((channel) => (
            <li key={`${channel.type}:${channel.name}`} className="flex flex-wrap items-center gap-2 py-2">
              <Badge tone={channel.enabled ? 'success' : 'neutral'}>{channel.type}</Badge>
              <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]">{channel.name}</span>
              {channel.fixed && <Badge tone="neutral">{t('imgbed.settings.fixed')}</Badge>}
              {channel.hasCredentials && <KeyRound size={13} className="text-[var(--text-quaternary)]" aria-label={t('imgbed.settings.credentials')} />}
              <IconButton label={t('imgbed.settings.test_channel')} onClick={() => void test(channel)}><Zap size={13} /></IconButton>
              {!channel.fixed && <IconButton label={t('imgbed.settings.edit_channel')} onClick={() => setEditing(channel)}><Check size={13} /></IconButton>}
              {!channel.fixed && <IconButton label={t('imgbed.settings.delete_channel')} onClick={() => void remove(channel)}><Trash2 size={13} /></IconButton>}
            </li>
          ))}
        </ul>
      )}
      {editing && <ChannelDialog channel={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />}
    </div>
  )
}

function ChannelDialog({ channel, onClose, onSaved }: { channel: ImgbedChannelResponse; onClose: () => void; onSaved: () => void }): ReactElement {
  const [type, setType] = useState<string>(channel.type)
  const [name, setName] = useState(channel.name)
  const [config, setConfig] = useState(JSON.stringify(channel.config, null, 2))
  const [credentials, setCredentials] = useState('{}')
  const [enabled, setEnabled] = useState(channel.enabled)
  const [quotaEnabled, setQuotaEnabled] = useState(channel.quota.enabled)
  const [quotaLimit, setQuotaLimit] = useState(channel.quota.limitGB ?? 0)
  const [error, setError] = useState('')
  const save = async (): Promise<void> => {
    try {
      const body = { type, name, config: JSON.parse(config) as unknown, credentials: JSON.parse(credentials) as unknown, enabled, quota: { enabled: quotaEnabled, limitGB: quotaLimit || null, threshold: channel.quota.threshold } }
      if (channel.id) await imgbedApi(`/api/imgbed/channels/${channel.id}`, { method: 'PUT', body })
      else await imgbedApi('/api/imgbed/channels', { method: 'POST', body })
      onSaved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : t('imgbed.common.error')) }
  }
  return (
    <Modal open onClose={onClose} title={channel.id ? t('imgbed.settings.edit_channel') : t('imgbed.settings.add_channel')} width={560} footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>{t('imgbed.common.cancel')}</Button><Button onClick={() => void save()}>{t('imgbed.library.save')}</Button></div>}>
      <div className="flex flex-col gap-2">
        {error && <div role="alert" className="text-[length:var(--text-11-5)] text-[var(--danger)]">{error}</div>}
        <Field label={t('imgbed.settings.type')}><Select value={type} onChange={(event) => setType(event.target.value)} disabled={Boolean(channel.id)}>{['telegram', 'cfr2', 's3', 'discord', 'huggingface', 'webdav'].map((item) => <option key={item} value={item}>{item}</option>)}</Select></Field>
        <Field label={t('imgbed.settings.name')}><Input value={name} onChange={(event) => setName(event.target.value)} /></Field>
        <Field label={t('imgbed.settings.config_json' as never)}><Textarea value={config} onChange={(event) => setConfig(event.target.value)} rows={7} className="font-mono text-[length:var(--text-11)]" /></Field>
        <Field label={t('imgbed.settings.credentials_json' as never)}><Textarea value={credentials} onChange={(event) => setCredentials(event.target.value)} rows={5} className="font-mono text-[length:var(--text-11)]" /></Field>
        <div className="flex flex-wrap items-center gap-3"><Switch checked={enabled} onChange={setEnabled} label={t('imgbed.settings.enabled')} /><Checkbox checked={quotaEnabled} onChange={setQuotaEnabled} label={t('imgbed.settings.quota')} />{quotaEnabled && <Input type="number" value={quotaLimit} onChange={(event) => setQuotaLimit(Number(event.target.value))} className="w-28" />}</div>
      </div>
    </Modal>
  )
}

function TokensPanel(): ReactElement {
  const [tokens, setTokens] = useState<ImgbedToken[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<string[]>(['upload'])
  const [created, setCreated] = useState('')
  const toast = useUi((state) => state.toast)
  const load = (): void => {
    imgbedApi<{ tokens: ImgbedToken[] }>('/api/imgbed/tokens').then((result) => setTokens(result.tokens)).catch((error: Error) => toast({ title: error.message, tone: 'danger' }))
  }
  useEffect(load, [])
  const create = async (): Promise<void> => {
    try {
      const result = await imgbedApi<{ token: string }>('/api/imgbed/tokens', { method: 'POST', body: { name, scopes } })
      setCreated(result.token)
      setCreating(false)
      setName('')
      load()
    } catch (error) { toast({ title: error instanceof Error ? error.message : t('imgbed.common.error'), tone: 'danger' }) }
  }
  const remove = async (id: string): Promise<void> => {
    if (!(await confirm({ title: t('imgbed.settings.delete_channel'), tone: 'danger', confirmLabel: t('imgbed.library.delete') }))) return
    await imgbedApi(`/api/imgbed/tokens/${id}`, { method: 'DELETE' }).then(load).catch(() => toast({ title: t('imgbed.common.error'), tone: 'danger' }))
  }
  return (
    <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{t('imgbed.settings.tokens')}</span>
        <Button size="sm" icon={<Plus size={13} />} onClick={() => setCreating(true)}>{t('imgbed.settings.create_token')}</Button>
      </div>
      {created && <div className="mb-2 break-all rounded bg-[var(--bg-inset)] p-2 font-mono text-[length:var(--text-11)] text-[var(--text-primary)]">{t('imgbed.settings.token_created')}<br />{created}</div>}
      {!tokens ? <LoadingBlock label={t('imgbed.common.loading')} /> : tokens.length === 0 ? <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('imgbed.settings.no_data')}</p> : (
        <ul className="divide-y divide-[var(--border-subtle)]">
          {tokens.map((token) => (
            <li key={token.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]">{token.name}</span>
              <span className="font-mono text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{token.prefix}…</span>
              <Badge tone="neutral">{token.scopes.join(' ')}</Badge>
              <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{token.owner}</span>
              <IconButton label={t('imgbed.library.delete')} onClick={() => void remove(token.id)}><Trash2 size={13} /></IconButton>
            </li>
          ))}
        </ul>
      )}
      <Modal open={creating} onClose={() => setCreating(false)} title={t('imgbed.settings.create_token')} width={420} footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setCreating(false)}>{t('imgbed.common.cancel')}</Button><Button onClick={() => void create()}>{t('imgbed.settings.create_token')}</Button></div>}>
        <div className="flex flex-col gap-2">
          <Field label={t('imgbed.settings.token_name')}><Input value={name} onChange={(event) => setName(event.target.value)} /></Field>
          <Field label={t('imgbed.settings.token_scopes')}>
            <div className="flex flex-wrap gap-2">{['list', 'upload', 'delete', 'manage'].map((scope) => <Checkbox key={scope} checked={scopes.includes(scope)} onChange={(next) => setScopes((current) => next ? [...current, scope] : current.filter((item) => item !== scope))} label={scope} />)}</div>
          </Field>
        </div>
      </Modal>
    </div>
  )
}
