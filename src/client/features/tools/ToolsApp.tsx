import { PanelLeft, Wrench } from 'lucide-react'
import { t } from '../../lib/i18n'
import { useBreakpoint } from '../../lib/hooks'
import { Drawer } from '../../components/overlay'
import { IconButton } from '../../components/primitives'
import { Tooltip } from '../../components/overlay'
import { Resizer } from '../shell/Resizer'
import { ToolsSidebar } from './ToolsSidebar'
import { PasswordApp } from './password/PasswordApp'
import { QrCodeApp } from './qrcode/QrCodeApp'
import { TOOLS_NAV_WIDTH, useToolsStore } from './store'

export function ToolsApp() {
  const breakpoint = useBreakpoint()
  const isMobile = breakpoint === 'mobile'
  const isTablet = breakpoint === 'tablet'
  const isSmallScreen = isMobile || isTablet

  const toolsNavWidth = useToolsStore((s) => s.toolsNavWidth)
  const toolsNavCollapsed = useToolsStore((s) => s.toolsNavCollapsed)
  const toolsNavDrawerOpen = useToolsStore((s) => s.toolsNavDrawerOpen)
  const setToolsNavWidth = useToolsStore((s) => s.setToolsNavWidth)
  const toggleToolsNav = useToolsStore((s) => s.toggleToolsNav)
  const toggleToolsNavDrawer = useToolsStore((s) => s.toggleToolsNavDrawer)
  const activeSubmodule = useToolsStore((s) => s.activeSubmodule)

  return (
    <div
      data-testid="tools-app-root"
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-base)]"
    >
      {isSmallScreen && (
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3">
          <Tooltip label={t('tools.sidebar.title')}>
            <IconButton
              label={t('tools.sidebar.title')}
              size="sm"
              onClick={() => toggleToolsNavDrawer(true)}
            >
              <PanelLeft size={16} />
            </IconButton>
          </Tooltip>
          <div className="flex min-w-0 items-center gap-1.5 text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
            <Wrench size={16} className="shrink-0 text-[var(--text-secondary)]" />
            <span className="truncate">{t('tools.sidebar.title')}</span>
            <span className="text-[var(--text-tertiary)] font-normal">/</span>
            <span className="truncate text-[length:var(--text-13)] font-normal text-[var(--text-secondary)]">
              {activeSubmodule === 'password'
                ? t('tools.password.module_name')
                : activeSubmodule === 'qrcode'
                  ? t('tools.qrcode.module_name')
                  : activeSubmodule}
            </span>
          </div>
        </header>
      )}

      <div className="relative flex min-h-0 min-w-0 flex-1">
        {!isSmallScreen && (
          <>
            <div
              style={{ width: toolsNavCollapsed ? 48 : toolsNavWidth }}
              className="shrink-0 overflow-hidden transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-out)]"
            >
              <ToolsSidebar
                collapsed={toolsNavCollapsed}
                onCollapse={toggleToolsNav}
                onExpand={toggleToolsNav}
              />
            </div>
            {!toolsNavCollapsed && (
              <Resizer
                label={t('tools.sidebar.resize')}
                value={toolsNavWidth}
                min={TOOLS_NAV_WIDTH.min}
                max={TOOLS_NAV_WIDTH.max}
                onChange={setToolsNavWidth}
                onReset={() => setToolsNavWidth(TOOLS_NAV_WIDTH.default)}
              />
            )}
          </>
        )}

        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--bg-base)]">
          {activeSubmodule === 'password' && <PasswordApp />}
          {activeSubmodule === 'qrcode' && <QrCodeApp />}
        </main>
      </div>

      <Drawer
        open={isSmallScreen && toolsNavDrawerOpen}
        onClose={() => toggleToolsNavDrawer(false)}
        side="left"
        width={toolsNavWidth}
        title={t('tools.sidebar.title')}
      >
        <ToolsSidebar onCollapse={() => toggleToolsNavDrawer(false)} />
      </Drawer>
    </div>
  )
}
