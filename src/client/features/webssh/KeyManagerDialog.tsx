import { useState } from 'react'
import { Download, Trash2 } from 'lucide-react'
import type { WebsshKey } from '@shared/webssh/types'
import { Button, IconButton } from '../../components/primitives'
import { CopyButton } from '../../components/copy-button'
import { Field, Input, Textarea } from '../../components/form'
import { Modal, confirm } from '../../components/overlay'
import { ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { websshApi } from './api'

function importFailure(caught: unknown): string {
  if (!(caught instanceof ApiError)) return t('webssh.error.generic')
  const details = caught.details
  const reason = details && typeof details === 'object' && 'reason' in details
    ? String((details as { reason: unknown }).reason)
    : ''
  if (reason === 'passphrase_required') return t('webssh.error.key_passphrase_required')
  if (reason === 'passphrase_invalid') return t('webssh.error.key_passphrase_invalid')
  if (reason === 'unsupported') return t('webssh.error.key_unsupported')
  if (reason === 'invalid') return t('webssh.error.key_invalid')
  return caught.message
}

export function KeyManagerDialog({ open, onClose, keys, onChanged }: {
  open: boolean
  onClose: () => void
  keys: WebsshKey[]
  onChanged: () => void
}) {
  const [label, setLabel] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const importKey = async () => {
    setImporting(true)
    setError(null)
    try {
      await websshApi.importKey({
        label: label.trim(),
        privateKey,
        ...(passphrase ? { passphrase } : {}),
      })
      setLabel('')
      setPrivateKey('')
      setPassphrase('')
      onChanged()
    } catch (caught) {
      setError(importFailure(caught))
    } finally {
      setImporting(false)
    }
  }

  const remove = async (key: WebsshKey) => {
    const approved = await confirm({
      title: t('webssh.keys.remove_title'),
      description: t('webssh.keys.remove_description', { label: key.label }),
      tone: 'danger',
      confirmLabel: t('webssh.actions.delete'),
    })
    if (!approved) return
    setError(null)
    try {
      await websshApi.deleteKey(key.id)
      onChanged()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('webssh.error.generic'))
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('webssh.keys.title')}
      description={t('webssh.keys.description')}
      width={640}
      dismissible={!importing}
      footer={<Button variant="ghost" onClick={onClose}>{t('webssh.actions.close')}</Button>}
    >
      <div className="space-y-4">
        <div className="space-y-3">
          <Field label={t('webssh.keys.label')} required>
            <Input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={80} />
          </Field>
          <Field label={t('webssh.keys.private_key')} required hint={t('webssh.keys.private_key_hint')}>
            <Textarea
              value={privateKey}
              onChange={(event) => setPrivateKey(event.target.value)}
              rows={6}
              spellCheck={false}
              className="font-mono text-[length:var(--text-11-5)]"
            />
          </Field>
          <Field label={t('webssh.keys.passphrase')} hint={t('webssh.keys.passphrase_hint')}>
            <Input type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} autoComplete="off" />
          </Field>
          <Button
            variant="primary"
            onClick={importKey}
            disabled={importing || !label.trim() || !privateKey.trim()}
            loading={importing}
          >
            {t('webssh.actions.import')}
          </Button>
        </div>
        {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
        <ul className="divide-y divide-[var(--border-subtle)] rounded-[var(--r-md)] border border-[var(--border-subtle)]">
          {keys.length === 0 ? (
            <li className="px-3 py-4 text-[length:var(--text-12-5)] text-[var(--text-tertiary)]">{t('webssh.keys.empty')}</li>
          ) : keys.map((key) => (
            <li key={key.id} className="space-y-1 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{key.label}</span>
                <span className="shrink-0 rounded-[var(--r-xs)] bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                  {key.algorithm}
                </span>
                <CopyButton text={key.publicKey} label={t('webssh.keys.copy_public')} toastMessage={t('webssh.toast.copied')} />
                <a
                  href={websshApi.publicKeyUrl(key.id)}
                  download={`${key.id}.pub`}
                  aria-label={t('webssh.keys.download_public')}
                  className="inline-flex size-7 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                >
                  <Download size={13} aria-hidden="true" />
                </a>
                <IconButton label={t('webssh.actions.delete')} size="sm" onClick={() => void remove(key)}>
                  <Trash2 size={13} aria-hidden="true" />
                </IconButton>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                <span className="break-all font-mono">{key.fingerprint}</span>
                <span>{t('webssh.keys.used_by', { count: key.hostCount })}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  )
}
