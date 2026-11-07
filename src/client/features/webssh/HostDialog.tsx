import { useEffect, useState } from 'react'
import type {
  WebsshAuthMethod,
  WebsshCredential,
  WebsshEgressConfig,
  WebsshHost,
  WebsshHostGroup,
  WebsshHostIconKind,
  WebsshKey,
  WebsshProvider,
  WebsshRegionHint,
} from '@shared/webssh/types'
import { WEBSSH_BUILTIN_PROVIDERS } from '@shared/webssh/providers'
import { Button } from '../../components/primitives'
import { ColorWheelTrigger } from '../../components/color-field'
import { Field, Input, Segmented, Select, Switch, Textarea } from '../../components/form'
import { Modal } from '../../components/overlay'
import { SelectMenu } from '../../components/select-menu'
import { ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { websshApi, type WebsshHostPayload } from './api'
import { HostIcon, providerText } from './HostIcon'
import { HostIconPicker } from './HostIconPicker'
import { regionLabel, regionOptions } from './egress-regions'

interface HostDraft {
  name: string
  host: string
  port: string
  username: string
  groupId: string
  authMethod: WebsshAuthMethod
  credentialId: string
  keyId: string
  termType: string
  initialCommand: string
  color: string
  tags: string
  notes: string
  favorite: boolean
  pinned: boolean
  provider: string
  iconKind: WebsshHostIconKind
  iconValue: string
  iconUrl: string
  egressRegion: '' | 'auto' | WebsshRegionHint
}

const COLOR_EXAMPLE_PLACEHOLDER = '#000000'

function defaultEgress(host: WebsshHost | null): WebsshEgressConfig {
  return host?.egress ?? {
    mode: '',
    region: '',
    jumpHostId: '',
    proxy: { host: '', port: 0, auth: 'none', username: '', credentialId: '' },
    fallback: { enabled: null, mode: '' },
  }
}

function draftFrom(host: WebsshHost | null): HostDraft {
  return {
    name: host?.name ?? '',
    host: host?.host ?? '',
    port: String(host?.port ?? 22),
    username: host?.username ?? 'root',
    groupId: host?.groupId ?? '',
    authMethod: host?.authMethod ?? 'password',
    credentialId: host?.credentialId ?? '',
    keyId: host?.keyId ?? '',
    termType: host?.termType ?? 'xterm-256color',
    initialCommand: host?.initialCommand ?? '',
    color: host?.color ?? '',
    tags: host?.tags.join(', ') ?? '',
    notes: host?.notes ?? '',
    favorite: host?.favorite ?? false,
    pinned: host?.pinned ?? false,
    provider: host?.provider ?? 'other',
    iconKind: host?.iconKind ?? '',
    iconValue: host?.iconValue ?? '',
    iconUrl: host?.iconUrl ?? '',
    egressRegion: host?.egress.region ?? '',
  }
}

export function HostDialog({ open, host, groups, credentials, keys, providers, defaultGroupId, onClose, onSaved, onOpenCredentials, onOpenKeys, onProvidersChanged }: {
  open: boolean
  host: WebsshHost | null
  groups: WebsshHostGroup[]
  credentials: WebsshCredential[]
  keys: WebsshKey[]
  providers: WebsshProvider[]
  /** A new host started from a folder row opens with that folder already chosen. */
  defaultGroupId?: string
  onClose: () => void
  onSaved: (host: WebsshHost) => void
  onOpenCredentials: () => void
  onOpenKeys: () => void
  onProvidersChanged: () => void
}) {
  const [draft, setDraft] = useState<HostDraft>(() => draftFrom(host))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [iconOpen, setIconOpen] = useState(false)
  const [providerOpen, setProviderOpen] = useState(false)
  const [providerName, setProviderName] = useState('')
  const [providerColor, setProviderColor] = useState('')

  useEffect(() => {
    if (!open) return
    setDraft(host ? draftFrom(host) : { ...draftFrom(null), groupId: defaultGroupId ?? '' })
    setError(null)
    setSaving(false)
  }, [open, host, defaultGroupId])

  const patch = (next: Partial<HostDraft>) => setDraft((current) => ({ ...current, ...next }))
  const missingAuth = draft.authMethod === 'password' ? !draft.credentialId : !draft.keyId
  const disabled = saving || !draft.name.trim() || !draft.host.trim() || !draft.username.trim() || missingAuth
  const egress = defaultEgress(host)
  const regionMode = draft.egressRegion === '' ? 'inherit' : draft.egressRegion === 'auto' ? 'auto' : 'manual'
  const manualRegion = draft.egressRegion !== '' && draft.egressRegion !== 'auto' ? draft.egressRegion : null
  const rememberedRegion = host?.egress.regionResolved?.region ?? null
  const regionChoices = regionOptions()

  const submit = async () => {
    setSaving(true)
    setError(null)
    const payload: WebsshHostPayload = {
      name: draft.name.trim(),
      host: draft.host.trim(),
      port: Number(draft.port) || 22,
      username: draft.username.trim(),
      groupId: draft.groupId,
      authMethod: draft.authMethod,
      credentialId: draft.authMethod === 'password' ? draft.credentialId : '',
      keyId: draft.authMethod === 'publickey' ? draft.keyId : '',
      encoding: 'utf-8',
      termType: draft.termType.trim() || 'xterm-256color',
      initialCommand: draft.initialCommand,
      color: draft.color,
      tags: draft.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      notes: draft.notes,
      favorite: draft.favorite,
      pinned: draft.pinned,
      provider: draft.provider,
      iconKind: draft.iconKind,
      iconValue: draft.iconValue,
      egress: {
        mode: egress.mode,
        region: draft.egressRegion,
        jumpHostId: egress.jumpHostId,
        proxy: egress.proxy,
        fallback: egress.fallback,
      },
    }
    try {
      const saved = host ? await websshApi.updateHost(host.id, payload) : await websshApi.createHost(payload)
      onSaved(saved)
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('webssh.error.generic'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
    <Modal
      open={open}
      onClose={onClose}
      title={host ? t('webssh.host.edit_title') : t('webssh.host.create_title')}
      description={host ? t('webssh.host.edit_description') : t('webssh.host.create_description')}
      width={620}
      dismissible={!saving}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>{t('webssh.actions.cancel')}</Button>
          <Button variant="primary" onClick={submit} disabled={disabled} loading={saving}>{t('webssh.actions.save')}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t('webssh.host.name')} required>
              <Input value={draft.name} onChange={(event) => patch({ name: event.target.value })} maxLength={80} autoFocus />
            </Field>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
              <Field label={t('webssh.host.provider')}>
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <SelectMenu
                      label={t('webssh.host.provider')}
                      value={draft.provider}
                      onChange={(provider) => patch({ provider })}
                      options={[
                        ...WEBSSH_BUILTIN_PROVIDERS.map((provider) => ({ value: provider.id, label: providerText(provider.id, providers) })),
                        ...providers.filter((provider) => provider.id.startsWith('custom:')).map((provider) => ({ value: provider.id, label: provider.label })),
                      ]}
                      searchable
                      width={230}
                    />
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => { setProviderName(''); setProviderColor(''); setProviderOpen(true) }}>
                    {t('webssh.provider.add')}
                  </Button>
                </div>
              </Field>
              <Field label={t('webssh.host.icon')}>
                <div className="flex items-center gap-1.5">
                  <HostIcon host={{ name: draft.name || 'H', provider: draft.provider, iconKind: draft.iconKind, iconValue: draft.iconValue, iconUrl: draft.iconUrl }} providers={providers} size={28} />
                  <Button size="sm" variant="secondary" onClick={() => setIconOpen(true)}>{t('webssh.icon.choose')}</Button>
                </div>
              </Field>
            </div>
            <div className="grid grid-cols-[1fr_92px] gap-3">
              <Field label={t('webssh.host.address')} required>
                <Input value={draft.host} onChange={(event) => patch({ host: event.target.value })} placeholder="example.com" spellCheck={false} />
              </Field>
              <Field label={t('webssh.host.port')}>
                <Input value={draft.port} inputMode="numeric" onChange={(event) => patch({ port: event.target.value.replace(/[^0-9]/g, '') })} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('webssh.host.username')} required>
                <Input value={draft.username} onChange={(event) => patch({ username: event.target.value })} spellCheck={false} />
              </Field>
              <Field label={t('webssh.host.group')}>
                <Select value={draft.groupId} onChange={(event) => patch({ groupId: event.target.value })}>
                  <option value="">{t('webssh.group.none')}</option>
                  {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                </Select>
              </Field>
            </div>
            <Field label={t('webssh.host.auth_method')}>
              <Segmented
                value={draft.authMethod}
                onChange={(value) => patch({ authMethod: value })}
                options={[
                  { value: 'password', label: t('webssh.host.auth_password') },
                  { value: 'publickey', label: t('webssh.host.auth_key') },
                ]}
              />
            </Field>
            {draft.authMethod === 'password' ? (
              <Field label={t('webssh.host.credential')} required hint={credentials.length ? undefined : t('webssh.host.no_credentials')}>
                <div className="flex items-center gap-2">
                  <Select value={draft.credentialId} onChange={(event) => patch({ credentialId: event.target.value })} className="min-w-0 flex-1">
                    <option value="">{t('webssh.host.choose')}</option>
                    {credentials.map((credential) => <option key={credential.id} value={credential.id}>{credential.label}</option>)}
                  </Select>
                  <Button size="sm" onClick={onOpenCredentials}>{t('webssh.host.add_credential')}</Button>
                </div>
              </Field>
            ) : (
              <Field label={t('webssh.host.key')} required hint={keys.length ? undefined : t('webssh.host.no_keys')}>
                <div className="flex items-center gap-2">
                  <Select value={draft.keyId} onChange={(event) => patch({ keyId: event.target.value })} className="min-w-0 flex-1">
                    <option value="">{t('webssh.host.choose')}</option>
                    {keys.map((key) => <option key={key.id} value={key.id}>{key.label}</option>)}
                  </Select>
                  <Button size="sm" onClick={onOpenKeys}>{t('webssh.host.import_key')}</Button>
                </div>
              </Field>
            )}
            <div className="space-y-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">{t('webssh.egress.region.title')}</p>
                  <p className="mt-0.5 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('webssh.egress.region.hint')}</p>
                </div>
                {rememberedRegion && (
                  <span className="shrink-0 rounded-full bg-[var(--bg-sunken)] px-2 py-0.5 text-[length:var(--text-11)] text-[var(--text-secondary)]">
                    {t('webssh.egress.region.remembered', { region: regionLabel(rememberedRegion) })}
                  </span>
                )}
              </div>
              <Segmented
                value={regionMode}
                onChange={(value) => patch({
                  egressRegion: value === 'inherit'
                    ? ''
                    : value === 'auto'
                      ? 'auto'
                      : (manualRegion ?? rememberedRegion ?? 'apac'),
                })}
                options={[
                  { value: 'inherit', label: t('webssh.egress.region.inherit') },
                  { value: 'auto', label: t('webssh.egress.region.auto') },
                  { value: 'manual', label: t('webssh.egress.region.manual') },
                ]}
              />
              {regionMode === 'manual' && (
                <Field label={t('webssh.egress.region.select')}>
                  <SelectMenu
                    label={t('webssh.egress.region.select')}
                    value={manualRegion ?? ''}
                    onChange={(value) => patch({ egressRegion: value as WebsshRegionHint })}
                    options={regionChoices}
                    searchable
                    width={260}
                  />
                </Field>
              )}
              {regionMode === 'inherit' && (
                <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('webssh.egress.region.inherit_hint')}</p>
              )}
              {regionMode === 'auto' && (
                <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('webssh.egress.region.auto_hint')}</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('webssh.host.term_type')}>
                <Input value={draft.termType} onChange={(event) => patch({ termType: event.target.value })} spellCheck={false} />
              </Field>
              <Field label={t('webssh.host.color')}>
                <div className="flex items-center gap-2">
                  <ColorWheelTrigger
                    value={draft.color || null}
                    label={t('webssh.host.color')}
                    onChange={(value) => patch({ color: value })}
                    onCommit={(value) => patch({ color: value })}
                  />
                  <Input value={draft.color} onChange={(event) => patch({ color: event.target.value })} placeholder={COLOR_EXAMPLE_PLACEHOLDER} spellCheck={false} className="min-w-0 flex-1" />
                </div>
              </Field>
            </div>
            <Field label={t('webssh.host.initial_command')} hint={t('webssh.host.optional')}>
              <Input value={draft.initialCommand} onChange={(event) => patch({ initialCommand: event.target.value })} spellCheck={false} maxLength={512} />
            </Field>
            <Field label={t('webssh.host.tags')} hint={t('webssh.host.tags_hint')}>
              <Input value={draft.tags} onChange={(event) => patch({ tags: event.target.value })} />
            </Field>
            <Field label={t('webssh.host.notes')}>
              <Textarea value={draft.notes} onChange={(event) => patch({ notes: event.target.value })} rows={3} maxLength={2000} />
            </Field>
            <label className="flex items-center justify-between gap-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-3 py-2">
              <span className="text-[length:var(--text-12-5)] text-[var(--text-secondary)]">{t('webssh.host.favorite')}</span>
              <Switch checked={draft.favorite} onChange={(next) => patch({ favorite: next })} label={t('webssh.host.favorite')} />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-3 py-2">
              <span className="text-[length:var(--text-12-5)] text-[var(--text-secondary)]">{t('webssh.host.pinned')}</span>
              <Switch checked={draft.pinned} onChange={(next) => patch({ pinned: next })} label={t('webssh.host.pinned')} />
            </label>
        {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
      </div>
    </Modal>
    <>
      <HostIconPicker
        open={iconOpen}
        host={host}
        providers={providers}
        onClose={() => setIconOpen(false)}
        onPick={(kind, value) => patch({ iconKind: kind, iconValue: value })}
        onUploaded={(updated) => patch({ iconKind: updated.iconKind, iconValue: updated.iconValue, iconUrl: updated.iconUrl })}
      />
      <Modal
        open={providerOpen}
        onClose={() => setProviderOpen(false)}
        title={t('webssh.provider.new_title')}
        width={400}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setProviderOpen(false)}>{t('webssh.actions.cancel')}</Button>
            <Button
              variant="primary"
              disabled={!providerName.trim()}
              onClick={() => {
                websshApi.createProvider({ label: providerName.trim(), color: providerColor })
                  .then((provider) => {
                    onProvidersChanged()
                    patch({ provider: provider.id })
                    setProviderOpen(false)
                  })
                  .catch((caught: unknown) => setError(caught instanceof ApiError ? caught.message : t('webssh.error.generic')))
              }}
            >
              {t('webssh.actions.save')}
            </Button>
          </>
        )}
      >
        <div className="space-y-3">
          <Field label={t('webssh.provider.name')} required>
            <Input autoFocus value={providerName} onChange={(event) => setProviderName(event.target.value)} maxLength={40} />
          </Field>
          <Field label={t('webssh.provider.color')}>
            <div className="flex items-center gap-2">
              <ColorWheelTrigger value={providerColor || null} label={t('webssh.provider.color')} onChange={setProviderColor} onCommit={setProviderColor} />
              <Input value={providerColor} onChange={(event) => setProviderColor(event.target.value)} placeholder={COLOR_EXAMPLE_PLACEHOLDER} className="min-w-0 flex-1" />
            </div>
          </Field>
        </div>
      </Modal>
    </>
    </>
  )
}
