import type { MouseEvent, ReactElement, ReactNode } from 'react'
import { cn } from '../../../lib/cn'

export interface SidebarLinkProps {
  href: string
  active: boolean
  icon: ReactNode
  label: string
  count?: number | null
  onActivate: () => void
  onNavigate?: () => void
  className?: string
}

export function SidebarLink({
  href,
  active,
  icon,
  label,
  count,
  onActivate,
  onNavigate,
  className,
}: SidebarLinkProps): ReactElement {
  const onClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.defaultPrevented || event.button !== 0
      || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    onActivate()
    onNavigate?.()
  }
  return (
    <a
      href={href}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={cn(
        'flex min-h-10 w-full items-center gap-2 rounded-[var(--r-md)] px-2 text-left text-[length:var(--text-12-5)]',
        'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] md:min-h-0 md:h-7',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
        active
          ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent-on-soft)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
        className,
      )}
    >
      <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center opacity-85">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== null && count !== undefined ? (
        <span className="shrink-0 text-[length:var(--text-10-5)] tabular text-[var(--text-quaternary)]">{count}</span>
      ) : null}
    </a>
  )
}
