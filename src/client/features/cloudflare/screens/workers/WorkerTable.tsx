/**
 * The Workers table: one row per script or Pages project, with the account's usage beside it.
 *
 * Usage belongs to the account, not to a single script (Cloudflare reports it per account), so the
 * numbers repeat on each row of that account. The column headers say so by naming the deployment
 * count rather than a per-row deployment list.
 */
import { Badge, Button } from '../../../../components/primitives'
import { SortableHead, TBody, Table, TableScroll, Td, THead, Th, Tr } from '../../components/Table'
import { formatDateTime, formatNumber } from '../../lib/format'
import type { SortState } from '../../lib/sort'
import { useCfT } from '../../i18n'
import type { WorkerRow, WorkerSummary } from '../../api/workers'

const ACTIVE_STATUSES = new Set(['active', 'deployed', 'enabled'])

export function formatCpuTime(ms: number): string {
  if (!ms) return '0ms'
  if (ms >= 1_000_000) return `${(ms / 1_000_000).toFixed(1)}Ks`
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`
  return `${ms.toLocaleString()}ms`
}

function timeText(value: string | null): string {
  if (!value) return '—'
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? formatDateTime(ms) : value
}

export function WorkerTable({
  rows,
  summary,
  loading,
  sort,
  onToggleSort,
  onDeploy,
  onSettings,
  onLogs,
  onDelete,
  isDemo,
}: {
  rows: readonly WorkerRow[]
  summary: Map<string, WorkerSummary>
  loading: boolean
  sort: SortState
  onToggleSort: (key: string) => void
  onDeploy: (row: WorkerRow) => void
  onSettings: (row: WorkerRow) => void
  onLogs: (row: WorkerRow) => void
  onDelete: (row: WorkerRow) => void
  isDemo: (accountId: string) => boolean
}) {
  const t = useCfT()
  const columns = 10

  return (
    <TableScroll label={t('cloudflare.workers.title')}>
      <Table>
        <THead>
          <Tr>
            <SortableHead label={t('cloudflare.workers.table.type')} sortKey="type" sort={sort} onToggle={onToggleSort} className="w-20" />
            <SortableHead label={t('cloudflare.workers.table.name')} sortKey="name" sort={sort} onToggle={onToggleSort} className="w-44" />
            <SortableHead label={t('cloudflare.workers.table.account')} sortKey="account" sort={sort} onToggle={onToggleSort} className="w-32" />
            <SortableHead label={t('cloudflare.workers.table.status')} sortKey="status" sort={sort} onToggle={onToggleSort} className="w-24" />
            <SortableHead label={t('cloudflare.workers.table.modified_time')} sortKey="modified" sort={sort} onToggle={onToggleSort} className="w-36" />
            <SortableHead label={t('cloudflare.workers.table.deploy_count')} sortKey="deployments" sort={sort} onToggle={onToggleSort} className="w-28" />
            <SortableHead label={t('cloudflare.workers.table.requests')} sortKey="requests" sort={sort} onToggle={onToggleSort} className="w-24" />
            <SortableHead label={t('cloudflare.workers.table.errors')} sortKey="errors" sort={sort} onToggle={onToggleSort} className="w-20" />
            <SortableHead label={t('cloudflare.workers.table.cpu_time')} sortKey="cpu" sort={sort} onToggle={onToggleSort} className="w-24" />
            <Th className="w-72">{t('cloudflare.workers.table.actions')}</Th>
          </Tr>
        </THead>
        <TBody>
          {rows.map((row) => {
            const usage = summary.get(row.accountId)
            const active = ACTIVE_STATUSES.has(row.status)
            return (
              <Tr key={`${row.type}-${row.accountId}-${row.name}`}>
                <Td>
                  <Badge tone={row.type === 'pages' ? 'accent' : 'success'}>
                    {row.type === 'pages' ? t('cloudflare.workers.pages') : t('cloudflare.workers.worker')}
                  </Badge>
                </Td>
                <Td className="font-medium">{row.name}</Td>
                <Td className="text-[var(--text-tertiary)]">{row.accountName}</Td>
                <Td>
                  <Badge tone={active ? 'success' : 'neutral'}>
                    {active ? t('cloudflare.workers.table.active') : row.status}
                  </Badge>
                </Td>
                <Td className="whitespace-nowrap text-[var(--text-tertiary)]">{timeText(row.modifiedOn)}</Td>
                <Td className="tabular">{usage ? usage.workerCount + usage.pagesCount : '—'}</Td>
                <Td className="tabular">{usage ? formatNumber(usage.requests) : '—'}</Td>
                <Td className="tabular">{usage ? formatNumber(usage.errors) : '—'}</Td>
                <Td className="tabular">{usage ? formatCpuTime(usage.cpuTimeMs) : '—'}</Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="primary" onClick={() => onDeploy(row)}>
                      {t('cloudflare.workers.table.deploy_btn')}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => onSettings(row)}>
                      {t('cloudflare.workers.table.settings_btn')}
                    </Button>
                    {row.type === 'worker' && (
                      <Button size="sm" variant="secondary" onClick={() => onLogs(row)}>
                        {t('cloudflare.workers.table.logs_btn')}
                      </Button>
                    )}
                    {!isDemo(row.accountId) && (
                      <Button size="sm" variant="danger" onClick={() => onDelete(row)}>
                        {t('cloudflare.workers.table.delete_btn')}
                      </Button>
                    )}
                  </div>
                </Td>
              </Tr>
            )
          })}
          {rows.length === 0 && !loading && (
            <Tr>
              <Td colSpan={columns} className="py-10 text-center text-[var(--text-tertiary)]">
                {t('share.no_data_yet')}
              </Td>
            </Tr>
          )}
          {loading && (
            <Tr>
              <Td colSpan={columns} className="py-10 text-center text-[var(--text-tertiary)]">
                {t('common.loading')}
              </Td>
            </Tr>
          )}
        </TBody>
      </Table>
    </TableScroll>
  )
}
