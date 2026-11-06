/**
 * Legacy IP Access Rules (the zone's firewall access list): block, challenge or allow one address,
 * range, country or ASN.
 *
 * Cloudflare's own ruleset engine has the newer WAF rules; this list still exists on every zone and
 * is where most readers already keep their IP allow/deny entries. The form mirrors Cloudflare's shape:
 * a mode, a target kind and a value, with the value validated server-side against the chosen target.
 */
import { useState } from 'react'
import { Empty, LoadingBlock } from '../../../../components/feedback'
import { Field, Input, Textarea } from '../../../../components/form'
import { Modal, confirm } from '../../../../components/overlay'
import { Badge, Button } from '../../../../components/primitives'
import { SelectMenu } from '../../../../components/select-menu'
import { t as uiT } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { cfErrorText } from '../../api/client'
import {
  dnsSecurityApi,
  IP_RULE_MODES,
  IP_RULE_TARGETS,
  type IpAccessRule,
  type IpAccessRuleInput,
  type IpRuleMode,
  type IpRuleTarget,
} from '../../api/dns-security'
import { useCfT } from '../../i18n'
import { TBody, Table, TableScroll, Td, THead, Th, Tr } from '../../components/Table'
import { PanelError } from './PanelError'
import { usePanelLoad } from './use-panel-load'

const MODE_LABEL: Record<IpRuleMode, string> = {
  block: 'cloudflare.dns.ip_mode_block',
  challenge: 'cloudflare.dns.ip_mode_challenge',
  js_challenge: 'cloudflare.dns.ip_mode_js_challenge',
  managed_challenge: 'cloudflare.dns.ip_mode_managed_challenge',
  whitelist: 'cloudflare.dns.ip_mode_whitelist',
}

const TARGET_LABEL: Record<IpRuleTarget, string> = {
  ip: 'cloudflare.dns.ip_target_ip',
  ip6: 'cloudflare.dns.ip_target_ip6',
  ip_range: 'cloudflare.dns.ip_target_ip_range',
  country: 'cloudflare.dns.ip_target_country',
  asn: 'cloudflare.dns.ip_target_asn',
}

const EMPTY_FORM: IpAccessRuleInput = { mode: 'block', target: 'ip', value: '', notes: '' }

export function IpAccessPanel({ domain }: { domain: string }) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const { data, loading, error, reload } = usePanelLoad(() => dnsSecurityApi.listIpAccessRules(domain), domain)
  const [editing, setEditing] = useState<IpAccessRule | 'new' | null>(null)
  const [form, setForm] = useState<IpAccessRuleInput>(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  const rules = data?.rules ?? []

  function open(rule: IpAccessRule | 'new'): void {
    if (rule === 'new') {
      setForm(EMPTY_FORM)
    } else {
      setForm({ mode: rule.mode, target: rule.target, value: rule.value, notes: rule.notes })
    }
    setEditing(rule)
  }

  async function save(): Promise<void> {
    setBusy(true)
    try {
      if (editing === 'new') await dnsSecurityApi.createIpAccessRule(domain, form)
      else if (editing) await dnsSecurityApi.updateIpAccessRule(domain, editing.id, form)
      toast({
        title: editing === 'new' ? t('cloudflare.dns.msg.ip_rule_created') : t('cloudflare.dns.msg.ip_rule_updated'),
        tone: 'success',
      })
      setEditing(null)
      reload()
    } catch (reason) {
      toast({ title: t('cloudflare.dns.msg.save_failed'), description: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function remove(rule: IpAccessRule): Promise<void> {
    const ok = await confirm({
      title: t('cloudflare.dns.msg.delete_confirm'),
      description: `${rule.mode} ${rule.value}`,
      confirmLabel: uiT('common.delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      await dnsSecurityApi.deleteIpAccessRule(domain, rule.id)
      toast({ title: t('cloudflare.dns.msg.ip_rule_deleted'), tone: 'success' })
      reload()
    } catch (reason) {
      toast({ title: t('cloudflare.dns.msg.delete_failed'), description: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const canSave = form.value.trim().length > 0

  if (loading && !data) return <LoadingBlock />
  if (error && !data) return <PanelError message={error} onRetry={reload} />

  return (
    <div className="space-y-3">
      {error && <PanelError message={error} onRetry={reload} />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          {t('cloudflare.dns.ip_access_hint')}
        </p>
        <Button size="sm" variant="primary" onClick={() => open('new')}>
          {t('cloudflare.dns.add_ip_rule')}
        </Button>
      </div>
      {rules.length === 0 ? (
        <Empty compact title={t('cloudflare.dns.no_ip_rules')} />
      ) : (
        <TableScroll label={t('cloudflare.dns.ip_access_rules')}>
          <Table>
            <THead>
              <Tr>
                <Th>{t('cloudflare.dns.ip_rule_mode')}</Th>
                <Th>{t('cloudflare.dns.ip_rule_target')}</Th>
                <Th>{t('cloudflare.dns.ip_rule_value')}</Th>
                <Th>{t('cloudflare.dns.ip_rule_notes')}</Th>
                <Th>{t('cloudflare.tunnels.table.actions')}</Th>
              </Tr>
            </THead>
            <TBody>
              {rules.map((rule) => (
                <Tr key={rule.id}>
                  <Td>
                    <Badge tone={rule.mode === 'whitelist' ? 'success' : rule.mode === 'block' ? 'danger' : 'warning'}>
                      {t(MODE_LABEL[rule.mode] as Parameters<typeof t>[0])}
                    </Badge>
                  </Td>
                  <Td className="whitespace-nowrap text-[var(--text-secondary)]">
                    {t(TARGET_LABEL[rule.target] as Parameters<typeof t>[0])}
                  </Td>
                  <Td className="font-mono text-[length:var(--text-11-5)]">{rule.value}</Td>
                  <Td className="max-w-56 truncate text-[var(--text-tertiary)]" title={rule.notes}>
                    {rule.notes || '—'}
                  </Td>
                  <Td>
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => open(rule)}>
                        {uiT('common.edit')}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove(rule)}>
                        {uiT('common.delete')}
                      </Button>
                    </div>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </TableScroll>
      )}

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? t('cloudflare.dns.add_ip_rule') : t('cloudflare.dns.edit_ip_rule')}
        width={520}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={busy}>
              {uiT('common.cancel')}
            </Button>
            <Button variant="primary" loading={busy} disabled={!canSave} onClick={() => void save()}>
              {uiT('common.save')}
            </Button>
          </>
        )}
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('cloudflare.dns.ip_rule_mode')}>
              <div>
                <SelectMenu
                  label={t('cloudflare.dns.ip_rule_mode')}
                  value={form.mode}
                  options={IP_RULE_MODES.map((mode) => ({
                    value: mode,
                    label: t(MODE_LABEL[mode] as Parameters<typeof t>[0]),
                  }))}
                  onChange={(value) => setForm((current) => ({ ...current, mode: value as IpRuleMode }))}
                />
              </div>
            </Field>
            <Field label={t('cloudflare.dns.ip_rule_target')}>
              <div>
                <SelectMenu
                  label={t('cloudflare.dns.ip_rule_target')}
                  value={form.target}
                  options={IP_RULE_TARGETS.map((target) => ({
                    value: target,
                    label: t(TARGET_LABEL[target] as Parameters<typeof t>[0]),
                  }))}
                  onChange={(value) => setForm((current) => ({ ...current, target: value as IpRuleTarget }))}
                />
              </div>
            </Field>
          </div>
          <Field label={t('cloudflare.dns.ip_rule_value')} required>
            <Input
              value={form.value}
              placeholder={t('cloudflare.dns.ip_rule_value_placeholder')}
              onChange={(event) => setForm((current) => ({ ...current, value: event.target.value }))}
            />
          </Field>
          <Field label={t('cloudflare.dns.ip_rule_notes')}>
            <Textarea
              rows={3}
              value={form.notes}
              onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
            />
          </Field>
        </div>
      </Modal>
    </div>
  )
}
