import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { WebsshCredential } from '@shared/webssh/types'
import { Button, IconButton } from '../../components/primitives'
import { Field, Input } from '../../components/form'
import { Modal, confirm } from '../../components/overlay'
import { ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { websshApi } from './api'

export function CredentialDialog({ open, onClose, credentials, onChanged }: {
  open: boolean
  onClose: () => void
  credentials: WebsshCredential[]
  onChanged: () => void
}) {
  const [label, setLabel] = useState('')
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async () => {
    setSaving(true)
    setError(null)
    try {
      await websshApi.createCredential({ label: label.trim(), password })
      setLabel('')
      setPassword('')
      onChanged()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('webssh.error.generic'))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (credential: WebsshCredential) => {
    const approved = await confirm({
      title: t('webssh.cred.remove_title'),
      description: t('webssh.cred.remove_description', { label: credential.label }),
      tone: 'danger',
      confirmLabel: t('webssh.actions.delete'),
    })
    if (!approved) return
    setError(null)
    try {
      await websshApi.deleteCredential(credential.id)
      onChanged()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('webssh.error.generic'))
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('webssh.cred.title')}
      description={t('webssh.cred.description')}
      width={560}
      dismissible={!saving}
      footer={<Button variant="ghost" onClick={onClose}>{t('webssh.actions.close')}</Button>}
    >
      <div className="space-y-4">
        <div className="space-y-3">
          <Field label={t('webssh.cred.label')} required>
            <Input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={80} />
          </Field>
          <Field label={t('webssh.cred.password')} required>
            <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="off" />
          </Field>
          <Button variant="primary" onClick={create} disabled={saving || !label.trim() || !password} loading={saving}>
            {t('webssh.actions.add')}
          </Button>
        </div>
        {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
        <ul className="divide-y divide-[var(--border-subtle)] rounded-[var(--r-md)] border border-[var(--border-subtle)]">
          {credentials.length === 0 ? (
            <li className="px-3 py-4 text-[length:var(--text-12-5)] text-[var(--text-tertiary)]">{t('webssh.cred.empty')}</li>
          ) : credentials.map((credential) => (
            <li key={credential.id} className="flex items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)] text-[var(--text-primary)]">{credential.label}</span>
              <span className="shrink-0 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                {t('webssh.keys.used_by', { count: credential.hostCount })}
              </span>
              <IconButton label={t('webssh.actions.delete')} size="sm" onClick={() => void remove(credential)}>
                <Trash2 size={13} aria-hidden="true" />
              </IconButton>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  )
}
