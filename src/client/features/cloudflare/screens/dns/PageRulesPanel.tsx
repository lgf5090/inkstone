/**
 * Legacy Page Rules: list, toggle and delete.
 *
 * The reference client deliberately does not create or edit Page Rules — Cloudflare's own dashboard
 * is the editor for this deprecated feature. Reading, enabling and deleting are the operations the
 * screen offers, and each write is followed by a reload so the table never drifts from Cloudflare.
 */
import { useState } from 'react'
import { Empty, LoadingBlock } from '../../../../components/feedback'
import { confirm } from '../../../../components/overlay'
import { Badge, Button } from '../../../../components/primitives'
import { t as uiT } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { cfErrorText } from '../../api/client'
import { dnsSecurityApi, type PageRule } from '../../api/dns-security'
import { useCfT } from '../../i18n'
import { TBody, Table, TableScroll, Td, THead, Th, Tr } from '../../components/Table'
import { PanelError } from './PanelError'
import { usePanelLoad } from './use-panel-load'

export function PageRulesPanel({ domain }: { domain: string }) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const { data, loading, error, reload } = usePanelLoad(() => dnsSecurityApi.listPageRules(domain), domain)
  const [busy, setBusy] = useState<string | null>(null)
  const rules = data?.pageRules ?? []

  async function toggle(rule: PageRule): Promise<void> {
    setBusy(rule.id)
    try {
      const status = rule.status === 'active' ? 'disabled' : 'active'
      await dnsSecurityApi.updatePageRuleStatus(domain, rule.id, status)
      toast({ title: t('cloudflare.dns.msg.page_rule_updated'), tone: 'success' })
      reload()
    } catch (reason) {
      toast({ title: t('cloudflare.dns.msg.update_failed'), description: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(null)
    }
  }

  async function remove(rule: PageRule): Promise<void> {
    const ok = await confirm({
      title: t('cloudflare.dns.msg.delete_confirm'),
      description: rule.target || rule.id,
      confirmLabel: uiT('common.delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(rule.id)
    try {
      await dnsSecurityApi.deletePageRule(domain, rule.id)
      toast({ title: t('cloudflare.dns.msg.page_rule_deleted'), tone: 'success' })
      reload()
    } catch (reason) {
      toast({ title: t('cloudflare.dns.msg.delete_failed'), description: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(null)
    }
  }

  if (loading && !data) return <LoadingBlock />
  if (error && !data) return <PanelError message={error} onRetry={reload} />

  return (
    <div className="space-y-3">
      {error && <PanelError message={error} onRetry={reload} />}
      {rules.length === 0 ? (
        <Empty compact title={t('cloudflare.dns.no_page_rules')} />
      ) : (
        <TableScroll label={t('cloudflare.dns.page_rules')}>
          <Table>
            <THead>
              <Tr>
                <Th>{t('cloudflare.dns.page_rule_target')}</Th>
                <Th>{t('cloudflare.dns.page_rule_actions')}</Th>
                <Th>{t('cloudflare.dns.status')}</Th>
                <Th>{t('cloudflare.tunnels.table.actions')}</Th>
              </Tr>
            </THead>
            <TBody>
              {rules.map((rule) => {
                const active = rule.status === 'active'
                return (
                  <Tr key={rule.id}>
                    <Td className="max-w-80 truncate font-mono text-[length:var(--text-11-5)]" title={rule.target}>
                      {rule.target || '—'}
                    </Td>
                    <Td className="text-[var(--text-secondary)]">{rule.action_ids.join(' · ') || '—'}</Td>
                    <Td>
                      <Badge tone={active ? 'success' : 'neutral'}>
                        {active ? t('cloudflare.dns.status_active') : t('cloudflare.dns.status_paused')}
                      </Badge>
                    </Td>
                    <Td>
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={busy === rule.id}
                          onClick={() => void toggle(rule)}
                        >
                          {active ? t('cloudflare.dns.disable') : t('cloudflare.dns.enable')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy === rule.id}
                          onClick={() => void remove(rule)}
                        >
                          {uiT('common.delete')}
                        </Button>
                      </div>
                    </Td>
                  </Tr>
                )
              })}
            </TBody>
          </Table>
        </TableScroll>
      )}
    </div>
  )
}
