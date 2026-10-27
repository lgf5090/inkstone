// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { APP_TABS, tabIdForPath } from '../src/client/features/shell/app-tabs'

const CONFIGS = ['wrangler.toml', 'wrangler.kv.toml']

function workerFirstPaths(config: string): string[] {
  const source = readFileSync(config, 'utf8')
  const block = /run_worker_first = \[([\s\S]*?)\]/.exec(source)?.[1]
  if (!block) throw new Error(`${config} has no run_worker_first list`)
  return [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1])
}

describe('the addresses the client routes on its own', () => {
  for (const config of CONFIGS) {
    it(`asks the worker for every app tab in ${config}`, () => {
      const paths = workerFirstPaths(config)
      // An address missing from this list is still served — by the asset layer's SPA fallback,
      // which never reaches the worker, so the document arrives without our Content-Security-Policy.
      for (const tab of APP_TABS) expect(paths).toContain(tab.path)
      expect(paths).toContain('/')
      expect(paths).toContain('/n/*')
      expect(paths).toContain('/tools/*')
    })

    it(`keeps ${config}'s list free of duplicates`, () => {
      const paths = workerFirstPaths(config)
      expect(new Set(paths).size).toBe(paths.length)
    })
  }

  it('routes nested cloudflare paths to the cloudflare tab', () => {
    expect(tabIdForPath('/cloudflare')).toBe('cloudflare')
    expect(tabIdForPath('/cloudflare/')).toBe('cloudflare')
    expect(tabIdForPath('/cloudflare/dns')).toBe('cloudflare')
    expect(tabIdForPath('/cloudflare/ai')).toBe('cloudflare')
  })

  it('routes nested tools paths to the tools tab', () => {
    expect(tabIdForPath('/tools')).toBe('tools')
    expect(tabIdForPath('/tools/')).toBe('tools')
    expect(tabIdForPath('/tools/password')).toBe('tools')
    expect(tabIdForPath('/tools/password/accounts')).toBe('tools')
  })
})
