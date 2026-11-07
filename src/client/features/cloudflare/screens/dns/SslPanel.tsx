/**
 * SSL certificate packs and the Universal SSL switch.
 *
 * A pack is Cloudflare's own certificate bundle; the table shows the hosts, whether it is active and
 * when the first certificate expires. Deleting a pack is irreversible, so it asks first. Universal
 * SSL is one boolean and is written on its own rather than bundled with a Save button.
 */
import { useState } from 'react'
import { Empty, LoadingBlock } from '../../../../components/feedback'
import { confirm } from '../../../../components/overlay'
import { Badge, Button } from '../../../../components/primitives'
import { t as uiT } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { cfErrorText } from '../../api/client'
import { dnsSecurityApi, type SslCertificatePack } from '../../api/dns-security'
import { useCfT } from '../../i18n'
import { TBody, Table, TableScroll, Td, THead, Th, Tr } from '../../components/Table'
import { PanelError } from './PanelError'
import { SwitchRow } from './SwitchRow'
import { usePanelLoad } from './use-panel-load'

function toneFor(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (status) {
    case 'active': return 'success'
    case 'pending_validation':
    case 'pending_issuance':
    case 'pending_deployment':
      return 'warning'
    case 'deleted':
    case 'expired':
      return 'danger'
    default: return 'neutral'
  }
}

function certExpiry(pack: SslCertificatePack): string {
  return pack.certificates.find((entry) => entry.expires_on)?.expires_on ?? ''
}

export function SslPanel({ domain }: { domain: string }) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const { data, loading, error, reload } = usePanelLoad(
    () => dnsSecurityApi.listSslCertificates(domain),
    domain,
  )
  const universal = usePanelLoad(() => dnsSecurityApi.getUniversalSsl(domain), domain)
  const [busy, setBusy] = useState<string | null>(null)
  const packs = data?.certificates ?? []

  async function toggleUniversal(next: boolean): Promise<void> {
    setBusy('universal')
    try {
      const saved = await dnsSecurityApi.updateUniversalSsl(domain, next)
      universal.setData(saved)
      toast({ title: t('cloudflare.dns.msg.settings_updated'), tone: 'success' })
    } catch (reason) {
      toast({ title: t('cloudflare.dns.msg.save_failed'), description: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(null)
    }
  }

  async function remove(pack: SslCertificatePack): Promise<void> {
    const ok = await confirm({
      title: t('cloudflare.dns.msg.delete_confirm'),
      description: pack.hosts.join(', ') || pack.id,
      confirmLabel: uiT('common.delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(pack.id)
    try {
      await dnsSecurityApi.deleteSslCertificate(domain, pack.id)
      toast({ title: t('cloudflare.dns.msg.certificate_deleted'), tone: 'success' })
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
    <div className="space-y-4">
      {error && <PanelError message={error} onRetry={reload} />}

      <section className="space-y-2">
        <h3 className="text-[length:var(--text-12)] font-semibold tracking-wide text-[var(--text-secondary)] uppercase">
          {t('cloudflare.dns.universal_ssl')}
        </h3>
        {universal.loading && !universal.data ? (
          <LoadingBlock />
        ) : universal.error && !universal.data ? (
          <PanelError message={universal.error} onRetry={universal.reload} />
        ) : (
          <SwitchRow
            label={t('cloudflare.dns.universal_ssl_enabled')}
            hint={t('cloudflare.dns.universal_ssl_hint')}
            checked={universal.data?.enabled === true}
            disabled={busy === 'universal'}
            onChange={(next) => void toggleUniversal(next)}
          />
        )}
      </section>

      <section className="space-y-2 border-t border-[var(--border-subtle)] pt-4">
        <h3 className="text-[length:var(--text-12)] font-semibold tracking-wide text-[var(--text-secondary)] uppercase">
          {t('cloudflare.dns.certificate_packs')}
        </h3>
        {packs.length === 0 ? (
          <Empty compact title={t('cloudflare.dns.no_certificates')} />
        ) : (
          <TableScroll label={t('cloudflare.dns.certificate_packs')}>
            <Table>
              <THead>
                <Tr>
                  <Th>{t('cloudflare.dns.certificate_type')}</Th>
                  <Th>{t('cloudflare.dns.certificate_hosts')}</Th>
                  <Th>{t('cloudflare.dns.status')}</Th>
                  <Th>{t('cloudflare.dns.certificate_authority')}</Th>
                  <Th>{t('cloudflare.dns.certificate_expires')}</Th>
                  <Th>{t('cloudflare.tunnels.table.actions')}</Th>
                </Tr>
              </THead>
              <TBody>
                {packs.map((pack) => (
                  <Tr key={pack.id}>
                    <Td className="whitespace-nowrap">{pack.type || '—'}</Td>
                    <Td className="max-w-72 truncate" title={pack.hosts.join(', ')}>
                      {pack.hosts.join(', ') || '—'}
                    </Td>
                    <Td>
                      <Badge tone={toneFor(pack.status)}>{pack.status || '—'}</Badge>
                    </Td>
                    <Td className="whitespace-nowrap text-[var(--text-secondary)]">
                      {pack.certificate_authority || '—'}
                    </Td>
                    <Td className="whitespace-nowrap text-[var(--text-tertiary)]">
                      {certExpiry(pack) || '—'}
                    </Td>
                    <Td>
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={busy === pack.id}
                        onClick={() => void remove(pack)}
                      >
                        {uiT('common.delete')}
                      </Button>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableScroll>
        )}
      </section>
    </div>
  )
}
