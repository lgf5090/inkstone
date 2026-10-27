/**
 * The Records tab: the zone's DNS records, their proxy switches, and the add/edit/delete actions.
 */
import { useState } from 'react'
import { Empty, LoadingBlock } from '../../../../components/feedback'
import { Switch } from '../../../../components/form'
import { confirm } from '../../../../components/overlay'
import { Badge, Button } from '../../../../components/primitives'
import { CopyButton } from '../../components/CopyButton'
import { Table, TableScroll, TBody, Td, THead, Th, Tr, SortableHead } from '../../components/Table'
import { useSort } from '../../lib/sort'
import { t as uiT } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { cfErrorText } from '../../api/client'
import { dnsApi, type DnsRecord } from '../../api/dns'
import { useCfT } from '../../i18n'
import { PanelError } from './PanelError'
import { RecordDialog } from './RecordDialog'
import { usePanelLoad } from './use-panel-load'

export function RecordsPanel({ domain }: { domain: string }) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const [truncated, setTruncated] = useState(false)
  const { data, loading, error, reload, setData } = usePanelLoad(async () => {
    const listing = await dnsApi.listRecords(domain)
    setTruncated(listing.truncated)
    return listing.records
  }, domain)
  const sort = useSort<DnsRecord>()
  const [editing, setEditing] = useState<{ record: DnsRecord | null } | null>(null)

  const records = data ?? []
  const rows = sort.sorted(records, (record) => (
    (record as unknown as Record<string, unknown>)[sort.state.key ?? '']
  ))

  async function toggleProxy(record: DnsRecord, proxied: boolean): Promise<void> {
    try {
      await dnsApi.updateProxy(domain, record.id, proxied)
      setData((current) => current?.map((item) => (
        item.id === record.id ? { ...item, proxied } : item
      )) ?? current)
      toast({ title: t('cloudflare.dns.msg.proxy_updated'), tone: 'success' })
    } catch (reason) {
      toast({
        title: t('cloudflare.dns.msg.update_failed'),
        description: cfErrorText(reason),
        tone: 'danger',
      })
    }
  }

  async function remove(record: DnsRecord): Promise<void> {
    const ok = await confirm({
      title: t('cloudflare.dns.msg.delete_confirm'),
      description: t('cloudflare.dns.msg.delete_record_confirm', {
        type: record.type,
        name: record.name,
        content: record.content,
      }),
      confirmLabel: uiT('common.delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await dnsApi.deleteRecord(domain, record.id)
      toast({ title: t('cloudflare.dns.msg.record_deleted'), tone: 'success' })
      reload()
    } catch (reason) {
      toast({
        title: t('cloudflare.dns.msg.delete_failed'),
        description: cfErrorText(reason),
        tone: 'danger',
      })
    }
  }

  if (loading && !data) return <LoadingBlock />
  if (error && !data) return <PanelError message={error} onRetry={reload} />

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {t('cloudflare.dns.records')}
        </h3>
        <Button size="sm" variant="primary" onClick={() => setEditing({ record: null })}>
          {t('cloudflare.dns.add_record')}
        </Button>
      </div>

      {error && <PanelError message={error} onRetry={reload} />}

      {truncated && records.length > 0 ? (
        <p className="mb-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          {t('cloudflare.dns.records_truncated', { count: records.length })}
        </p>
      ) : null}

      {records.length === 0 ? (
        <Empty compact title={t('cloudflare.compact_card.no_data')} />
      ) : (
        <TableScroll label={t('cloudflare.dns.records')}>
          <Table>
            <THead>
              <Tr>
                <SortableHead
                  label={t('cloudflare.dns.record_type')}
                  sortKey="type"
                  sort={sort.state}
                  onToggle={sort.toggle}
                />
                <SortableHead
                  label={t('cloudflare.dns.record_name')}
                  sortKey="name"
                  sort={sort.state}
                  onToggle={sort.toggle}
                />
                <SortableHead
                  label={t('cloudflare.dns.record_content')}
                  sortKey="content"
                  sort={sort.state}
                  onToggle={sort.toggle}
                />
                <SortableHead
                  label={t('cloudflare.dns.ttl')}
                  sortKey="ttl"
                  sort={sort.state}
                  onToggle={sort.toggle}
                />
                <SortableHead
                  label={t('cloudflare.dns.proxied')}
                  sortKey="proxied"
                  sort={sort.state}
                  onToggle={sort.toggle}
                />
                <Th>{t('cloudflare.tunnels.table.actions')}</Th>
              </Tr>
            </THead>
            <TBody>
              {rows.map((record) => (
                <Tr key={record.id}>
                  <Td><Badge tone="accent">{record.type}</Badge></Td>
                  <Td className="max-w-40 truncate" title={record.name}>{record.name}</Td>
                  <Td className="max-w-60" title={record.content}>
                    <div className="flex min-w-0 items-center gap-1">
                      <span className="min-w-0 truncate font-mono text-[length:var(--text-11-5)]">{record.content}</span>
                      <CopyButton text={record.content} size="xs" />
                    </div>
                  </Td>
                  <Td>{record.ttl === 1 ? t('cloudflare.dns.ttl_auto') : String(record.ttl)}</Td>
                  <Td>
                    <Switch
                      checked={record.proxied}
                      onChange={(next) => void toggleProxy(record, next)}
                      label={`${t('cloudflare.dns.proxied')} ${record.name}`}
                    />
                  </Td>
                  <Td>
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setEditing({ record })}>
                        {uiT('common.edit')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void remove(record)}>
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

      {editing && (
        <RecordDialog
          domain={domain}
          record={editing.record}
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
