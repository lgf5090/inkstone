/**
 * The Rules engine tab: one phase at a time, its rules in a table, and a dialog that creates,
 * edits or deletes them.
 */
import { useState } from 'react'
import { Empty, LoadingBlock } from '../../../../components/feedback'
import { Field } from '../../../../components/form'
import { confirm } from '../../../../components/overlay'
import { Badge, Button } from '../../../../components/primitives'
import { SelectMenu } from '../../../../components/select-menu'
import { Table, TableScroll, TBody, Td, THead, Th, Tr } from '../../components/Table'
import { t as uiT } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { cfErrorText } from '../../api/client'
import { dnsApi, type DnsRule, type RulePhase } from '../../api/dns'
import { useCfT } from '../../i18n'
import { RULE_PHASE_CHOICES } from './options'
import { PanelError } from './PanelError'
import { RuleDialog } from './RuleDialog'
import { usePanelLoad } from './use-panel-load'

export function RulesPanel({ domain }: { domain: string }) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const [phase, setPhase] = useState<RulePhase>('origin')
  const { data, loading, error, reload } = usePanelLoad(
    () => dnsApi.listRules(domain, phase),
    `${domain}:${phase}`,
  )
  const [editing, setEditing] = useState<{ rule: DnsRule | null } | null>(null)
  const rules = data?.rules ?? []

  async function remove(rule: DnsRule): Promise<void> {
    if (!rule.id) return
    const ok = await confirm({
      title: t('cloudflare.dns.msg.delete_confirm'),
      description: t('cloudflare.tunnels.table.rule_delete_confirm'),
      confirmLabel: uiT('common.delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await dnsApi.deleteRule(domain, phase, rule.id)
      toast({ title: t('cloudflare.tunnels.msg.rule_deleted'), tone: 'success' })
      reload()
    } catch (reason) {
      toast({
        title: t('cloudflare.dns.msg.delete_failed'),
        description: cfErrorText(reason),
        tone: 'danger',
      })
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="w-full max-w-64">
          <Field label={t('cloudflare.tunnels.rule_phase')}>
            <div>
              <SelectMenu
                label={t('cloudflare.tunnels.rule_phase')}
                value={phase}
                options={RULE_PHASE_CHOICES.map((choice) => ({
                  value: choice.value,
                  label: t(choice.labelKey),
                }))}
                onChange={setPhase}
                width={280}
              />
            </div>
          </Field>
        </div>
        <Button size="sm" variant="primary" onClick={() => setEditing({ rule: null })}>
          {t('cloudflare.tunnels.add_rule')}
        </Button>
      </div>

      {loading ? (
        <LoadingBlock />
      ) : error && !data ? (
        <PanelError message={error} onRetry={reload} />
      ) : rules.length === 0 ? (
        <>
          {error && <PanelError message={error} onRetry={reload} />}
          <Empty compact title={uiT('share.dashboard.no_data_yet')} />
        </>
      ) : (
        <>
          {error && <PanelError message={error} onRetry={reload} />}
          <TableScroll label={t('cloudflare.tunnels.rules_engine')}>
            <Table>
              <THead>
                <Tr>
                  <Th>{t('cloudflare.tunnels.table.description')}</Th>
                  <Th>{t('cloudflare.tunnels.table.expression')}</Th>
                  <Th>{t('cloudflare.tunnels.table.action')}</Th>
                  <Th>{t('cloudflare.tunnels.table.status')}</Th>
                  <Th>{t('cloudflare.tunnels.table.actions')}</Th>
                </Tr>
              </THead>
              <TBody>
                {rules.map((rule, index) => (
                  <Tr key={rule.id ?? `${rule.expression}-${index}`}>
                    <Td className="max-w-40 truncate text-[var(--text-secondary)]">{rule.description || '—'}</Td>
                    <Td className="max-w-80 truncate font-mono text-[length:var(--text-11-5)]">{rule.expression}</Td>
                    <Td><Badge tone="neutral">{rule.action}</Badge></Td>
                    <Td>
                      <Badge tone={rule.enabled === false ? 'neutral' : 'success'}>
                        {rule.enabled === false
                          ? t('cloudflare.tunnels.table.disabled')
                          : t('cloudflare.tunnels.table.enabled')}
                      </Badge>
                    </Td>
                    <Td>
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!rule.id}
                          onClick={() => setEditing({ rule })}
                        >
                          {uiT('common.edit')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!rule.id}
                          onClick={() => void remove(rule)}
                        >
                          {uiT('common.delete')}
                        </Button>
                      </div>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableScroll>
        </>
      )}

      {editing && (
        <RuleDialog
          domain={domain}
          phase={phase}
          rule={editing.rule}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            reload()
          }}
        />
      )}
    </div>
  )
}
