// @vitest-environment jsdom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement } from '../src/client/lib/test-render'
import { tabIdForPath } from '../src/client/features/shell/app-tabs'
import { ToolsApp } from '../src/client/features/tools/ToolsApp'
import { ToolsSidebar } from '../src/client/features/tools/ToolsSidebar'
import { TOOLS_NAV_WIDTH, useToolsStore } from '../src/client/features/tools/store'

describe('Tools container architecture and collapsible sidebar', () => {
  beforeEach(() => {
    installTestGlobals()
    initI18n()
    window.innerWidth = 1280
    window.innerHeight = 800
    useToolsStore.setState({
      toolsNavWidth: TOOLS_NAV_WIDTH.default,
      toolsNavCollapsed: false,
      toolsNavDrawerOpen: false,
      activeSubmodule: 'password',
      passwordModuleExpanded: true,
      activePasswordView: 'all',
      selectedGroupId: null,
    })
  })

  describe('app-tabs route matching', () => {
    it('routes /tools and /tools/ to tools container', () => {
      expect(tabIdForPath('/tools')).toBe('tools')
      expect(tabIdForPath('/tools/')).toBe('tools')
    })

    it('routes nested deep links like /tools/password to tools container', () => {
      expect(tabIdForPath('/tools/password')).toBe('tools')
      expect(tabIdForPath('/tools/password/generator')).toBe('tools')
      expect(tabIdForPath('/tools/password/groups')).toBe('tools')
    })
  })

  describe('useToolsStore', () => {
    it('initializes with default values', () => {
      const state = useToolsStore.getState()
      expect(state.toolsNavWidth).toBe(260)
      expect(state.toolsNavCollapsed).toBe(false)
      expect(state.activeSubmodule).toBe('password')
      expect(state.passwordModuleExpanded).toBe(true)
      expect(state.activePasswordView).toBe('all')
    })

    it('clamps toolsNavWidth between 200px and 380px', () => {
      useToolsStore.getState().setToolsNavWidth(150)
      expect(useToolsStore.getState().toolsNavWidth).toBe(TOOLS_NAV_WIDTH.min)

      useToolsStore.getState().setToolsNavWidth(500)
      expect(useToolsStore.getState().toolsNavWidth).toBe(TOOLS_NAV_WIDTH.max)

      useToolsStore.getState().setToolsNavWidth(300)
      expect(useToolsStore.getState().toolsNavWidth).toBe(300)
    })

    it('toggles toolsNavCollapsed', () => {
      expect(useToolsStore.getState().toolsNavCollapsed).toBe(false)
      useToolsStore.getState().toggleToolsNav()
      expect(useToolsStore.getState().toolsNavCollapsed).toBe(true)
      useToolsStore.getState().toggleToolsNav()
      expect(useToolsStore.getState().toolsNavCollapsed).toBe(false)
    })

    it('toggles drawer state', () => {
      expect(useToolsStore.getState().toolsNavDrawerOpen).toBe(false)
      useToolsStore.getState().toggleToolsNavDrawer(true)
      expect(useToolsStore.getState().toolsNavDrawerOpen).toBe(true)
      useToolsStore.getState().toggleToolsNavDrawer(false)
      expect(useToolsStore.getState().toolsNavDrawerOpen).toBe(false)
    })

    it('toggles passwordModuleExpanded', () => {
      expect(useToolsStore.getState().passwordModuleExpanded).toBe(true)
      useToolsStore.getState().togglePasswordModuleExpanded()
      expect(useToolsStore.getState().passwordModuleExpanded).toBe(false)
      useToolsStore.getState().togglePasswordModuleExpanded()
      expect(useToolsStore.getState().passwordModuleExpanded).toBe(true)
    })

    it('switches active password views', () => {
      useToolsStore.getState().setActivePasswordView('generator')
      expect(useToolsStore.getState().activePasswordView).toBe('generator')
      useToolsStore.getState().setActivePasswordView('favorites')
      expect(useToolsStore.getState().activePasswordView).toBe('favorites')
    })
  })

  describe('ToolsSidebar component', () => {
    it('renders header, title, and collapse button when expanded', async () => {
      const onCollapse = vi.fn()
      const view = await renderElement(<ToolsSidebar onCollapse={onCollapse} />)

      expect(view.container.textContent).toContain(t('tools.sidebar.title'))
      expect(view.container.textContent).toContain(t('tools.password.module_name'))

      const collapseBtn = view.container.querySelector('button[aria-label="' + t('tools.sidebar.collapse') + '"]')
      expect(collapseBtn).not.toBeNull()

      act(() => {
        collapseBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onCollapse).toHaveBeenCalledTimes(1)
      view.unmount()
    })

    it('renders all 6 navigation slots and group tree slot when password module is expanded', async () => {
      const view = await renderElement(<ToolsSidebar />)

      expect(view.container.textContent).toContain(t('tools.password.nav.all'))
      expect(view.container.textContent).toContain(t('tools.password.nav.favorites'))
      expect(view.container.textContent).toContain(t('tools.password.nav.generator'))
      expect(view.container.textContent).toContain(t('tools.password.nav.groups'))
      expect(view.container.textContent).toContain(t('tools.password.nav.backup_settings'))
      expect(view.container.textContent).toContain(t('tools.password.nav.batch_operations'))

      const groupTreeSlot = view.container.querySelector('[data-testid="tools-password-group-tree-slot"]')
      expect(groupTreeSlot).not.toBeNull()
      view.unmount()
    })

    it('collapses slots when accordion button is clicked', async () => {
      const view = await renderElement(<ToolsSidebar />)
      expect(view.container.textContent).toContain(t('tools.password.nav.all'))

      const accordionBtn = view.container.querySelector('button[aria-expanded="true"]')
      expect(accordionBtn).not.toBeNull()

      act(() => {
        accordionBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(useToolsStore.getState().passwordModuleExpanded).toBe(false)
      view.unmount()
    })

    it('renders rail mode (48px) when collapsed', async () => {
      const onExpand = vi.fn()
      const view = await renderElement(<ToolsSidebar collapsed onExpand={onExpand} />)

      const aside = view.container.querySelector('aside')
      expect(aside?.className).toContain('w-12')

      const expandBtn = view.container.querySelector('button[aria-label="' + t('tools.sidebar.expand') + '"]')
      expect(expandBtn).not.toBeNull()

      act(() => {
        expandBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onExpand).toHaveBeenCalledTimes(1)
      view.unmount()
    })
  })

  describe('ToolsApp component', () => {
    it('renders on desktop with sidebar, resizer, and PasswordApp root', async () => {
      window.innerWidth = 1280
      const view = await renderElement(<ToolsApp />)

      const root = view.container.querySelector('[data-testid="tools-app-root"]')
      expect(root).not.toBeNull()

      const resizer = view.container.querySelector('[role="separator"]')
      expect(resizer).not.toBeNull()

      const passwordApp = view.container.querySelector('[data-testid="password-app-root"]')
      expect(passwordApp).not.toBeNull()
      view.unmount()
    })

    it('adapts on mobile with top bar and Drawer support', async () => {
      window.innerWidth = 500
      useToolsStore.setState({ toolsNavDrawerOpen: true })
      const view = await renderElement(<ToolsApp />)

      const header = view.container.querySelector('header')
      expect(header).not.toBeNull()

      // Drawer renders in a portal
      const drawer = document.querySelector('[data-surface="drawer"]')
      expect(drawer).not.toBeNull()

      view.unmount()
    })
  })
})
