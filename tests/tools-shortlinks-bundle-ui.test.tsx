// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { initI18n, localeTag, t } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement } from '../src/client/lib/test-render'
import { countryName } from '../src/shared/tools/shortlinks/country'
import type { BundleStats, ShortLink, ShortLinkBundle } from '../src/shared/tools/shortlinks/types'
import { BundlesView } from '../src/client/features/tools/shortlinks/BundlesView'
import { CreateBundleModal } from '../src/client/features/tools/shortlinks/modals/CreateBundleModal'
import { useShortlinksStore } from '../src/client/features/tools/shortlinks/store'

const bundle: ShortLinkBundle = {
  id: 1,
  user_id: 'user_1',
  name: 'Launch',
  description: 'Campaign links',
  icon: null,
  accent: 'blue',
  link_count: 2,
  total_clicks: 120,
  sparkline: [10, 20, 30],
  created_at: 1729000000,
  updated_at: 1729000000,
}

const links: ShortLink[] = [
  {
    id: 1,
    url: 'https://example.com/launch',
    label: 'Launch post',
    password_protected: false,
    created_at: 1729000000,
    expires_at: null,
    slugs: [{ slug: 'launch1', link_id: 1, is_primary: true, created_at: 1729000000 }],
    total_clicks: 80,
  },
  {
    id: 2,
    url: 'https://example.com/docs',
    label: 'Docs',
    password_protected: false,
    created_at: 1729000000,
    expires_at: null,
    slugs: [{ slug: 'docs2', link_id: 2, is_primary: true, created_at: 1729000000 }],
    total_clicks: 40,
  },
]

const stats: BundleStats = {
  bundle,
  link_count: 2,
  total_clicks: 120,
  clicked_links: 2,
  top_performer: { slug: 'launch1', label: 'Launch post', click_count: 80, pct_of_bundle: 67 },
  countries_reached: 2,
  timeline: { range: '30d', buckets: [] },
  countries: [
    { name: 'US', count: 80 },
    { name: 'CN', count: 40 },
  ],
  devices: [{ name: 'mobile', count: 70 }],
  operating_systems: [{ name: 'iOS', count: 50 }],
  browsers: [{ name: 'Safari', count: 50 }],
  referrers: [{ name: 'https://google.com/', count: 50 }],
  referrer_hosts: [{ name: 'google.com', count: 50 }],
  link_modes: [
    { name: 'link', count: 100 },
    { name: 'qr', count: 20 },
  ],
  per_link: [
    { link_id: 1, label: 'Launch post', primary_slug: 'launch1', url: 'https://example.com/launch', click_count: 80, pct_of_bundle: 67 },
    { link_id: 2, label: 'Docs', primary_slug: 'docs2', url: 'https://example.com/docs', click_count: 40, pct_of_bundle: 33 },
  ],
  num_countries: 2,
  num_referrers: 1,
  num_referrer_hosts: 1,
  num_os: 1,
  num_browsers: 1,
}

describe('Tools shortlinks bundle UI', () => {
  beforeEach(() => {
    installTestGlobals()
    initI18n()
    useShortlinksStore.setState({
      bundles: [bundle],
      activeBundleId: 1,
      activeBundleLinks: links,
      activeBundleStats: stats,
      loadingBundles: false,
      loadingBundleDetail: false,
      bundleModalOpen: false,
      editingBundle: null,
      fetchBundles: async () => {},
    })
  })

  it('renders bundle analytics beyond the two totals', async () => {
    const view = await renderElement(<BundlesView />)
    const text = view.container.textContent ?? ''
    expect(text).toContain(t('tools.shortlinks.bundles.top_links'))
    expect(text).toContain(t('tools.shortlinks.bundles.clicked_links'))
    expect(text).toContain(t('tools.shortlinks.bundles.countries_reached'))
    expect(text).toContain('/launch1')
    expect(text).toContain('Launch post')
    expect(text).toContain(countryName('US', localeTag()))
    expect(text).toContain('mobile')
    expect(text).toContain('https://google.com/')
    expect(text).toContain(t('tools.shortlinks.bundles.mode_link'))
    expect(text).toContain(t('tools.shortlinks.bundles.mode_qr'))
    view.unmount()
  })

  it('associates every bundle form control with its label', async () => {
    useShortlinksStore.setState({ bundleModalOpen: true })
    const view = await renderElement(<CreateBundleModal />)

    const inputs = Array.from(document.querySelectorAll('input'))
    expect(inputs).toHaveLength(2)
    for (const input of inputs) {
      expect(input.id).not.toBe('')
      expect(document.querySelector(`label[for="${input.id}"]`)).not.toBeNull()
    }

    const accentGroup = document.querySelector('[role="group"]')
    expect(accentGroup).not.toBeNull()
    const labelledBy = accentGroup?.getAttribute('aria-labelledby')
    expect(labelledBy).not.toBe('')
    expect(document.getElementById(labelledBy ?? '')).not.toBeNull()

    const selectedAccent = document.querySelector('button[aria-pressed="true"]')
    expect(selectedAccent).not.toBeNull()

    view.unmount()
  })
})
