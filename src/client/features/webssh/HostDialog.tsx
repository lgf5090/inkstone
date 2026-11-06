import { useEffect, useState } from 'react'
import type { WebsshAuthMethod, WebsshCredential, WebsshHost, WebsshHostGroup, WebsshKey } from '@shared/webssh/types'
import { Button } from '../../components/primitives'
import { ColorWheelTrigger } from '../../components/color-field'
import { Field, Input, Segmented, Select, Switch, Textarea } from '../../components/form'
import { Modal } from '../../components/overlay'
import { ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { websshApi, type WebsshHostPayload } from './api'

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
}

const COLOR_EXAMPLE_PLACEHOLDER = '#000000'

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
  }
}

export function HostDialog({ open, host, groups, credentials, keys, onClose, onSaved, onOpenCredentials, onOpenKeys }: {
  open: boolean
  host: WebsshHost | null
  groups: WebsshHostGroup[]
  credentials: WebsshCredential[]
  keys: WebsshKey[]
  onClose: () => void
  onSaved: (host: WebsshHost) => void
  onOpenCredentials: () => void
  onOpenKeys: () => void
}) {
  const [draft, setDraft] = useState<HostDraft>(() => draftFrom(host))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setDraft(draftFrom(host))
    setError(null)
    setSaving(false)
  }, [open, host])

  const patch = (next: Partial<HostDraft>) => setDraft((current) => ({ ...current, ...next }))
  const missingAuth = draft.authMethod === 'password' ? !draft.credentialId : !draft.keyId
  const disabled = saving || !draft.name.trim() || !draft.host.trim() || !draft.username.trim() || missingAuth

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
        {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
      </div>
    </Modal>
  )
}
