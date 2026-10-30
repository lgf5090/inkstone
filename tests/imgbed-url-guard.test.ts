import { describe, expect, it, vi } from 'vitest'
import { assertExternalHttpUrl, assertPublicHttpUrl, isPrivateHostname, UrlGuardError } from '../src/worker/imgbed/url-guard'

describe('imgbed URL guard', () => {
  it('classifies private IPv4 and IPv6 literals', () => {
    for (const host of ['127.0.0.1', '[::1]', '::1', '[::ffff:127.0.0.1]', '10.0.0.1', '100.64.0.1', '169.254.169.254', '172.20.0.1', '192.168.1.1', '198.18.0.1', '224.0.0.1']) {
      expect(isPrivateHostname(host), host).toBe(true)
    }
    for (const host of ['example.com', '93.184.216.34', '2606:4700:4700::1111']) {
      expect(isPrivateHostname(host), host).toBe(false)
    }
  })

  it('rejects literal private URLs and credentials', async () => {
    for (const url of ['http://127.0.0.1/x', 'http://[::1]/x', 'http://[::ffff:7f00:1]/x', 'http://user:pass@example.com/x', 'file:///etc/passwd', 'http://100.64.0.1/x']) {
      await expect(assertPublicHttpUrl(url), url).rejects.toBeInstanceOf(UrlGuardError)
    }
  })

  it('resolves host names and rejects private answers', async () => {
    await expect(assertPublicHttpUrl('https://example.com/x', async () => ['127.0.0.1'])).rejects.toBeInstanceOf(UrlGuardError)
    await expect(assertPublicHttpUrl('https://example.com/x', async () => ['2606:4700:4700::1111'])).resolves.toBeInstanceOf(URL)
    await expect(assertPublicHttpUrl('https://example.com/x', async () => [])).rejects.toBeInstanceOf(UrlGuardError)
  })

  it('does not resolve an IP literal through the injected resolver', async () => {
    const resolver = vi.fn(async () => ['127.0.0.1'])
    await expect(assertPublicHttpUrl('https://93.184.216.34/x', resolver)).resolves.toBeInstanceOf(URL)
    expect(resolver).not.toHaveBeenCalled()
  })

  it('accepts public external links without DNS but blocks private ones', async () => {
    await expect(assertExternalHttpUrl('https://example.com/a.png')).resolves.toBeInstanceOf(URL)
    await expect(assertExternalHttpUrl('http://127.0.0.1/a.png')).rejects.toBeInstanceOf(UrlGuardError)
    await expect(assertExternalHttpUrl('javascript:alert(1)')).rejects.toBeInstanceOf(UrlGuardError)
  })
})
