/**
 * One ruleset rule.
 *
 * Guided mode covers the common shape (expression, action and optional action parameters); the
 * advanced switch hands the whole rule over as JSON for the phases whose parameters are deep enough
 * that a handful of fields would be a worse editor. Switching back parses the JSON into the guided
 * fields, so a mistake is caught before the dialog closes.
 */
import { useState } from 'react'
import { Field, Input, Switch, Textarea } from '../../../../components/form'
import { Modal } from '../../../../components/overlay'
import { Button } from '../../../../components/primitives'
import { SelectMenu } from '../../../../components/select-menu'
import { t as uiT } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { cfErrorText } from '../../api/client'
import { dnsApi, type DnsRule, type RuleInput, type RulePhase } from '../../api/dns'
import { useCfT } from '../../i18n'
import { RULE_PHASE_ACTIONS } from './options'
import { SwitchRow } from './SwitchRow'

function parseObject(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The JSON must be an object')
  }
  return parsed as Record<string, unknown>
}

function initialRule(rule: DnsRule | null, phase: RulePhase): Record<string, unknown> {
  return {
    description: rule?.description,
    expression: rule?.expression ?? '',
    action: rule?.action ?? RULE_PHASE_ACTIONS[phase][0],
    action_parameters: rule?.action_parameters ?? {},
    enabled: rule?.enabled !== false,
  }
}

export function RuleDialog({
  domain,
  phase,
  rule,
  onClose,
  onSaved,
}: {
  domain: string
  phase: RulePhase
  rule: DnsRule | null
  onClose: () => void
  onSaved: () => void
}) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const editing = rule !== null
  const [description, setDescription] = useState(rule?.description ?? '')
  const [expression, setExpression] = useState(rule?.expression ?? '')
  const [action, setAction] = useState(rule?.action ?? RULE_PHASE_ACTIONS[phase][0])
  const [enabled, setEnabled] = useState(rule?.enabled !== false)
  const [parameters, setParameters] = useState(
    rule?.action_parameters ? JSON.stringify(rule.action_parameters, null, 2) : '',
  )
  const [advanced, setAdvanced] = useState(false)
  const [json, setJson] = useState(JSON.stringify(initialRule(rule, phase), null, 2))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  function toggleAdvanced(next: boolean): void {
    if (next) {
      let actionParameters: Record<string, unknown> = {}
      if (parameters.trim()) {
        try {
          actionParameters = parseObject(parameters)
        } catch {
          actionParameters = {}
        }
      }
      setJson(JSON.stringify({
        description: description.trim() || undefined,
        expression,
        action,
        action_parameters: actionParameters,
        enabled,
      }, null, 2))
      setError('')
      setAdvanced(true)
      return
    }
    try {
      const parsed = parseObject(json)
      setDescription(typeof parsed.description === 'string' ? parsed.description : '')
      setExpression(typeof parsed.expression === 'string' ? parsed.expression : '')
      setAction(typeof parsed.action === 'string' ? parsed.action : RULE_PHASE_ACTIONS[phase][0])
      setEnabled(parsed.enabled !== false)
      setParameters(
        parsed.action_parameters && typeof parsed.action_parameters === 'object'
          ? JSON.stringify(parsed.action_parameters, null, 2)
          : '',
      )
      setError('')
      setAdvanced(false)
    } catch (reason) {
      setError(cfErrorText(reason))
    }
  }

  function buildInput(): RuleInput | null {
    if (advanced) {
      let parsed: Record<string, unknown>
      try {
        parsed = parseObject(json)
      } catch (reason) {
        setError(cfErrorText(reason))
        return null
      }
      const nextExpression = typeof parsed.expression === 'string' ? parsed.expression.trim() : ''
      const nextAction = typeof parsed.action === 'string' ? parsed.action.trim() : ''
      if (!nextExpression || !nextAction) {
        setError(t('cloudflare.dns.msg.operation_failed'))
        return null
      }
      const input: RuleInput = {
        expression: nextExpression,
        action: nextAction,
        enabled: parsed.enabled !== false,
      }
      if (typeof parsed.description === 'string' && parsed.description.trim()) {
        input.description = parsed.description.trim()
      }
      if (parsed.action_parameters && typeof parsed.action_parameters === 'object' && !Array.isArray(parsed.action_parameters)) {
        input.action_parameters = parsed.action_parameters as Record<string, unknown>
      }
      return input
    }
    if (!expression.trim() || !action) {
      setError(t('cloudflare.dns.msg.operation_failed'))
      return null
    }
    const input: RuleInput = {
      expression: expression.trim(),
      action,
      enabled,
    }
    if (description.trim()) input.description = description.trim()
    if (parameters.trim()) {
      try {
        input.action_parameters = parseObject(parameters)
      } catch (reason) {
        setError(cfErrorText(reason))
        return null
      }
    }
    return input
  }

  async function submit(): Promise<void> {
    const input = buildInput()
    if (!input) return
    setBusy(true)
    setError('')
    try {
      if (rule) await dnsApi.updateRule(domain, phase, rule.id ?? '', input)
      else await dnsApi.createRule(domain, phase, input)
      toast({
        title: rule ? t('cloudflare.tunnels.msg.rule_updated') : t('cloudflare.tunnels.msg.rule_created'),
        tone: 'success',
      })
      onSaved()
    } catch (reason) {
      const message = cfErrorText(reason)
      setError(message)
      toast({
        title: t('cloudflare.dns.msg.operation_failed'),
        description: message,
        tone: 'danger',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? t('cloudflare.tunnels.rule_modal_title_edit') : t('cloudflare.tunnels.rule_modal_title_add')}
      width={620}
      dismissible={!busy}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>{uiT('common.cancel')}</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {editing ? uiT('common.save') : t('cloudflare.tunnels.add_rule')}
          </Button>
        </>
      )}
    >
      <div className="space-y-3">
        <SwitchRow
          label={t('cloudflare.tunnels.advanced_mode')}
          hint={t('cloudflare.tunnels.advanced_mode_hint')}
          checked={advanced}
          onChange={toggleAdvanced}
        />
        {advanced ? (
          <Field label={t('cloudflare.tunnels.advanced_mode')}>
            <Textarea
              rows={14}
              value={json}
              onChange={(event) => setJson(event.target.value)}
              className="font-mono text-[length:var(--text-11-5)]"
            />
          </Field>
        ) : (
          <>
            <Field label={t('cloudflare.tunnels.rule_description')}>
              <Input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t('cloudflare.tunnels.rule_desc_placeholder')}
              />
            </Field>
            <Field label={t('cloudflare.tunnels.expression')} required>
              <Textarea
                rows={3}
                value={expression}
                onChange={(event) => setExpression(event.target.value)}
                placeholder={t('cloudflare.tunnels.expression_placeholder')}
                className="font-mono text-[length:var(--text-11-5)]"
              />
            </Field>
            <Field label={t('cloudflare.tunnels.table.action')}>
              <div>
                <SelectMenu
                  label={t('cloudflare.tunnels.table.action')}
                  value={action}
                  options={RULE_PHASE_ACTIONS[phase].map((value) => ({ value, label: value }))}
                  onChange={setAction}
                />
              </div>
            </Field>
            <Field label={t('cloudflare.tunnels.action_json')}>
              <Textarea
                rows={6}
                value={parameters}
                onChange={(event) => setParameters(event.target.value)}
                className="font-mono text-[length:var(--text-11-5)]"
              />
            </Field>
            <div className="flex items-center gap-2">
              <Switch checked={enabled} onChange={setEnabled} label={t('cloudflare.tunnels.table.enabled')} />
              <span className="text-[length:var(--text-12-5)] text-[var(--text-secondary)]">
                {enabled ? t('cloudflare.tunnels.table.enabled') : t('cloudflare.tunnels.table.disabled')}
              </span>
            </div>
          </>
        )}
        {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
      </div>
    </Modal>
  )
}
