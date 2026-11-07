import { useState } from 'react'
import { ShieldCheck, ShieldX } from 'lucide-react'
import type { WebsshHost, WebsshHostKey, WebsshHostKeyCheck, WebsshHostKeyState } from '@shared/webssh/types'
import { Button } from '../../components/primitives'
import { Field, Input, Select } from '../../components/form'
import { Modal } from '../../components/overlay'
import { ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { websshApi } from './api'

const HOST_KEY_ALGORITHMS = ['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256'] as const
const FINGERPRINT_EXAMPLE_PLACEHOLDER = 'SHA256:…'

function stateLabel(state: WebsshHostKeyState): string {
  if (state === 'trusted') return t('webssh.fingerprint.state_trusted')
  if (state === 'changed') return t('webssh.fingerprint.state_changed')
  if (state === 'revoked') return t('webssh.fingerprint.state_revoked')
  return t('webssh.fingerprint.state_untrusted')
}

export function FingerprintDialog({ open, host, fingerprints, onClose, onChanged }: {
  open: boolean
  host: WebsshHost | null
  fingerprints: WebsshHostKey[]
  onClose: () => void
  onChanged: () => void
}) {
  const [algorithm, setAlgorithm] = useState('ssh-ed25519')
  const [fingerprint, setFingerprint] = useState('')
  const [check, setCheck] = useState<WebsshHostKeyCheck | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!host) return null

  const run = async (action: 'check' | 'trust') => {
    setBusy(true)
    setError(null)
    try {
      const result = action === 'trust'
        ? await websshApi.trustFingerprint(host.id, { algorithm, fingerprint: fingerprint.trim() })
        : await websshApi.checkFingerprint(host.id, { algorithm, fingerprint: fingerprint.trim() })
      setCheck(result)
      if (action === 'trust') onChanged()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('webssh.error.generic'))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (value: WebsshHostKey) => {
    setBusy(true)
    setError(null)
    try {
      setCheck(await websshApi.revokeFingerprint(host.id, value.fingerprint))
      onChanged()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('webssh.error.generic'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('webssh.fingerprint.title')}
      description={t('webssh.fingerprint.description')}
      width={600}
      dismissible={!busy}
      footer={<Button variant="ghost" onClick={onClose}>{t('webssh.actions.close')}</Button>}
    >
      <div className="space-y-4">
        <div className="grid grid-cols-[150px_1fr] gap-3">
          <Field label={t('webssh.fingerprint.algorithm')}>
            <Select value={algorithm} onChange={(event) => setAlgorithm(event.target.value)}>
              {HOST_KEY_ALGORITHMS.map((value) => <option key={value} value={value}>{value}</option>)}
            </Select>
          </Field>
          <Field label={t('webssh.fingerprint.value')}>
            <Input
              value={fingerprint}
              onChange={(event) => setFingerprint(event.target.value)}
              placeholder={FINGERPRINT_EXAMPLE_PLACEHOLDER}
              spellCheck={false}
              className="font-mono text-[length:var(--text-12)]"
            />
          </Field>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void run('check')} disabled={busy || !fingerprint.trim()}>
            {t('webssh.fingerprint.check')}
          </Button>
          <Button size="sm" variant="primary" onClick={() => void run('trust')} disabled={busy || !fingerprint.trim()}>
            {t('webssh.fingerprint.trust')}
          </Button>
        </div>
        {check && (
          <p className="text-[length:var(--text-12-5)] text-[var(--text-secondary)]">
            {stateLabel(check.state)}
            {check.trustedFingerprint && check.state === 'changed'
              ? ` · ${t('webssh.fingerprint.trusted_fingerprint', { fingerprint: check.trustedFingerprint })}`
              : ''}
          </p>
        )}
        {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
        <ul className="divide-y divide-[var(--border-subtle)] rounded-[var(--r-md)] border border-[var(--border-subtle)]">
          {fingerprints.length === 0 ? (
            <li className="px-3 py-4 text-[length:var(--text-12-5)] text-[var(--text-tertiary)]">{t('webssh.fingerprint.empty')}</li>
          ) : fingerprints.map((value) => {
            const state: WebsshHostKeyState = value.revokedAt
              ? 'revoked'
              : value.trustedAt
                ? 'trusted'
                : 'untrusted'
            return (
              <li key={`${value.algorithm}:${value.fingerprint}`} className="flex items-start gap-2 px-3 py-2">
                {state === 'trusted'
                  ? <ShieldCheck size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--accent)]" />
                  : <ShieldX size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--text-quaternary)]" />}
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="break-all font-mono text-[length:var(--text-11-5)] text-[var(--text-primary)]">{value.fingerprint}</p>
                  <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                    {value.algorithm} · {stateLabel(state)}
                  </p>
                </div>
                {state !== 'revoked' && (
                  <Button size="sm" variant="ghost" onClick={() => void revoke(value)} disabled={busy}>
                    {t('webssh.fingerprint.revoke')}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </Modal>
  )
}
