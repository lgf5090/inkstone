// @vitest-environment jsdom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../src/client/lib/i18n'
import { flushLazyModules, installTestGlobals, renderElement } from '../src/client/lib/test-render'
import { ToolsApp } from '../src/client/features/tools/ToolsApp'
import { ToolsSidebar } from '../src/client/features/tools/ToolsSidebar'
import { useToolsStore } from '../src/client/features/tools/store'
import { useShortlinksStore } from '../src/client/features/tools/shortlinks/store'
import { SLUG_ALPHABET_SIZE } from '../src/shared/tools/shortlinks/types'
import { DashboardView } from '../src/client/features/tools/shortlinks/DashboardView'
import { LinksView } from '../src/client/features/tools/shortlinks/LinksView'
import { BundlesView } from '../src/client/features/tools/shortlinks/BundlesView'
import { SettingsView } from '../src/client/features/tools/shortlinks/SettingsView'
import { LinkDetailView } from '../src/client/features/tools/shortlinks/LinkDetailView'
import { QrCodeModal } from '../src/client/features/tools/shortlinks/modals/QrCodeModal'
import { CreateLinkModal } from '../src/client/features/tools/shortlinks/modals/CreateLinkModal'

describe('Shortlinks Frontend Feature UI & State Tests', () => {
  beforeEach(() => {
    installTestGlobals()
    initI18n()
    window.innerWidth = 1280
    window.innerHeight = 800

    useToolsStore.setState({
      activeSubmodule: 'shortlinks',
      shortlinksModuleExpanded: true,
      activeShortlinksView: 'dashboard',
    })

    useShortlinksStore.setState({
      dashboardStats: {
        total_clicks: 1250,
        active_links: 12,
        total_links: 15,
        avg_clicks_per_day: 42,
        delta_clicks: 18.5,
        timeline: {
          labels: ['2026-10-20', '2026-10-21', '2026-10-22'],
          values: [30, 45, 60],
        },
        top_countries: [
          { name: 'United States', count: 500 },
          { name: 'China', count: 350 },
        ],
        top_referrers: [
          { name: 'google.com', count: 400 },
          { name: 'Direct / None', count: 300 },
        ],
        recent_links: [
          {
            id: 1,
            user_id: 1,
            url: 'https://example.com/blog/2026',
            label: 'Tech Blog Post',
            password_protected: false,
            expires_at: null,
            total_clicks: 120,
            created_at: 1729000000,
            slugs: [{ link_id: 1, slug: 'tech26', is_primary: true, created_at: 1729000000 }],
          },
        ],
      },
      links: [
        {
          id: 1,
          user_id: 1,
          url: 'https://example.com/blog/2026',
          label: 'Tech Blog Post',
          password_protected: false,
          expires_at: null,
          total_clicks: 120,
          created_at: 1729000000,
          slugs: [{ link_id: 1, slug: 'tech26', is_primary: true, created_at: 1729000000 }],
        },
      ],
      totalLinks: 1,
      bundles: [
        {
          id: 1,
          user_id: '1',
          name: 'Social Media',
          description: 'Campaign links for social',
          icon: null,
          accent: 'blue',
          link_count: 5,
          total_clicks: 340,
          sparkline: [1, 2, 3],
          archived_at: null,
          created_at: 1729000000,
          updated_at: 1729000000,
        },
      ],
      settings: {
        slug_default_length: 6,
        default_range: '30d',
        filter_bots: true,
        filter_self_referrers: true,
      },
      apiKeys: [],
      backups: [],
      loadingLinks: false,
      loadingBundles: false,
      loadingDashboard: false,
      loadingSettings: false,
      fetchLinks: async () => {},
      fetchBundles: async () => {},
      fetchDashboard: async () => {},
      fetchSettings: async () => {},
      fetchApiKeys: async () => {},
      fetchBackups: async () => {},
      createModalOpen: false,
      editModalOpen: false,
      qrModalOpen: false,
      qrLink: null,
    })
  })

  describe('ToolsSidebar Integration', () => {
    it('renders Shortlinks navigation module in sidebar', async () => {
      const view = await renderElement(<ToolsSidebar />)
      expect(view.container.textContent).toContain(t('tools.shortlinks.module_name'))
      expect(view.container.textContent).toContain(t('tools.shortlinks.nav.dashboard'))
      expect(view.container.textContent).toContain(t('tools.shortlinks.nav.links'))
      expect(view.container.textContent).toContain(t('tools.shortlinks.nav.bundles'))
      expect(view.container.textContent).toContain(t('tools.shortlinks.nav.settings'))
      view.unmount()
    })

    it('switches activeShortlinksView when sidebar item is clicked', async () => {
      const view = await renderElement(<ToolsSidebar />)
      const linksBtn = Array.from(view.container.querySelectorAll('button')).find(
        (b) => b.textContent?.includes(t('tools.shortlinks.nav.links'))
      )
      expect(linksBtn).toBeDefined()

      act(() => {
        linksBtn?.click()
      })

      expect(useToolsStore.getState().activeShortlinksView).toBe('links')
      view.unmount()
    })
  })

  describe('ToolsApp Top-level Rendering', () => {
    it('mounts ShortlinksApp when activeSubmodule is shortlinks', async () => {
      const view = await renderElement(<ToolsApp />)
      await flushLazyModules(() => Boolean(view.container.querySelector('[data-testid="tools-shortlinks-root"]')))
      expect(view.container.textContent).toContain(t('tools.shortlinks.dashboard.quick_shorten'))
      expect(view.container.textContent).toContain(t('tools.shortlinks.dashboard.total_clicks'))
      view.unmount()
    })
  })

  describe('DashboardView', () => {
    it('renders KPI metrics and recent links correctly', async () => {
      const view = await renderElement(<DashboardView />)
      expect(view.container.textContent).toContain('1,250')
      expect(view.container.textContent).toContain('12')
      expect(view.container.textContent).toContain('tech26')
      expect(view.container.textContent).toContain('Tech Blog Post')
      view.unmount()
    })

    it('allows typing into quick shorten input', async () => {
      const view = await renderElement(<DashboardView />)
      const input = view.container.querySelector('input') as HTMLInputElement
      expect(input).not.toBeNull()

      act(() => {
        input.value = 'https://github.com'
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })

      expect(input.value).toBe('https://github.com')
      view.unmount()
    })
  })

  describe('LinksView', () => {
    it('renders links list table with slug badge and copy button', async () => {
      const view = await renderElement(<LinksView />)
      expect(view.container.textContent).toContain('/tech26')
      expect(view.container.textContent).toContain('Tech Blog Post')
      expect(view.container.textContent).toContain(t('tools.shortlinks.links.new_link'))
      view.unmount()
    })

    it('opens CreateLinkModal when new link button is clicked', async () => {
      const view = await renderElement(<LinksView />)
      const newBtn = Array.from(view.container.querySelectorAll('button')).find(
        (b) => b.textContent?.includes(t('tools.shortlinks.links.new_link'))
      )
      expect(newBtn).toBeDefined()

      act(() => {
        newBtn?.click()
      })

      expect(useShortlinksStore.getState().createModalOpen).toBe(true)
      view.unmount()
    })
  })

  describe('BundlesView', () => {
    it('renders bundle card with title and link count', async () => {
      const view = await renderElement(<BundlesView />)
      expect(view.container.textContent).toContain('Social Media')
      expect(view.container.textContent).toContain('Campaign links for social')
      expect(view.container.textContent).toContain(t('tools.shortlinks.bundles.new_bundle'))
      view.unmount()
    })
  })

  describe('SettingsView', () => {
    it('renders slug length slider and combinations text', async () => {
      const view = await renderElement(<SettingsView />)
      expect(view.container.textContent).toContain(t('tools.shortlinks.settings.slug_length'))
      expect(view.container.textContent).toContain((SLUG_ALPHABET_SIZE ** 6).toLocaleString())
      expect(view.container.textContent).toContain(t('tools.shortlinks.settings.api_keys'))
      expect(view.container.textContent).toContain(t('tools.shortlinks.settings.data_management'))
      view.unmount()
    })
  })

  describe('LinkDetailView', () => {
    it('handles transition from null link to loaded link without hook order violation', async () => {
      // First render with activeLink null
      useShortlinksStore.setState({ activeLink: null, activeLinkTimeline: null })
      const view = await renderElement(<LinkDetailView />)
      expect(view.container.textContent).toContain(t('tools.shortlinks.links.empty'))

      // Subsequent render with activeLink and timeline loaded
      await act(async () => {
        useShortlinksStore.setState({
          activeLink: {
            id: 1,
            user_id: 'user_1',
            url: 'https://example.com/blog',
            label: 'Company Blog',
            password_protected: false,
            created_at: 1729000000,
            expires_at: null,
            created_via: 'app',
            created_by: 'user',
            total_clicks: 120,
            slugs: [{ slug: 'blog26', link_id: 1, is_custom: true, is_primary: true, click_count: 120, created_at: 1729000000, disabled_at: null }],
          },
          activeLinkTimeline: {
            range: '30d',
            buckets: [{ label: '2026-10-25', count: 10 }],
          },
        })
      })

      expect(view.container.textContent).toContain('/blog26')
      expect(view.container.textContent).toContain('https://example.com/blog')
      expect(view.container.textContent).toContain('Company Blog')
      view.unmount()
      useShortlinksStore.setState({ activeLink: null, activeLinkTimeline: null })
    })
  })

  describe('Modals', () => {
    it('renders QrCodeModal with action buttons and shortlink url', async () => {
      useShortlinksStore.setState({
        qrModalOpen: true,
        qrLink: {
          id: 1,
          user_id: 1,
          url: 'https://example.com/test',
          label: 'Test Link',
          password_protected: false,
          expires_at: null,
          total_clicks: 5,
          created_at: 1729000000,
          slugs: [{ link_id: 1, slug: 'qrtest', is_primary: true, created_at: 1729000000 }],
        },
      })

      const view = await renderElement(<QrCodeModal />)
      expect(document.body.textContent).toContain('/l/qrtest')
      expect(document.body.textContent).toContain('PNG')
      expect(document.body.textContent).toContain('SVG')
      view.unmount()
    })

    it('renders CreateLinkModal with fields', async () => {
      useShortlinksStore.setState({
        createModalOpen: true,
      })

      const view = await renderElement(<CreateLinkModal />)
      expect(document.body.textContent).toContain(t('tools.shortlinks.modal.create_title'))
      expect(document.body.textContent).toContain(t('tools.shortlinks.modal.url_label'))
      expect(document.body.textContent).toContain(t('tools.shortlinks.modal.custom_slug_label'))
      view.unmount()
    })
  })
})
