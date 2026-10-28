import { Suspense, lazy } from 'react'
import { PanelLeft, Terminal } from 'lucide-react'
import { t } from '../../lib/i18n'
import { useBreakpoint } from '../../lib/hooks'
import { usePathname } from '../../lib/app-history'
import { Drawer, Tooltip } from '../../components/overlay'
import { IconButton } from '../../components/primitives'
import { LoadingBlock } from '../../components/feedback'
import { Resizer } from '../shell/Resizer'
import { DevelopmentSidebar } from './DevelopmentSidebar'
import { DatabaseApp } from './database/DatabaseApp'
import { XgetApp } from './xget/XgetApp'
import { DEVELOPMENT_NAV_WIDTH, developmentModuleForPath, useDevelopmentStore } from './store'

const ApiTesterApp = lazy(() =>
  import('./api-tester/ApiTesterApp').then((module) => ({ default: module.ApiTesterApp })),
)

export function DevelopmentApp() {
  const breakpoint = useBreakpoint()
  const isSmallScreen = breakpoint === 'mobile' || breakpoint === 'tablet'
  const pathname = usePathname()
  const moduleId = developmentModuleForPath(pathname)
  const navWidth = useDevelopmentStore((s) => s.navWidth)
  const navCollapsed = useDevelopmentStore((s) => s.navCollapsed)
  const navDrawerOpen = useDevelopmentStore((s) => s.navDrawerOpen)
  const setNavWidth = useDevelopmentStore((s) => s.setNavWidth)
  const toggleNavCollapsed = useDevelopmentStore((s) => s.toggleNavCollapsed)
  const toggleNavDrawer = useDevelopmentStore((s) => s.toggleNavDrawer)

  return (
    <div
      data-testid="development-app-root"
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-base)]"
    >
      {isSmallScreen && (
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3">
          <Tooltip label={t('development.sidebar.title')}>
            <IconButton label={t('development.sidebar.title')} size="sm" onClick={() => toggleNavDrawer(true)}>
              <PanelLeft size={16} />
            </IconButton>
          </Tooltip>
          <div className="flex min-w-0 items-center gap-1.5 text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
            <Terminal size={16} className="shrink-0 text-[var(--text-secondary)]" />
            <span className="truncate">{t('development.sidebar.title')}</span>
            <span className="font-normal text-[var(--text-tertiary)]">/</span>
            <span className="truncate text-[length:var(--text-13)] font-normal text-[var(--text-secondary)]">
              {moduleId === 'xget'
                ? t('development.xget.module_name')
                : moduleId === 'api-tester'
                  ? t('development.apitester.module_name')
                  : t('development.database.module_name')}
            </span>
          </div>
        </header>
      )}

      <div className="relative flex min-h-0 min-w-0 flex-1">
        {!isSmallScreen && (
          <>
            <div
              style={{ width: navCollapsed ? 48 : navWidth }}
              className="shrink-0 overflow-hidden transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-out)]"
            >
              <DevelopmentSidebar
                collapsed={navCollapsed}
                onCollapse={toggleNavCollapsed}
                onExpand={toggleNavCollapsed}
              />
            </div>
            {!navCollapsed && (
              <Resizer
                label={t('development.sidebar.resize')}
                value={navWidth}
                min={DEVELOPMENT_NAV_WIDTH.min}
                max={DEVELOPMENT_NAV_WIDTH.max}
                onChange={setNavWidth}
                onReset={() => setNavWidth(DEVELOPMENT_NAV_WIDTH.default)}
              />
            )}
          </>
        )}

        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--bg-base)]">
          {moduleId === 'xget' ? (
            <XgetApp />
          ) : moduleId === 'api-tester' ? (
            <Suspense fallback={<LoadingBlock />}>
              <ApiTesterApp />
            </Suspense>
          ) : (
            <DatabaseApp />
          )}
        </main>
      </div>

      <Drawer
        open={isSmallScreen && navDrawerOpen}
        onClose={() => toggleNavDrawer(false)}
        side="left"
        width={navWidth}
        title={t('development.sidebar.title')}
      >
        <DevelopmentSidebar
          onCollapse={() => toggleNavDrawer(false)}
          onNavigate={() => toggleNavDrawer(false)}
        />
      </Drawer>
    </div>
  )
}
