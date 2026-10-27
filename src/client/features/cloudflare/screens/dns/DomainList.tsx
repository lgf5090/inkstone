/**
 * The left column: every domain, filtered by account and name, with multi-select for batch delete.
 *
 * A domain row is a checkbox and a button side by side rather than one clickable box: the checkbox
 * selects for deletion and the button opens the domain, and a nested button would make both actions
 * unreachable by keyboard.
 */
import { Checkbox } from '../../../../components/form'
import { Empty, LoadingBlock } from '../../../../components/feedback'
import { Button } from '../../../../components/primitives'
import { SearchField } from '../../components/SearchField'
import { SelectMenu } from '../../../../components/select-menu'
import { cn } from '../../../../lib/cn'
import { t as uiT } from '../../../../lib/i18n'
import type { DnsAccountOption, DnsZone } from '../../api/dns'
import { useCfT } from '../../i18n'
import { statusText } from './options'
import { PanelError } from './PanelError'

export function DomainList({
  domains,
  accounts,
  loading,
  error,
  selected,
  selection,
  query,
  accountFilter,
  onQueryChange,
  onAccountFilterChange,
  onSelect,
  onToggleSelected,
  onSelectAll,
  onReload,
  onAdd,
  onDelete,
}: {
  domains: DnsZone[]
  accounts: DnsAccountOption[]
  loading: boolean
  error: string | null
  selected: string | null
  selection: ReadonlySet<string>
  query: string
  accountFilter: string
  onQueryChange: (value: string) => void
  onAccountFilterChange: (value: string) => void
  onSelect: (domain: string) => void
  onToggleSelected: (domain: string) => void
  onSelectAll: (domains: DnsZone[], checked: boolean) => void
  onReload: () => void
  onAdd: () => void
  onDelete: (domains: string[]) => void
}) {
  const t = useCfT()
  const allSelected = domains.length > 0 && domains.every((domain) => selection.has(domain.name))
  const accountOptions = [
    { value: '', label: t('cloudflare.dns.all_accounts') },
    ...accounts.map((account) => ({ value: account.id, label: account.name })),
  ]

  return (
    <aside className="flex min-h-0 flex-col overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] max-lg:max-h-[46vh]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {t('cloudflare.dns.domain_list')}
        </h2>
        {selection.size > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
              {t('cloudflare.dns.selected_count', { count: selection.size })}
            </span>
            <Button
              size="sm"
              variant="danger"
              onClick={() => onDelete([...selection])}
            >
              {t('cloudflare.dns.delete_selected', { count: selection.size })}
            </Button>
          </div>
        )}
      </div>

      <div className="space-y-2 p-2">
        <SelectMenu
          label={t('cloudflare.dns.domain_list_label')}
          value={accountFilter}
          options={accountOptions}
          onChange={onAccountFilterChange}
          placeholder={t('cloudflare.dns.select_account')}
        />
        <SearchField
          value={query}
          onChange={onQueryChange}
          placeholder={t('cloudflare.dns.search_domain')}
          label={t('cloudflare.dns.search_domain')}
        />
      </div>

      <div className="flex items-center border-y border-[var(--border-subtle)] px-3 py-1">
        <Checkbox
          checked={allSelected}
          onChange={(checked) => onSelectAll(domains, checked)}
          label={uiT('templates.select_all')}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {error && <div className="p-1.5"><PanelError message={error} onRetry={onReload} /></div>}
        {loading && domains.length === 0 ? (
          <LoadingBlock />
        ) : domains.length === 0 ? (
          <Empty
            compact
            title={t('cloudflare.dns.no_domain')}
            action={<Button size="sm" onClick={onAdd}>{t('cloudflare.dns.add_domain_btn')}</Button>}
          />
        ) : (
          <ul className="space-y-0.5">
            {domains.map((domain) => {
              const active = selected === domain.name
              return (
                <li
                  key={domain.name}
                  className={cn(
                    'flex items-start gap-2 rounded-[var(--r-md)] px-2 py-1.5',
                    active ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-hover)]',
                  )}
                >
                  <Checkbox
                    checked={selection.has(domain.name)}
                    onChange={() => onToggleSelected(domain.name)}
                    label={domain.name}
                    className="shrink-0"
                  />
                  <button
                    type="button"
                    onClick={() => onSelect(domain.name)}
                    aria-current={active ? 'true' : undefined}
                    className="min-w-0 flex-1 rounded-[var(--r-xs)] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                  >
                    <span className={cn('block truncate text-[length:var(--text-12-5)] text-[var(--text-primary)]', active && 'font-medium')}>
                      {domain.name}
                    </span>
                    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                      <span
                        aria-hidden="true"
                        className={cn(
                          'size-1.5 shrink-0 rounded-full',
                          domain.status === 'active' && 'bg-[var(--success)]',
                          domain.status === 'pending' && 'bg-[var(--warning)]',
                          domain.status === 'moved' && 'bg-[var(--danger)]',
                          !['active', 'pending', 'moved'].includes(domain.status) && 'bg-[var(--text-quaternary)]',
                        )}
                      />
                      <span className="shrink-0">{statusText(t, domain.status)}</span>
                      <span className="truncate">· {domain.accountName}</span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </aside>
  )
}
