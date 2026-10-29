import type { MouseEvent, ReactNode } from 'react'
import { cn } from '../../../lib/cn'
import { Tooltip } from '../../../components/overlay'

export function SidebarLink({
  href,
  label,
  icon,
  count,
  badge,
  active,
  collapsed,
  onActivate,
  className,
}: {
  href: string
  label: string
  icon?: ReactNode
  count?: number
  badge?: ReactNode
  active?: boolean
  collapsed?: boolean
  onActivate?: () => void
  className?: string
}) {
  const activate = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    onActivate?.()
  }

  const anchor = (
    <a
      href={href}
      aria-current={active ? 'page' : undefined}
      aria-label={collapsed ? label : undefined}
      onClick={activate}
      className={cn(
        'flex h-8 w-full min-w-0 items-center gap-2 rounded-[var(--r-sm)] px-2',
        'text-[length:var(--text-12)] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
        active
          ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent-on-soft)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
        collapsed && 'justify-center px-0',
        className,
      )}
    >
      {icon && (
        <span aria-hidden="true" className="flex shrink-0 items-center">
          {icon}
        </span>
      )}
      {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
      {!collapsed && badge}
      {!collapsed && count !== undefined && count > 0 && (
        <span className="tabular shrink-0 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
          {count}
        </span>
      )}
    </a>
  )

  if (!collapsed) return anchor
  return (
    <Tooltip label={label} side="right">
      {anchor}
    </Tooltip>
  )
}
