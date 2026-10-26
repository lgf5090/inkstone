import type { DragEvent } from 'react'
import { Star } from 'lucide-react'
import type { DecryptedAccount } from '@shared/tools/password/types'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { FaviconAvatar } from './FaviconAvatar'

export interface AccountCardProps {
  account: DecryptedAccount
  isSelected: boolean
  onSelect: (account: DecryptedAccount) => void
  onToggleFavorite?: (id: string) => void
  draggable?: boolean
  onDragStart?: (e: DragEvent, account: DecryptedAccount) => void
  onDragOver?: (e: DragEvent) => void
  onDrop?: (e: DragEvent, account: DecryptedAccount) => void
  className?: string
}

export function AccountCard({
  account,
  isSelected,
  onSelect,
  onToggleFavorite,
  draggable = true,
  onDragStart,
  onDragOver,
  onDrop,
  className,
}: AccountCardProps) {
  const handleDragStart = (e: DragEvent) => {
    e.dataTransfer.setData('text/plain', account.id)
    e.dataTransfer.setData(
      'application/json',
      JSON.stringify({ id: account.id, type: 'password-account', groupId: account.groupId }),
    )
    e.dataTransfer.effectAllowed = 'move'
    onDragStart?.(e, account)
  }

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    onDrop?.(e, account)
  }

  const titleText = account.title || t('tools.password.account.title')
  const usernameText = account.username || account.link || '-'

  return (
    <div
      data-account-id={account.id}
      draggable={draggable}
      onDragStart={handleDragStart}
      onDragOver={onDragOver}
      onDrop={handleDrop}
      className={cn(
        'group relative flex items-center gap-1 rounded-lg transition-all duration-150',
        className,
      )}
    >
      {/* The row is a button and the star beside it is another: a `div` wearing a role could be neither
          keyboard-reachable past the list nor described as the two controls it actually is. */}
      <button
        type="button"
        aria-pressed={isSelected}
        aria-label={titleText}
        data-testid="account-card"
        onClick={() => onSelect(account)}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-3 rounded-lg border px-3 py-2 text-left select-none',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
          'transition-colors duration-150',
          isSelected
            ? 'border-[var(--accent)] bg-[var(--accent-soft)]/20 shadow-sm'
            : 'border-transparent bg-transparent hover:bg-[var(--bg-hover)]',
        )}
      >
        <FaviconAvatar
          url={account.link}
          title={account.title}
          favicon={account.favicon}
          size={34}
        />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                'truncate font-medium text-[length:var(--text-13)]',
                isSelected ? 'font-semibold text-[var(--accent)]' : 'text-[var(--text-primary)]',
              )}
            >
              {titleText}
            </span>
          </div>
          <div className="truncate text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            {usernameText}
          </div>
        </div>
      </button>

      <button
        type="button"
        aria-label={
          account.isFavorite
            ? t('tools.password.account.unfavorite')
            : t('tools.password.account.favorite')
        }
        data-testid="account-favorite-btn"
        onClick={() => onToggleFavorite?.(account.id)}
        className={cn(
          'shrink-0 p-1 rounded-md text-[var(--text-quaternary)] transition-colors',
          'hover:bg-[var(--bg-hover)] hover:text-amber-400',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]',
        )}
      >
        <Star
          size={16}
          className={cn(
            'transition-colors',
            account.isFavorite
              ? 'fill-amber-400 text-amber-400'
              : 'text-[var(--text-quaternary)] group-hover:text-[var(--text-tertiary)]',
          )}
        />
      </button>
    </div>
  )
}
