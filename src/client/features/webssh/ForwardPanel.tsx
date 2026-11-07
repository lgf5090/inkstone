import { useCallback, useEffect, useMemo, useState } from 'react'
import { ExternalLink, Plus, ShieldAlert, Square, Trash2 } from 'lucide-react'
import type { WebsshForwardGrant, WebsshForwardRule } from '@shared/webssh/types'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Field, Input } from '../../components/form'
import { Modal, Tooltip, confirm } from '../../components/overlay'
import { SelectMenu } from '../../components/select-menu'
import { ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { websshApi } from './api'

function errorText(caught: unknown): string {
  return caught instanceof ApiError ? caught.message : t('webssh.error.generic')
}

function remaining(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((expiresAt - now) / 1000))
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

export function ForwardPanel({ open, sessionId, hostId, onClose }: {
  open: boolean
  sessionId: string | null
  hostId: string
  onClose: () => void
}) {
  const [rules, setRules] = useState<WebsshForwardRule[]>([])
  const [grants, setGrants] = useState<WebsshForwardGrant[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [ruleId, setRuleId] = useState('')
  const [name, setName] = useState('')
  const [targetHost, setTargetHost] = useState('127.0.0.1')
  const [targetPort, setTargetPort] = useState('8080')
  const [saveRule, setSaveRule] = useState(true)
  const [now, setNow] = useState(() => Date.now())

  const toast = (title: string, tone: 'success' | 'warning' | 'danger' = 'success') => {
    useUi.getState().toast({ title, tone })
  }

  const load = useCallback(async () => {
    if (!sessionId) return
    setLoading(true)
    try {
      const [nextRules, nextGrants] = await Promise.all([
        websshApi.listForwardRules(hostId),
        websshApi.forwardStatus(sessionId),
      ])
      setRules(nextRules)
      setGrants(nextGrants)
      setError(null)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setLoading(false)
    }
  }, [hostId, sessionId])

  useEffect(() => {
    if (!open) return undefined
    void load()
    const poll = setInterval(() => { void load() }, 15_000)
    const tick = setInterval(() => setNow(Date.now()), 1_000)
    return () => {
      clearInterval(poll)
      clearInterval(tick)
    }
  }, [open, load])

  const ruleOptions = useMemo(() => rules.map((rule) => ({
    value: rule.id,
    label: `${rule.name} · ${rule.targetHost}:${rule.targetPort}`,
  })), [rules])

  const applyRule = (value: string) => {
    setRuleId(value)
    const rule = rules.find((candidate) => candidate.id === value)
    if (!rule) return
    setName(rule.name)
    setTargetHost(rule.targetHost)
    setTargetPort(String(rule.targetPort))
  }

  const start = async () => {
    if (!sessionId) return
    const port = Number(targetPort)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      toast(t('webssh.forward.invalid_port'), 'danger')
      return
    }
    const label = name.trim()
    setBusy(true)
    try {
      if (saveRule && label) {
        const existing = rules.find((rule) => rule.name.toLowerCase() === label.toLowerCase())
        if (!existing) {
          await websshApi.createForwardRule({ name: label, hostId, targetHost, targetPort: port })
        }
      }
      const grant = await websshApi.createForward(sessionId, targetHost, port)
      toast(t('webssh.forward.created', { host: targetHost, port }))
      setGrants((current) => [grant, ...current])
      await load()
    } catch (caught) {
      toast(errorText(caught), 'danger')
    } finally {
      setBusy(false)
    }
  }

  const stop = async (grant: WebsshForwardGrant) => {
    if (!sessionId) return
    setBusy(true)
    try {
      await websshApi.stopForward(sessionId, grant.token)
      setGrants((current) => current.filter((item) => item.token !== grant.token))
      toast(t('webssh.forward.stopped'))
    } catch (caught) {
      toast(errorText(caught), 'danger')
    } finally {
      setBusy(false)
    }
  }

  const removeRule = async (rule: WebsshForwardRule) => {
    const approved = await confirm({
      title: t('webssh.forward.remove_rule_title'),
      description: t('webssh.forward.remove_rule_description', { name: rule.name }),
      tone: 'danger',
      confirmLabel: t('webssh.actions.delete'),
    })
    if (!approved) return
    try {
      await websshApi.deleteForwardRule(rule.id)
      setRules((current) => current.filter((item) => item.id !== rule.id))
      if (ruleId === rule.id) setRuleId('')
      toast(t('webssh.forward.rule_removed'))
    } catch (caught) {
      toast(errorText(caught), 'danger')
    }
  }

  const openPreview = (grant: WebsshForwardGrant) => {
    window.open(grant.url, '_blank', 'noopener,noreferrer')
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('webssh.forward.title')}
      description={t('webssh.forward.description')}
      width={640}
    >
      <div className="space-y-4">
        <div className="flex items-start gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2.5">
          <ShieldAlert size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--warning)]" />
          <p className="text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
            {t('webssh.forward.security_note')}
          </p>
        </div>

        <div className="space-y-2">
          <h3 className="text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">{t('webssh.forward.new')}</h3>
          {rules.length > 0 && (
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <span className="mb-1 block text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('webssh.forward.rule')}</span>
                <SelectMenu
                  label={t('webssh.forward.rule')}
                  value={ruleId}
                  options={ruleOptions}
                  onChange={applyRule}
                  placeholder={t('webssh.forward.rule_custom')}
                />
              </div>
              <Button
                size="sm"
                onClick={() => {
                  setRuleId('')
                  setName('')
                  setTargetHost('127.0.0.1')
                  setTargetPort('8080')
                }}
              >
                {t('webssh.forward.rule_custom')}
              </Button>
            </div>
          )}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Field label={t('webssh.forward.name')}>
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('webssh.forward.name_placeholder')} />
            </Field>
            <Field label={t('webssh.forward.target_port')}>
              <Input
                value={targetPort}
                inputMode="numeric"
                onChange={(event) => setTargetPort(event.target.value.replace(/[^\d]/g, ''))}
              />
            </Field>
          </div>
          <Field label={t('webssh.forward.target_host')}>
            <Input value={targetHost} onChange={(event) => setTargetHost(event.target.value)} spellCheck={false} />
          </Field>
          <label className="flex items-center gap-2 text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
            <input type="checkbox" checked={saveRule} onChange={(event) => setSaveRule(event.target.checked)} />
            {t('webssh.forward.save_rule')}
          </label>
          <div className="flex items-center gap-2">
            <Button variant="primary" loading={busy} onClick={() => void start()} icon={<Plus size={13} aria-hidden="true" />}>
              {t('webssh.forward.start')}
            </Button>
            <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('webssh.forward.ttl_note')}</span>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="min-w-0 flex-1 text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">{t('webssh.forward.active')}</h3>
            {loading && <Spinner size={12} />}
            <Button size="sm" variant="ghost" onClick={() => void load()}>{t('webssh.actions.refresh')}</Button>
          </div>
          {error && <p role="alert" className="text-[length:var(--text-11-5)] text-[var(--danger)]">{error}</p>}
          {grants.length === 0 ? (
            <p className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('webssh.forward.empty')}</p>
          ) : (
            <ul className="space-y-1">
              {grants.map((grant) => (
                <li
                  key={grant.token}
                  className="flex flex-wrap items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2 py-1.5"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-11-5)] text-[var(--text-primary)]">
                    {`http://${grant.targetHost}:${grant.targetPort}`}
                  </span>
                  <span className="shrink-0 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                    {t('webssh.forward.expires', { time: remaining(grant.expiresAt, now) })}
                  </span>
                  <Tooltip label={t('webssh.forward.preview')}>
                    <IconButton label={t('webssh.forward.preview')} size="xs" onClick={() => openPreview(grant)}>
                      <ExternalLink size={13} aria-hidden="true" />
                    </IconButton>
                  </Tooltip>
                  <Button size="sm" variant="danger" onClick={() => void stop(grant)} disabled={busy} icon={<Square size={11} aria-hidden="true" />}>
                    {t('webssh.forward.stop')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {rules.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">{t('webssh.forward.rules')}</h3>
            <ul className="space-y-1">
              {rules.map((rule) => (
                <li key={rule.id} className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2 py-1.5">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-start"
                    onClick={() => applyRule(rule.id)}
                  >
                    <span className="block truncate text-[length:var(--text-12)] text-[var(--text-primary)]">{rule.name}</span>
                    <span className="block truncate font-mono text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                      {rule.targetHost}:{rule.targetPort}
                    </span>
                  </button>
                  <IconButton label={t('webssh.actions.delete')} size="xs" onClick={() => void removeRule(rule)}>
                    <Trash2 size={13} aria-hidden="true" />
                  </IconButton>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  )
}
