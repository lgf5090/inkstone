import { cn } from '../../../lib/cn'
import { AccountArea } from './AccountArea'

export interface FavoriteAccountsProps {
  className?: string
}

export function FavoriteAccounts({ className }: FavoriteAccountsProps) {
  return (
    <div
      data-testid="favorite-accounts-view"
      className={cn('flex h-full min-h-0 flex-1 overflow-hidden', className)}
    >
      <AccountArea isFavoritesOnly={true} />
    </div>
  )
}
