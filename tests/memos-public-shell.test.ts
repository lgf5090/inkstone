// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import type { Env } from '../src/worker/env'

const SHELL = '<!doctype html><html><head><title>Inkstone</title></head><body><div id="root"></div></body></html>'

const PUBLIC_PATHS = [
  '/memos/s/token123',
  '/memos/u/alice',
  '/memos/u/alice/m/abc123',
  '/memos/explore',
]

const UNKNOWN_PATHS = [
  '/memos',
  '/memos/unknown',
  '/memos/s',
  '/memos/s/token123/extra',
  '/memos/u',
  '/memos/u/alice/m',
  '/memos/u/alice/m/abc123/extra',
  '/memos/explore/extra',
]

function makeEnv(fetched: string[]): Env {
  return {
    ASSETS: {
      fetch: async (request: Request) => {
        const { pathname } = new URL(request.url)
        fetched.push(pathname)
        if (pathname === '/index.html') {
          return new Response(SHELL, { headers: { 'content-type': 'text/html; charset=utf-8' } })
        }
        return new Response('asset layer')
      },
    },
  } as unknown as Env
}

describe('the public memos shell', () => {
  for (const path of PUBLIC_PATHS) {
    it(`answers ${path} without a session and keeps it out of previews and caches`, async () => {
      const fetched: string[] = []
      const response = await createApp().request(path, {}, makeEnv(fetched))

      expect(response.status).toBe(200)
      expect(response.headers.get('location')).toBeNull()
      expect(response.headers.get('content-type')).toContain('text/html')
      expect(response.headers.get('x-robots-tag')).toBe('noindex')
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('content-security-policy')).toContain("default-src 'self'")

      const html = await response.text()
      expect(fetched).toEqual(['/index.html'])
      expect(html).toContain('<title>Memos · Inkstone</title>')
      expect(html).toContain('property="og:type" content="website"')
      expect(html).toContain('property="og:title" content="Memos"')
      expect(html).toContain('property="og:description" content="Public memos on Inkstone"')
      expect(html).toContain('name="robots" content="noindex, nofollow"')
      expect(html).not.toContain('token123')
      expect(html).not.toContain('alice')
      expect(html).not.toContain('abc123')
    })
  }

  for (const path of UNKNOWN_PATHS) {
    it(`falls through to the asset layer for ${path}`, async () => {
      const fetched: string[] = []
      const response = await createApp().request(path, {}, makeEnv(fetched))

      expect(response.status).toBe(200)
      expect(await response.text()).toBe('asset layer')
      expect(response.headers.get('x-robots-tag')).toBeNull()
      expect(response.headers.get('cache-control')).toBeNull()
      expect(fetched).toEqual([path])
    })
  }
})
