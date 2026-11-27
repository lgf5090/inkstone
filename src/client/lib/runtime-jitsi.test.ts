// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('calendar Jitsi configuration', () => {
  it('uses a self-hosted HTTPS base and preserves its subpath', async () => {
    vi.stubEnv('VITE_JITSI_BASE_URL', 'https://meet.example.com/jitsi/')
    const { JITSI_BASE_URL, jitsiMeetingUrl } = await import('./runtime')
    expect(JITSI_BASE_URL).toBe('https://meet.example.com/jitsi')
    expect(jitsiMeetingUrl('room-1')).toBe('https://meet.example.com/jitsi/room-1')
  })

  it('rejects an insecure or credential-bearing base', async () => {
    vi.stubEnv('VITE_JITSI_BASE_URL', 'http://meet.example.com')
    await expect(import('./runtime')).rejects.toThrow('HTTPS URL')
    vi.stubEnv('VITE_JITSI_BASE_URL', 'https://user:pass@meet.example.com')
    await expect(import('./runtime')).rejects.toThrow('credentials')
  })
})
