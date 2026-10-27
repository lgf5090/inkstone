// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement } from '../src/client/lib/test-render'
import { CloudflareApp } from '../src/client/features/cloudflare/CloudflareApp'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

afterEach(() => vi.unstubAllGlobals())

describe('the Cloudflare container', () => {
  it('draws its ten-screen rail once its copy arrives', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
      if (url.pathname.endsWith('/quota')) return Response.json({ accounts: [] })
      if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: [], total: 0, counts: { all: 0, active: 0, unverified: 0 }, quota: [] })
      if (url.pathname.endsWith('/ai/usage')) return Response.json([])
      if (url.pathname.endsWith('/tasks')) return Response.json({ tasks: [] })
      if (url.pathname.endsWith('/sources')) return Response.json({ sources: [] })
      if (url.pathname.endsWith('/settings')) return Response.json({ platform: 'cloudflare-workers', demo_account_ids: '', r2: true, vault: true, version: '0.0.0' })
      return Response.json({})
    })
    const view = renderElement(createElement(CloudflareApp))
    await vi.waitFor(() => {
      expect(document.querySelectorAll('nav a[href^="/cloudflare"]').length).toBe(10)
    })
    const links = [...document.querySelectorAll('nav a[href^="/cloudflare"]')]
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/cloudflare',
      '/cloudflare/accounts',
      '/cloudflare/dns',
      '/cloudflare/workers',
      '/cloudflare/storage',
      '/cloudflare/tunnels',
      '/cloudflare/ai',
      '/cloudflare/browser-render',
      '/cloudflare/store',
      '/cloudflare/settings',
    ])
    expect(links[0]?.getAttribute('aria-current')).toBe('page')
    view.unmount()
  })
})
