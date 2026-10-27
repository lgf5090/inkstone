/**
 * The account table: selection, sorting, the quota glance, and each row's actions.
 *
 * Row actions that mutate a demo account are disabled here for the reader's benefit; the route's
 * `assertNotDemo` is what actually refuses them. The more-menu is a `Menu`, so its rows are real
 * menu items and the keyboard behaves the way the rest of the app does.
 */
import { useRef, useState, type ReactNode } from 'react'
import type { AccountQuotaView, CloudflareAccount } from '@shared/cloudflare/model'
import { t } from '../../../../lib/i18n'
import { Badge, Button } from '../../../../components/primitives'
import { Checkbox } from '../../../../components/form'
import { LoadingBlock } from '../../../../components/feedback'
import { Menu, type MenuItem } from '../../../../components/overlay'
import { cfT } from '../../i18n'
import { formatDateTime, percentLabel, percentOf } from '../../lib/format'
import { quotaTone } from '../../lib/quota-view'
import type { SortState } from '../../lib/sort'
import { Table, TableScroll, TBody, Td, THead, Th, Tr, SortableHead } from '../../components/Table'
import { authTypeLabel, enabledFeatures, featureLabel } from './labels'

const COLUMN_COUNT = 9

export interface AccountTableProps {
  accounts: CloudflareAccount[]
  quota: Map<string, AccountQuotaView>
  sort: SortState
  onToggleSort: (key: string) => void
  selected: ReadonlySet<string>
  allChecked: boolean
  onToggleAll: () => void
  onToggleRow: (id: string) => void
  loading: boolean
  testingId: string | null
  onEdit: (account: CloudflareAccount) => void
  onCredentials: (account: CloudflareAccount) => void
  onTest: (account: CloudflareAccount) => void
  onFeatures: (account: CloudflareAccount) => void
  onClearExhausted: (account: CloudflareAccount) => void
  onDelete: (account: CloudflareAccount) => void
  emptyAction: ReactNode
}

export function AccountTable(props: AccountTableProps) {
  const {
    accounts,
    quota,
    sort,
    onToggleSort,
    selected,
    allChecked,
    onToggleAll,
    onToggleRow,
    loading,
    testingId,
    emptyAction,
  } = props

  return (
    <div aria-busy={loading || undefined}>
      <TableScroll label={cfT('cloudflare.accounts.title')}>
        <Table>
          <caption className="sr-only">{cfT('cloudflare.accounts.title')}</caption>
          <THead>
            <Tr>
              <Th className="w-10">
                <Checkbox
                  checked={allChecked}
                  onChange={onToggleAll}
                  label={<span className="sr-only">{t('templates.select_all')}</span>}
                />
              </Th>
              <SortableHead
                label={cfT('cloudflare.accounts.table.name')}
                sortKey="name"
                sort={sort}
                onToggle={onToggleSort}
                className="min-w-40"
              />
              <SortableHead
                label={cfT('cloudflare.accounts.table.account_id')}
                sortKey="cf_account_id"
                sort={sort}
                onToggle={onToggleSort}
                className="min-w-36"
              />
              <SortableHead
                label={cfT('cloudflare.accounts.table.auth_type')}
                sortKey="auth_type"
                sort={sort}
                onToggle={onToggleSort}
              />
              <SortableHead
                label={cfT('cloudflare.accounts.table.features')}
                sortKey="features"
                sort={sort}
                onToggle={onToggleSort}
                className="min-w-32"
              />
              <SortableHead
                label={t('common.created')}
                sortKey="created_at"
                sort={sort}
                onToggle={onToggleSort}
              />
              <SortableHead
                label={cfT('cloudflare.accounts.table.status')}
                sortKey="status"
                sort={sort}
                onToggle={onToggleSort}
              />
              <Th className="min-w-28">{cfT('cloudflare.accounts.table.ai_quota')}</Th>
              <Th sticky className="text-right">{cfT('cloudflare.accounts.table.actions')}</Th>
            </Tr>
          </THead>
          <TBody>
            {accounts.map((account) => (
              <AccountRow
                key={account.id}
                account={account}
                quota={quota.get(account.id)}
                checked={selected.has(account.id)}
                testing={testingId === account.id}
                onToggle={onToggleRow}
                onEdit={props.onEdit}
                onCredentials={props.onCredentials}
                onTest={props.onTest}
                onFeatures={props.onFeatures}
                onClearExhausted={props.onClearExhausted}
                onDelete={props.onDelete}
              />
            ))}
            {accounts.length === 0 && (
              <Tr>
                <Td colSpan={COLUMN_COUNT}>
                  {loading ? <LoadingBlock /> : emptyAction}
                </Td>
              </Tr>
            )}
          </TBody>
        </Table>
      </TableScroll>
    </div>
  )
}

function AccountRow({
  account,
  quota,
  checked,
  testing,
  onToggle,
  onEdit,
  onCredentials,
  onTest,
  onFeatures,
  onClearExhausted,
  onDelete,
}: {
  account: CloudflareAccount
  quota: AccountQuotaView | undefined
  checked: boolean
  testing: boolean
  onToggle: (id: string) => void
  onEdit: (account: CloudflareAccount) => void
  onCredentials: (account: CloudflareAccount) => void
  onTest: (account: CloudflareAccount) => void
  onFeatures: (account: CloudflareAccount) => void
  onClearExhausted: (account: CloudflareAccount) => void
  onDelete: (account: CloudflareAccount) => void
}) {
  const ai = quota?.resources.find((resource) => resource.resource === 'ai_neurons')
  const available = (account.available_features || '').split(',').map((part) => part.trim())

  return (
    <Tr>
      <Td>
        <Checkbox
          checked={checked}
          onChange={() => onToggle(account.id)}
          label={<span className="sr-only">{account.name}</span>}
        />
      </Td>
      <Td className="max-w-48">
        <span className="block truncate font-medium" title={account.name}>{account.name}</span>
        {account.email && (
          <span className="block truncate text-[length:var(--text-11)] text-[var(--text-quaternary)]" title={account.email}>
            {account.email}
          </span>
        )}
      </Td>
      <Td className="max-w-48">
        <span className="block truncate font-mono text-[length:var(--text-11-5)]" title={account.cf_account_id ?? undefined}>
          {account.cf_account_id || '—'}
        </span>
      </Td>
      <Td>
        <Badge tone={account.auth_type === 'token' ? 'accent' : 'warning'}>
          {authTypeLabel(account.auth_type, true)}
        </Badge>
      </Td>
      <Td>
        <div className="flex flex-wrap gap-1">
          {enabledFeatures(account.enabled_features).map((feature) => (
            <Badge key={feature} tone="success">{featureLabel(feature)}</Badge>
          ))}
          {available.includes('r2') && <Badge tone="accent">{cfT('cloudflare.accounts.table.r2')}</Badge>}
          {available.includes('-r2') && (
            <Badge className="line-through opacity-50">{cfT('cloudflare.accounts.table.r2')}</Badge>
          )}
        </div>
      </Td>
      <Td className="whitespace-nowrap text-[var(--text-tertiary)]">{formatDateTime(account.created_at)}</Td>
      <Td className="whitespace-nowrap">
        {account.is_demo
          ? <Badge tone="warning">{cfT('cloudflare.settings.demo_accounts')}</Badge>
          : <Badge tone={account.is_active ? 'success' : 'neutral'}>{account.is_active ? t('common.on') : t('common.off')}</Badge>}
      </Td>
      <Td>
        {ai ? <QuotaCell count={ai.count} limit={ai.limit} exhausted={ai.exhausted} /> : <span className="text-[var(--text-quaternary)]">—</span>}
      </Td>
      <Td sticky>
        <RowActions
          account={account}
          testing={testing}
          exhausted={ai?.exhausted ?? false}
          onEdit={onEdit}
          onCredentials={onCredentials}
          onTest={onTest}
          onFeatures={onFeatures}
          onClearExhausted={onClearExhausted}
          onDelete={onDelete}
        />
      </Td>
    </Tr>
  )
}

function QuotaCell({ count, limit, exhausted }: { count: number; limit: number; exhausted: boolean }) {
  const percent = percentOf(count, limit)
  return (
    <div className="flex w-full max-w-28 flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <span className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{percentLabel(count, limit)}</span>
        {exhausted && <Badge tone="danger">{cfT('cloudflare.accounts.table.exhausted')}</Badge>}
      </div>
      <div
        role="progressbar"
        aria-label={cfT('cloudflare.accounts.table.ai_quota')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-sunken)]"
      >
        <div className="h-full rounded-full" style={{ width: `${percent}%`, backgroundColor: quotaTone(percent) }} />
      </div>
    </div>
  )
}

function RowActions({
  account,
  testing,
  exhausted,
  onEdit,
  onCredentials,
  onTest,
  onFeatures,
  onClearExhausted,
  onDelete,
}: {
  account: CloudflareAccount
  testing: boolean
  exhausted: boolean
  onEdit: (account: CloudflareAccount) => void
  onCredentials: (account: CloudflareAccount) => void
  onTest: (account: CloudflareAccount) => void
  onFeatures: (account: CloudflareAccount) => void
  onClearExhausted: (account: CloudflareAccount) => void
  onDelete: (account: CloudflareAccount) => void
}) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const locked = account.is_demo
  const items: MenuItem[] = [
    {
      id: 'credentials',
      label: cfT('cloudflare.accounts.table.view_cred'),
      disabled: locked,
      onSelect: () => onCredentials(account),
    },
    {
      id: 'features',
      label: cfT('cloudflare.accounts.table.feature_switch'),
      disabled: locked,
      onSelect: () => onFeatures(account),
    },
    ...(exhausted
      ? [{
        id: 'clear-exhausted',
        label: cfT('cloudflare.accounts.table.clear_exhausted'),
        disabled: locked,
        onSelect: () => onClearExhausted(account),
      }]
      : []),
    {
      id: 'delete',
      label: cfT('cloudflare.accounts.table.delete_account'),
      tone: 'danger',
      separatorBefore: true,
      disabled: locked,
      onSelect: () => onDelete(account),
    },
  ]

  return (
    <div className="flex items-center justify-end gap-1">
      <Button size="sm" variant="secondary" disabled={locked} onClick={() => onEdit(account)}>
        {t('common.edit')}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        loading={testing}
        disabled={locked || testing}
        onClick={() => onTest(account)}
      >
        {t('settings.test')}
      </Button>
      <Button
        ref={anchor}
        size="sm"
        variant="secondary"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={locked}
        onClick={() => setOpen(true)}
      >
        {cfT('cloudflare.accounts.table.more')}
      </Button>
      <Menu
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        align="end"
        width={200}
        label={cfT('cloudflare.accounts.table.more')}
      />
    </div>
  )
}
