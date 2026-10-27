/**
 * One ruleset rule.
 *
 * The form is the default because a rule is two things a reader rarely wants to type by hand: an
 * expression in Cloudflare's filter language, and an action object whose shape depends on the phase.
 * Five match kinds build the first from a host and a path; the phase's fields build the second. The
 * expression is shown as it is assembled, and the advanced switch hands the whole rule over as JSON
 * for anything the fields cannot say — switching back parses it, so a mistake is caught before saving.
 */
import { useMemo, useState } from 'react'
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
import {
  buildPayload,
  emptyRuleForm,
  formFromRule,
  type RuleFormState,
  type RuleMatchType,
} from './rule-builder'

const MATCH_TYPES: readonly RuleMatchType[] = ['hostname', 'pathPrefix', 'pathRegex', 'hostAndPath', 'custom']

const MATCH_LABEL_KEYS = {
  hostname: 'cloudflare.tunnels.match_hostname',
  pathPrefix: 'cloudflare.tunnels.match_path_prefix',
  pathRegex: 'cloudflare.tunnels.match_path_regex',
  hostAndPath: 'cloudflare.tunnels.match_host_and_path',
  custom: 'cloudflare.tunnels.match_custom',
} as const

const REDIRECT_STATUSES = [301, 302, 307, 308] as const

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
  const [form, setForm] = useState<RuleFormState>(
    rule ? formFromRule(rule, phase, domain) : emptyRuleForm(),
  )
  const [action, setAction] = useState(rule?.action ?? RULE_PHASE_ACTIONS[phase][0])
  const [enabled, setEnabled] = useState(rule?.enabled !== false)
  const [advanced, setAdvanced] = useState(false)
  const [json, setJson] = useState(JSON.stringify(initialRule(rule, phase), null, 2))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const patch = (next: Partial<RuleFormState>): void => setForm((current) => ({ ...current, ...next }))

  const payload = useMemo(
    () => buildPayload(phase, form, domain, action),
    [phase, form, domain, action],
  )

  function toggleAdvanced(next: boolean): void {
    if (next) {
      setJson(JSON.stringify({
        description: description.trim() || undefined,
        expression: payload?.expression ?? form.expression,
        action,
        action_parameters: payload?.action_parameters ?? {},
        enabled,
      }, null, 2))
      setError('')
      setAdvanced(true)
      return
    }
    try {
      const parsed = parseObject(json)
      const expression = typeof parsed.expression === 'string' ? parsed.expression : ''
      setDescription(typeof parsed.description === 'string' ? parsed.description : '')
      setAction(typeof parsed.action === 'string' ? parsed.action : RULE_PHASE_ACTIONS[phase][0])
      setEnabled(parsed.enabled !== false)
      // The fields cannot always describe what the JSON says; the expression is kept verbatim so
      // nothing is lost when the reader switches back.
      setForm((current) => ({ ...current, matchType: 'custom', expression }))
      setError('')
      setAdvanced(false)
    } catch (reason) {
      setError(cfErrorText(reason))
    }
  }

  /** What the form still needs before it can be sent, as the sentence to show. */
  function missingField(): string | null {
    if (!payload) return t('cloudflare.tunnels.expression')
    if (phase === 'redirect' && !form.redirectUrl.trim()) return t('cloudflare.tunnels.rule_redirect_url')
    if ((phase === 'request_headers' || phase === 'response_headers') && !form.headerName.trim()) {
      return t('cloudflare.tunnels.header_name')
    }
    if (phase === 'origin' && (form.port < 1 || form.port > 65535)) return t('cloudflare.tunnels.rule_port')
    if (phase === 'cache_settings' && form.ttlMode === 'custom' && form.ttlSeconds < 0) {
      return t('cloudflare.tunnels.ttl_seconds')
    }
    if (phase === 'rate_limit' && (form.limitPeriod < 1 || form.limitRequests < 1)) {
      return t('cloudflare.tunnels.ratelimit_requests')
    }
    return null
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
    const missing = missingField()
    if (missing) {
      setError(t('cloudflare.tunnels.rule_missing', { field: missing }))
      return null
    }
    if (!payload) return null
    const input: RuleInput = {
      expression: payload.expression,
      action: payload.action,
      action_parameters: payload.action_parameters,
      enabled,
    }
    if (description.trim()) input.description = description.trim()
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

  const phaseActions = RULE_PHASE_ACTIONS[phase]
  const needsActionChoice = phaseActions.length > 1
  const perPhase = (
    <>
      {phase === 'origin' ? (
        <Field label={t('cloudflare.tunnels.rule_port')} required>
          <Input
            type="number"
            min={1}
            max={65535}
            value={String(form.port)}
            onChange={(event) => patch({ port: Number(event.target.value) })}
          />
        </Field>
      ) : null}

      {phase === 'redirect' ? (
        <>
          <Field label={t('cloudflare.tunnels.rule_redirect_url')} required>
            <Input
              value={form.redirectUrl}
              placeholder="https://example.com/new-path"
              onChange={(event) => patch({ redirectUrl: event.target.value })}
            />
          </Field>
          <Field label={t('cloudflare.tunnels.rule_status')}>
            <SelectMenu
              label={t('cloudflare.tunnels.rule_status')}
              value={String(form.redirectStatus)}
              options={REDIRECT_STATUSES.map((status) => ({ value: String(status), label: String(status) }))}
              onChange={(value) => patch({ redirectStatus: Number(value) })}
            />
          </Field>
        </>
      ) : null}

      {phase === 'transform' ? (
        <>
          <Field label={t('cloudflare.tunnels.rewrite_target')}>
            <SelectMenu
              label={t('cloudflare.tunnels.rewrite_target')}
              value={form.rewriteTarget}
              options={[
                { value: 'path', label: t('cloudflare.tunnels.rewrite_path') },
                { value: 'query', label: t('cloudflare.tunnels.rewrite_query') },
              ]}
              onChange={(value) => patch({ rewriteTarget: value === 'query' ? 'query' : 'path' })}
            />
          </Field>
          <Field label={t('cloudflare.tunnels.rewrite_value')} required>
            <Input
              value={form.rewriteValue}
              placeholder={t('cloudflare.tunnels.rewrite_value_placeholder')}
              onChange={(event) => patch({ rewriteValue: event.target.value })}
            />
          </Field>
        </>
      ) : null}

      {phase === 'request_headers' || phase === 'response_headers' ? (
        <>
          <Field label={t('cloudflare.tunnels.header_op')}>
            <SelectMenu
              label={t('cloudflare.tunnels.header_op')}
              value={form.headerOp}
              options={[
                { value: 'set', label: t('cloudflare.tunnels.header_set') },
                { value: 'add', label: t('cloudflare.tunnels.header_add') },
                { value: 'remove', label: t('cloudflare.tunnels.header_remove') },
              ]}
              onChange={(value) => patch({ headerOp: value === 'add' ? 'add' : value === 'remove' ? 'remove' : 'set' })}
            />
          </Field>
          <Field label={t('cloudflare.tunnels.header_name')} required>
            <Input value={form.headerName} onChange={(event) => patch({ headerName: event.target.value })} />
          </Field>
          {form.headerOp !== 'remove' ? (
            <Field label={t('cloudflare.tunnels.header_value')}>
              <Input value={form.headerValue} onChange={(event) => patch({ headerValue: event.target.value })} />
            </Field>
          ) : null}
        </>
      ) : null}

      {phase === 'cache_settings' ? (
        <>
          <SwitchRow
            label={t('cloudflare.tunnels.cache_enabled')}
            checked={form.cacheEnabled}
            onChange={(next) => patch({ cacheEnabled: next })}
          />
          <Field label={t('cloudflare.tunnels.cache_ttl')}>
            <SelectMenu
              label={t('cloudflare.tunnels.cache_ttl')}
              value={form.ttlMode}
              options={[
                { value: 'respect_origin', label: t('cloudflare.tunnels.ttl_respect_origin') },
                { value: 'custom', label: t('cloudflare.tunnels.ttl_custom') },
              ]}
              onChange={(value) => patch({ ttlMode: value === 'custom' ? 'custom' : 'respect_origin' })}
            />
          </Field>
          {form.ttlMode === 'custom' ? (
            <Field label={t('cloudflare.tunnels.ttl_seconds')}>
              <Input
                type="number"
                min={0}
                value={String(form.ttlSeconds)}
                onChange={(event) => patch({ ttlSeconds: Number(event.target.value) })}
              />
            </Field>
          ) : null}
        </>
      ) : null}

      {phase === 'rate_limit' ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('cloudflare.tunnels.ratelimit_period')}>
            <Input
              type="number"
              min={10}
              value={String(form.limitPeriod)}
              onChange={(event) => patch({ limitPeriod: Number(event.target.value) })}
            />
          </Field>
          <Field label={t('cloudflare.tunnels.ratelimit_requests')}>
            <Input
              type="number"
              min={1}
              value={String(form.limitRequests)}
              onChange={(event) => patch({ limitRequests: Number(event.target.value) })}
            />
          </Field>
          <Field label={t('cloudflare.tunnels.ratelimit_mitigation')}>
            <Input
              type="number"
              min={0}
              value={String(form.limitMitigation)}
              onChange={(event) => patch({ limitMitigation: Number(event.target.value) })}
            />
          </Field>
        </div>
      ) : null}
    </>
  )

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

            <Field label={t('cloudflare.tunnels.rule_match_type')}>
              <SelectMenu
                label={t('cloudflare.tunnels.rule_match_type')}
                value={form.matchType}
                options={MATCH_TYPES.map((value) => ({ value, label: t(MATCH_LABEL_KEYS[value]) }))}
                onChange={(value) => patch({ matchType: value as RuleMatchType })}
              />
            </Field>

            {form.matchType === 'hostname' || form.matchType === 'hostAndPath' ? (
              <Field
                label={t('cloudflare.tunnels.rule_subdomain')}
                hint={t('cloudflare.tunnels.rule_subdomain_hint', { zone: domain })}
              >
                <Input
                  value={form.subdomain}
                  placeholder={domain}
                  onChange={(event) => patch({ subdomain: event.target.value })}
                />
              </Field>
            ) : null}

            {form.matchType === 'pathPrefix' || form.matchType === 'pathRegex' || form.matchType === 'hostAndPath' ? (
              <Field label={t('cloudflare.tunnels.rule_path')} required>
                <Input
                  value={form.path}
                  placeholder={t('cloudflare.tunnels.rule_path_placeholder')}
                  onChange={(event) => patch({ path: event.target.value })}
                />
              </Field>
            ) : null}

            {form.matchType === 'custom' ? (
              <Field label={t('cloudflare.tunnels.expression')} required>
                <Textarea
                  rows={3}
                  value={form.expression}
                  onChange={(event) => patch({ expression: event.target.value })}
                  placeholder={t('cloudflare.tunnels.expression_placeholder')}
                  className="font-mono text-[length:var(--text-11-5)]"
                />
              </Field>
            ) : null}

            {needsActionChoice ? (
              <Field label={t('cloudflare.tunnels.table.action')}>
                <SelectMenu
                  label={t('cloudflare.tunnels.table.action')}
                  value={action}
                  options={phaseActions.map((value) => ({ value, label: value }))}
                  onChange={setAction}
                />
              </Field>
            ) : null}

            {perPhase}

            <div className="flex items-center gap-2">
              <Switch checked={enabled} onChange={setEnabled} label={t('cloudflare.tunnels.table.enabled')} />
              <span className="text-[length:var(--text-12-5)] text-[var(--text-secondary)]">
                {enabled ? t('cloudflare.tunnels.table.enabled') : t('cloudflare.tunnels.table.disabled')}
              </span>
            </div>

            <Field label={t('cloudflare.tunnels.rule_preview')}>
              <pre className="max-h-32 overflow-auto rounded-[var(--r-sm)] bg-[var(--bg-sunken)] p-2 font-mono text-[length:var(--text-11)] whitespace-pre-wrap break-all text-[var(--text-secondary)]">
                {payload ? JSON.stringify({ expression: payload.expression, action: payload.action, action_parameters: payload.action_parameters }, null, 2) : '—'}
              </pre>
            </Field>
          </>
        )}
        {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
      </div>
    </Modal>
  )
}
