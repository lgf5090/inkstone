import { describe, expect, it } from 'vitest'
import {
  CLOUDFLARE_SCREENS,
  cloudflareScreenPath,
  parseCloudflareAddress,
} from '../src/client/features/cloudflare/cloudflare-address'

describe('the Cloudflare address space', () => {
  it('answers the dashboard for the bare tab path and for anything it never links to', () => {
    expect(parseCloudflareAddress('/cloudflare')).toEqual({ screen: 'dashboard', aiTab: 'stats' })
    expect(parseCloudflareAddress('/cloudflare/')).toEqual({ screen: 'dashboard', aiTab: 'stats' })
    expect(parseCloudflareAddress('/cloudflare/nope')).toEqual({ screen: 'dashboard', aiTab: 'stats' })
  })

  it('reads every screen it names, and only those', () => {
    for (const screen of CLOUDFLARE_SCREENS) {
      expect(parseCloudflareAddress(cloudflareScreenPath(screen)).screen).toBe(screen)
    }
    expect(cloudflareScreenPath('dashboard')).toBe('/cloudflare')
    expect(cloudflareScreenPath('storage')).toBe('/cloudflare/storage')
  })

  it('keeps the AI tab in the query, defaulting to the statistics tab', () => {
    expect(parseCloudflareAddress('/cloudflare/ai').aiTab).toBe('stats')
    expect(parseCloudflareAddress('/cloudflare/ai', '?tab=chat').aiTab).toBe('chat')
    expect(parseCloudflareAddress('/cloudflare/ai', '?tab=translate').aiTab).toBe('translate')
    expect(parseCloudflareAddress('/cloudflare/ai', '?tab=nowhere').aiTab).toBe('stats')
  })

  it('does not claim another app’s address', () => {
    expect(parseCloudflareAddress('/music')).toEqual({ screen: 'dashboard', aiTab: 'stats' })
    expect(parseCloudflareAddress('/cloudflarex/dns')).toEqual({ screen: 'dashboard', aiTab: 'stats' })
  })
})
