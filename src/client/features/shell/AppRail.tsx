/**
 * The left rail: one button per app container, the outermost piece of chrome the notebook has.
 *
 * Each entry is a real `<a>` to the container's own path, with the click intercepted for the
 * in-place case. That keeps the browser's own behaviour on the rail — middle-click and
 * open-in-new-tab reach a container directly, and the address a reader copies is the one they
 * are looking at — while a plain left click still swaps the container without a reload.
 */
import type { MouseEvent } from 'react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { Tooltip } from '../../components/overlay'
import { navigateToPath, usePathname } from '../../lib/app-history'
import { useSession } from '../../store/session'
import { IS_DEMO_MODE } from '../../lib/runtime'
import { APP_TABS, tabIdForPath, type AppTab } from './app-tabs'

export function AppRail() {
  const activeId = tabIdForPath(usePathname())
  const role = useSession((state) => state.user?.role)
  const tabs = APP_TABS.filter((tab) => (tab.id !== 'email' || role !== 'member') && (tab.id !== 'imgbed' || !IS_DEMO_MODE))
  return (
    <nav
      aria-label={t('app.tabs.navigation')}
      data-print="hide"
      className="app-rail flex h-full w-12 shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)] py-2 md:w-14"
    >
      {/* The notebook's mobile shell pads itself below a notch, so the rail's icons stop at the same
          line rather than starting under the status bar. On a desktop the inset is zero. */}
      <div className="no-scrollbar flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto pt-[env(safe-area-inset-top)]">
        {tabs.map((tab) => (
          <RailTab key={tab.id} tab={tab} active={tab.id === activeId} />
        ))}
      </div>
    </nav>
  )
}

function RailTab({ tab, active }: { tab: AppTab; active: boolean }) {
  const label = t(tab.labelKey)
  const Icon = tab.icon
  const onActivate = (event: MouseEvent<HTMLAnchorElement>) => {
    // Only a plain left click belongs to the app; anything with a modifier or another button is the
    // browser's own navigation, and preventing it would break open-in-new-tab on the rail.
    if (event.defaultPrevented || event.button !== 0
      || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigateToPath(tab.path)
  }
  return (
    <Tooltip label={label} side="right">
      <a
        href={tab.path}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        onClick={onActivate}
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-[var(--r-md)] md:size-8',
          'transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
          active
            ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
        )}
      >
        <Icon size={17} />
      </a>
    </Tooltip>
  )
}
