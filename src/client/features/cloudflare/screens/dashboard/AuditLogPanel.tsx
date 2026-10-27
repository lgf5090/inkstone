/**
 * The reader's recent Cloudflare activity, filtered and paged by the server.
 *
 * The source screen fetched a capped list and filtered it in the browser; a table with a page
 * control cannot work that way, because the browser only ever holds one page. Every filter, the sort
 * and the offset therefore go to the route, and the table renders exactly what came back.
 */
import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { CloudflareAuditLog } from '@shared/cloudflare/model'
import { LoadingBlock } from '../../../../components/feedback'
import { Field } from '../../../../components/form'
import { Badge, Button, IconButton } from '../../../../components/primitives'
import { SelectMenu } from '../../../../components/select-menu'
import { t } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { cfErrorText } from '../../api/client'
import { getAuditActions, getAuditLogs } from '../../api/dashboard'
import { useCfT, type CloudflareMessageKey } from '../../i18n'
import { formatDateTime } from '../../lib/format'
import { useSort } from '../../lib/sort'
import { SearchField } from '../../components/SearchField'
import { SortableHead, TBody, Table, TableScroll, Td, THead, Tr } from '../../components/Table'
import { Panel, PanelError } from './Panel'
import { DatePicker } from '../../../../components/date-picker'

const PAGE_SIZE = 20

const ACTION_LABEL_KEYS: Record<string, CloudflareMessageKey> = {
  ai_chat_completion: 'cloudflare.dashboard.actions.ai_chat_completion',
  batch_deploy: 'cloudflare.dashboard.actions.batch_deploy',
  batch_deploy_pages: 'cloudflare.dashboard.actions.batch_deploy_pages',
  browser_render: 'cloudflare.dashboard.actions.browser_render',
  clear_exhausted: 'cloudflare.dashboard.actions.clear_exhausted',
  create_account: 'cloudflare.dashboard.actions.create_account',
  create_dns: 'cloudflare.dashboard.actions.create_dns',
  delete_account: 'cloudflare.dashboard.actions.delete_account',
  delete_dns: 'cloudflare.dashboard.actions.delete_dns',
  delete_pages: 'cloudflare.dashboard.actions.delete_pages',
  delete_worker: 'cloudflare.dashboard.actions.delete_worker',
  deploy_pages: 'cloudflare.dashboard.actions.deploy_pages',
  deploy_worker: 'cloudflare.dashboard.actions.deploy_worker',
  env_sync: 'cloudflare.dashboard.actions.env_sync',
  import_account: 'cloudflare.dashboard.actions.import_account',
  kv_write: 'cloudflare.dashboard.actions.kv_write',
  task_create: 'cloudflare.dashboard.actions.task_create',
  task_delete: 'cloudflare.dashboard.actions.task_delete',
  task_run: 'cloudflare.dashboard.actions.task_run',
  test_account: 'cloudflare.dashboard.actions.test_account',
  update_dns: 'cloudflare.dashboard.actions.update_dns',
  update_features: 'cloudflare.dashboard.actions.update_features',
  view_credentials: 'cloudflare.dashboard.actions.view_credentials',
}

interface Filters {
  action: string
  q: string
  from: string
  to: string
}

const EMPTY_FILTERS: Filters = { action: '', q: '', from: '', to: '' }

export function AuditLogPanel() {
  const tcf = useCfT()
  const toast = useUi((state) => state.toast)
  const [actions, setActions] = useState<string[]>([])
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS)
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS)
  const [page, setPage] = useState(1)
  const [logs, setLogs] = useState<CloudflareAuditLog[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const sort = useSort<CloudflareAuditLog>()

  const sortParam = sort.state.key && sort.state.dir
    ? `${sort.state.dir === 'desc' ? '-' : ''}${sort.state.key}`
    : '-created_at'

  useEffect(() => {
    let cancelled = false
    // Best effort: the list answer carries the same distinct actions, so a failure here only leaves
    // the menu one response behind, and the next query fills it.
    void getAuditActions()
      .then((body) => {
        if (!cancelled) setActions(body.actions)
      })
      .catch((failure: unknown) => {
        console.warn('[inkstone] Cloudflare audit action list failed:', cfErrorText(failure))
      })
    return () => {
      cancelled = true
    }
  }, [reload])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void getAuditLogs({
      action: applied.action,
      q: applied.q,
      from: applied.from,
      to: applied.to,
      page,
      pageSize: PAGE_SIZE,
      sort: sortParam,
    })
      .then((body) => {
        if (cancelled) return
        setLogs(body.logs)
        setTotal(body.total)
        if (body.actions.length > 0) setActions(body.actions)
      })
      .catch((failure: unknown) => {
        if (cancelled) return
        const message = cfErrorText(failure)
        setError(message)
        setLogs([])
        setTotal(0)
        toast({ title: t('common.action_failed'), description: message, tone: 'danger' })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [applied, page, reload, sortParam, toast])

  const actionLabel = (action: string): string => {
    const key = ACTION_LABEL_KEYS[action]
    return key ? tcf(key) : action
  }
  const actionOptions = [
    { value: '', label: tcf('cloudflare.dashboard.action_type') },
    ...actions.map((action) => ({ value: action, label: actionLabel(action) })),
  ]
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const applyFilters = () => {
    setApplied({ ...draft })
    setPage(1)
  }
  const toggleSort = (key: string) => {
    sort.toggle(key)
    setPage(1)
  }

  return (
    <Panel
      title={(
        <span className="flex items-center gap-2">
          {tcf('cloudflare.dashboard.recent_logs')}
          <Badge tone="neutral">{total}</Badge>
        </span>
      )}
      bodyClassName="space-y-2"
    >
      <div className="flex flex-wrap items-end gap-2">
        <SearchField
          value={draft.q}
          onChange={(value) => setDraft((current) => ({ ...current, q: value }))}
          placeholder={tcf('cloudflare.dashboard.search_logs')}
          label={tcf('cloudflare.dashboard.search_logs')}
          onSubmit={applyFilters}
          className="w-52"
        />
        <SelectMenu
          label={tcf('cloudflare.dashboard.action_type')}
          value={draft.action}
          options={actionOptions}
          onChange={(value) => setDraft((current) => ({ ...current, action: value }))}
          placeholder={tcf('cloudflare.dashboard.action_type')}
          width={190}
          className="w-44"
        />
        <Field label={tcf('cloudflare.dashboard.start_date')} className="w-36">
          <DatePicker
            label={tcf('cloudflare.dashboard.start_date')}
            value={draft.from}
            onChange={(next) => setDraft((current) => ({ ...current, from: next }))}
          />
        </Field>
        <Field label={tcf('cloudflare.dashboard.end_date')} className="w-36">
          <DatePicker
            label={tcf('cloudflare.dashboard.end_date')}
            value={draft.to}
            onChange={(next) => setDraft((current) => ({ ...current, to: next }))}
          />
        </Field>
        <Button size="sm" loading={loading} onClick={applyFilters}>
          {tcf('cloudflare.dashboard.query')}
        </Button>
      </div>

      {error ? (
        <PanelError message={error} onRetry={() => setReload((value) => value + 1)} />
      ) : null}

      {loading && logs.length === 0 ? (
        <LoadingBlock />
      ) : error && logs.length === 0 ? null : (
        <>
          <TableScroll label={tcf('cloudflare.dashboard.recent_logs')}>
            <Table>
              <THead>
                <Tr>
                  <SortableHead label={tcf('cloudflare.dashboard.time')} sortKey="created_at" sort={sort.state} onToggle={toggleSort} />
                  <SortableHead label={tcf('cloudflare.dashboard.account')} sortKey="account_name" sort={sort.state} onToggle={toggleSort} />
                  <SortableHead label={tcf('cloudflare.dashboard.action')} sortKey="action" sort={sort.state} onToggle={toggleSort} />
                  <SortableHead label={tcf('cloudflare.dashboard.target')} sortKey="target" sort={sort.state} onToggle={toggleSort} />
                  <SortableHead label={tcf('cloudflare.dashboard.detail')} sortKey="detail" sort={sort.state} onToggle={toggleSort} />
                  <SortableHead label={tcf('cloudflare.dashboard.status')} sortKey="status" sort={sort.state} onToggle={toggleSort} />
                </Tr>
              </THead>
              <TBody>
                {logs.map((row) => (
                  <Tr key={row.id}>
                    <Td className="whitespace-nowrap text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                      {formatDateTime(row.created_at)}
                    </Td>
                    <Td className="whitespace-nowrap">{row.account_name ?? '—'}</Td>
                    <Td className="whitespace-nowrap">{actionLabel(row.action)}</Td>
                    <Td>
                      <span className="block max-w-40 truncate" title={row.target ?? undefined}>
                        {row.target ?? '—'}
                      </span>
                    </Td>
                    <Td>
                      <span className="block max-w-48 truncate" title={row.detail ?? undefined}>
                        {row.detail ?? '—'}
                      </span>
                    </Td>
                    <Td>
                      <Badge tone={row.status === 'success' ? 'success' : 'danger'}>
                        {row.status === 'success'
                          ? tcf('cloudflare.dashboard.status_success')
                          : tcf('cloudflare.dashboard.status_error')}
                      </Badge>
                    </Td>
                  </Tr>
                ))}
                {logs.length === 0 ? (
                  <Tr>
                    <Td colSpan={6} className="py-8 text-center text-[var(--text-tertiary)]">
                      {t('command.no_matching_results')}
                    </Td>
                  </Tr>
                ) : null}
              </TBody>
            </Table>
          </TableScroll>

          <div className="flex items-center justify-end gap-2">
            <IconButton
              label={t('reading.previous_page')}
              size="sm"
              disabled={page <= 1 || loading}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              <ChevronLeft size={14} aria-hidden="true" />
            </IconButton>
            <span aria-live="polite" className="min-w-12 text-center text-[length:var(--text-11-5)] tabular-nums text-[var(--text-tertiary)]">
              {page} / {pages}
            </span>
            <IconButton
              label={t('reading.next_page')}
              size="sm"
              disabled={page >= pages || loading}
              onClick={() => setPage((value) => Math.min(pages, value + 1))}
            >
              <ChevronRight size={14} aria-hidden="true" />
            </IconButton>
          </div>
        </>
      )}
    </Panel>
  )
}
