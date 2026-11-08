// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { XGET_PLATFORMS } from '../src/shared/development/xget/catalog'
import {
  buildProxyUrl,
  detectPlatform,
  proxyPathFromUpstreamUrl,
  upstreamUrlForPlatformPath,
} from '../src/client/features/development/xget/utils/commands'
import { resolveProxyTarget } from '../src/worker/development/xget/lib/app/handle-request'

const BASE = 'https://proxy.example/api/development/xget'

describe('the Xget URL converter', () => {
  it('round-trips every platform example through detect, convert and resolve', () => {
    expect(XGET_PLATFORMS).toHaveLength(84)
    for (const platform of XGET_PLATFORMS) {
      const original = upstreamUrlForPlatformPath(platform, platform.example)
      const detected = detectPlatform(original)
      expect(detected?.platform.key, `${platform.key} detects its own example`).toBe(platform.key)

      const proxyPath = proxyPathFromUpstreamUrl(
        detected!.platform,
        detected!.url.pathname,
      )
      const converted = buildProxyUrl(
        BASE,
        platform.key,
        proxyPath,
        detected!.url.search,
      )
      const resolved = resolveProxyTarget(converted.slice(BASE.length), {})
      expect(resolved.ok, `${platform.key} converts its own example`).toBe(true)
      if (resolved.ok) {
        expect(resolved.targetUrl, `${platform.key} keeps the original target`).toBe(original)
      }

      const card = buildProxyUrl(BASE, platform.key, platform.example, '')
      const cardResolved = resolveProxyTarget(card.slice(BASE.length), {})
      expect(cardResolved.ok, `${platform.key} card example resolves`).toBe(true)
      if (cardResolved.ok) {
        expect(cardResolved.targetUrl, `${platform.key} card keeps the original target`).toBe(
          original,
        )
      }
    }
  })

  it('strips the upstream base path and the engine transform exactly once', () => {
    const byKey = Object.fromEntries(XGET_PLATFORMS.map((platform) => [platform.key, platform]))

    expect(
      buildProxyUrl(
        BASE,
        'crates',
        proxyPathFromUpstreamUrl(byKey.crates!, '/api/v1/crates/serde'),
      ),
    ).toBe(`${BASE}/crates/serde`)

    expect(
      buildProxyUrl(
        BASE,
        'homebrew',
        proxyPathFromUpstreamUrl(byKey.homebrew!, '/Homebrew/homebrew-core'),
      ),
    ).toBe(`${BASE}/homebrew/homebrew-core`)

    expect(
      buildProxyUrl(
        BASE,
        'homebrew-api',
        proxyPathFromUpstreamUrl(byKey['homebrew-api']!, '/api/formula/git.json'),
      ),
    ).toBe(`${BASE}/homebrew/api/formula/git.json`)

    expect(
      buildProxyUrl(
        BASE,
        'fedora',
        proxyPathFromUpstreamUrl(
          byKey.fedora!,
          '/fedora/releases/39/Everything/x86_64/os/',
        ),
      ),
    ).toBe(`${BASE}/fedora/releases/39/Everything/x86_64/os/`)
  })

  it('keeps the documented crates search reachable through one prefix', () => {
    const resolved = resolveProxyTarget('/crates/?q=serde', {})
    expect(resolved).toMatchObject({
      ok: true,
      platform: 'crates',
      targetUrl: 'https://crates.io/api/v1/crates?q=serde',
    })
  })
})
