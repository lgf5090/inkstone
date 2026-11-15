// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertPublicImageHttps, downloadReadmeImage } from '../src/worker/cloudflare/catalog'

const PUBLIC_IP = '93.184.216.34'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('GitHub README image host resolution', () => {
  it('accepts a host that resolves to a public address', async () => {
    const url = await assertPublicImageHttps('https://cdn.example.com/a.png', async () => [PUBLIC_IP])
    expect(url.hostname).toBe('cdn.example.com')
  })

  it('refuses a host that resolves to a private address', async () => {
    await expect(
      assertPublicImageHttps('https://cdn.example.com/a.png', async () => ['10.0.0.5']),
    ).rejects.toMatchObject({ status: 400, message: 'That image host resolves to a private address' })
  })

  it('refuses a mapped IPv6 literal before any resolution', async () => {
    await expect(
      assertPublicImageHttps('https://[::ffff:127.0.0.1]/a.png', async () => [PUBLIC_IP]),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('falls back to the static guard when DNS lookup fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const url = await assertPublicImageHttps('https://cdn.example.com/a.png', async () => {
      throw new Error('DoH offline')
    })
    expect(url.hostname).toBe('cdn.example.com')
    expect(warn).toHaveBeenCalledOnce()
  })

  it('re-checks the resolved address on every redirect hop', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      seen.push(url)
      if (url.startsWith('https://cdn.example.com/')) {
        return new Response(null, { status: 302, headers: { location: 'https://rebind.example/a.png' } })
      }
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    }))
    await expect(
      downloadReadmeImage('https://cdn.example.com/start.png', async (hostname) =>
        hostname === 'rebind.example' ? ['192.168.1.7'] : [PUBLIC_IP]),
    ).rejects.toMatchObject({ status: 400 })
    expect(seen).toEqual(['https://cdn.example.com/start.png'])
  })

  it('serves a bitmap when every hop resolves to a public address', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })))
    const result = await downloadReadmeImage('https://cdn.example.com/a.png', async () => [PUBLIC_IP])
    expect(result.type).toBe('image/png')
  })
})
