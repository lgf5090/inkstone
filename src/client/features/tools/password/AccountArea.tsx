import { cn } from '../../../lib/cn'
import { usePasswordVaultStore } from './store'
import { AccountList } from './AccountList'
import { AccountForm } from './AccountForm'

export interface AccountAreaProps {
  isFavoritesOnly?: boolean
  groupId?: string | null
  className?: string
}

export function AccountArea({
  isFavoritesOnly = false,
  groupId,
  className,
}: AccountAreaProps) {
  const selectedAccountId = usePasswordVaultStore((s) => s.selectedAccountId)
  const setSelectedAccountId = usePasswordVaultStore((s) => s.setSelectedAccountId)

  return (
    <div
      data-testid="account-area"
      className={cn(
        'flex h-full min-h-0 flex-1 overflow-hidden bg-[var(--bg-base)]',
        className,
      )}
    >
      {/* Desktop side-by-side view */}
      <div className="hidden md:flex h-full min-h-0 flex-1 overflow-hidden">
        <AccountList
          filterFavoritesOnly={isFavoritesOnly}
          groupId={groupId}
          className="w-80 lg:w-96 shrink-0 border-r border-[var(--border-subtle)]"
        />
        <div className="flex-1 min-w-0 h-full overflow-hidden">
          <AccountForm />
        </div>
      </div>

      {/* Mobile responsive view: either show list or show form */}
      <div className="flex md:hidden h-full min-h-0 flex-1 overflow-hidden">
        {selectedAccountId ? (
          <div className="flex-1 min-w-0 h-full overflow-hidden">
            <AccountForm onBack={() => setSelectedAccountId(null)} />
          </div>
        ) : (
          <AccountList
            filterFavoritesOnly={isFavoritesOnly}
            groupId={groupId}
            className="flex-1 min-w-0"
          />
        )}
      </div>
    </div>
  )
}
