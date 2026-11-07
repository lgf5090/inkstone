/**
 * Notification policies: list, create, edit and delete.
 *
 * The auto-created billing-budget policy is listed like any other row; the screen does not hide or
 * rewrite it unless the reader chooses to edit or delete it. Recipients are entered as a comma-
 * separated list and sent as email mechanisms.
 */
import { useEffect, useMemo, useState } from 'react'
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { CloudflareAccount } from '@shared/cloudflare/model'
import { Checkbox, Field, Input, Textarea } from '../../../components/form'
import { LoadingBlock } from '../../../components/feedback'
import { Modal, confirm } from '../../../components/overlay'
import { Badge, Button, IconButton } from '../../../components/primitives'
import { SelectMenu } from '../../../components/select-menu'
import { t as uiT } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { accountsApi } from '../api/accounts'
import { alertingApi, type AlertPolicy, type AlertPolicyInput, type AlertTypeOption } from '../api/alerting'
import { cfErrorText } from '../api/client'
import { useCfT } from '../i18n'
import { TBody, Table, TableScroll, Td, THead, Th, Tr } from '../components/Table'
import { Panel, PanelEmpty, PanelError } from './dashboard/Panel'

interface Draft {
  id?: string
  name: string
  description: string
  alertType: string
  emails: string
  enabled: boolean
}

const EMPTY_DRAFT: Draft = { name: '', description: '', alertType: '', emails: '', enabled: true }

function toDraft(policy: AlertPolicy): Draft {
  return {
    id: policy.id,
    name: policy.name,
    description: policy.description,
    alertType: policy.alertType,
    emails: policy.emails.join(', '),
    enabled: policy.enabled,
  }
}

export function AlertingScreen() {
  const tcf = useCfT()
  const toast = useUi((state) => state.toast)
  const [accounts, setAccounts] = useState<CloudflareAccount[]>([])
  const [accountId, setAccountId] = useState('')
  const [policies, setPolicies] = useState<AlertPolicy[]>([])
  const [alerts, setAlerts] = useState<AlertTypeOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)

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
  }, [])

  useEffect(() => {
    if (!accountId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void Promise.all([alertingApi.policies(accountId), alertingApi.availableAlerts(accountId)])
      .then(([policyBody, alertBody]) => {
        if (cancelled) return
        setPolicies(policyBody.policies)
        setAlerts(alertBody.alerts)
      })
      .catch((reason: unknown) => { if (!cancelled) setError(cfErrorText(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [accountId, nonce])

  const readOnly = accounts.find((account) => account.id === accountId)?.is_demo ?? false

  const alertOptions = useMemo(
    () => alerts.map((alert) => ({ value: alert.type, label: alert.displayName })),
    [alerts],
  )

  async function save(): Promise<void> {
    if (!draft || busy) return
    const emails = draft.emails.split(',').map((email) => email.trim()).filter(Boolean)
    const input: AlertPolicyInput = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      alertType: draft.alertType,
      enabled: draft.enabled,
      emails,
    }
    setBusy(true)
    try {
      if (draft.id) await alertingApi.updatePolicy(accountId, draft.id, input)
      else await alertingApi.createPolicy(accountId, input)
      toast({ title: draft.id ? tcf('cloudflare.alerting.saved') : tcf('cloudflare.alerting.created'), tone: 'success' })
      setDraft(null)
      setNonce((value) => value + 1)
    } catch (reason) {
      toast({ title: uiT('common.action_failed'), description: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function remove(policy: AlertPolicy): Promise<void> {
    const ok = await confirm({
      title: tcf('cloudflare.alerting.delete_title'),
      description: tcf('cloudflare.alerting.delete_confirm', { name: policy.name }),
      confirmLabel: tcf('cloudflare.alerting.delete'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      await alertingApi.deletePolicy(accountId, policy.id)
      toast({ title: tcf('cloudflare.alerting.deleted'), tone: 'success' })
      setNonce((value) => value + 1)
    } catch (reason) {
      toast({ title: uiT('common.action_failed'), description: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  if (loading && accounts.length === 0) return <div className="flex h-full items-center justify-center"><LoadingBlock /></div>
  if (error && accounts.length === 0) return <div className="p-3"><PanelError message={error} onRetry={() => setNonce((value) => value + 1)} /></div>

  const accountOptions = accounts.map((account) => ({ value: account.id, label: account.name }))
  const alertLabel = (type: string) => alerts.find((alert) => alert.type === type)?.displayName ?? type

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]">
          {tcf('cloudflare.alerting.title')}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <SelectMenu
            label={tcf('cloudflare.alerting.account')}
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

      <Panel
        title={tcf('cloudflare.alerting.policies')}
        actions={(
          <Button
            size="sm"
            icon={<Plus size={14} />}
            disabled={readOnly || alerts.length === 0}
            onClick={() => setDraft({ ...EMPTY_DRAFT, alertType: alerts[0]?.type ?? '' })}
          >
            {tcf('cloudflare.alerting.create')}
          </Button>
        )}
      >
        {loading ? <LoadingBlock /> : error ? <PanelError message={error} onRetry={() => setNonce((value) => value + 1)} /> : policies.length === 0 ? (
          <PanelEmpty>{tcf('cloudflare.alerting.empty')}</PanelEmpty>
        ) : (
          <TableScroll label={tcf('cloudflare.alerting.policies')}>
            <Table>
              <THead>
                <Tr>
                  <Th>{tcf('cloudflare.alerting.name')}</Th>
                  <Th>{tcf('cloudflare.alerting.type')}</Th>
                  <Th>{tcf('cloudflare.alerting.recipients')}</Th>
                  <Th>{tcf('cloudflare.alerting.status')}</Th>
                  <Th sticky>{tcf('cloudflare.alerting.actions')}</Th>
                </Tr>
              </THead>
              <TBody>
                {policies.map((policy) => (
                  <Tr key={policy.id}>
                    <Td>{policy.name}</Td>
                    <Td>{alertLabel(policy.alertType)}</Td>
                    <Td className="break-all">{policy.emails.join(', ') || tcf('cloudflare.alerting.none')}</Td>
                    <Td>
                      <Badge tone={policy.enabled ? 'success' : 'neutral'}>
                        {policy.enabled ? tcf('cloudflare.alerting.enabled') : tcf('cloudflare.alerting.disabled')}
                      </Badge>
                    </Td>
                    <Td sticky>
                      <div className="flex items-center gap-1">
                        <IconButton label={tcf('cloudflare.alerting.edit')} size="sm" disabled={readOnly || busy} onClick={() => setDraft(toDraft(policy))}>
                          <Pencil size={14} />
                        </IconButton>
                        <IconButton label={tcf('cloudflare.alerting.delete')} size="sm" variant="ghost" disabled={readOnly || busy} onClick={() => void remove(policy)}>
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
      </Panel>

      <Modal
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.id ? tcf('cloudflare.alerting.edit_title') : tcf('cloudflare.alerting.create')}
        width={640}
        footer={(
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDraft(null)}>{uiT('common.cancel')}</Button>
            <Button
              loading={busy}
              disabled={!draft || !draft.name.trim() || !draft.alertType || !draft.emails.trim()}
              onClick={() => void save()}
            >
              {uiT('common.save')}
            </Button>
          </div>
        )}
      >
        {draft ? (
          <div className="grid grid-cols-1 gap-3">
            <Field label={tcf('cloudflare.alerting.name')} required>
              <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} maxLength={128} />
            </Field>
            <Field label={tcf('cloudflare.alerting.type')} required>
              <SelectMenu
                label={tcf('cloudflare.alerting.type')}
                value={draft.alertType}
                options={alertOptions}
                onChange={(value) => setDraft({ ...draft, alertType: value })}
                searchable
              />
            </Field>
            <Field label={tcf('cloudflare.alerting.recipients')} hint={tcf('cloudflare.alerting.recipients_hint')} required>
              <Input value={draft.emails} onChange={(event) => setDraft({ ...draft, emails: event.target.value })} autoComplete="off" />
            </Field>
            <Field label={tcf('cloudflare.alerting.description')}>
              <Textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} rows={3} />
            </Field>
            <Checkbox
              checked={draft.enabled}
              onChange={(enabled) => setDraft({ ...draft, enabled })}
              label={tcf('cloudflare.alerting.enabled')}
            />
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
