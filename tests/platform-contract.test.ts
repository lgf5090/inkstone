// @vitest-environment node
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

// Nothing else in this repository reads the deployment configs or the lockfile, so the
// claims in SECURITY.md had no mechanical check at all. These assertions are that check.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const config = (path: string) => read(`../${path}`)

const SECURITY_DEPENDENT_FLAGS = 'global_fetch_strictly_public'

it('every runnable Worker config keeps the SSRF hard boundary', () => {
  for (const file of ['wrangler.toml', 'wrangler.kv.toml']) {
    const text = config(file)
    expect(text, `${file} deploys a Worker`).toContain('main = "src/worker/index.ts"')
    expect(text, `${file} must block internal and metadata addresses`)
      .toContain(SECURITY_DEPENDENT_FLAGS)
  }
  // The demo form is static assets only, so it must not grow a Worker entry point.
  expect(config('wrangler.demo.toml')).not.toContain('main = ')
})

it('the two storage shapes cannot overwrite each other’s bindings', () => {
  const names = ['wrangler.toml', 'wrangler.kv.toml', 'wrangler.demo.toml']
    .map((file) => /^name = "(.+)"$/m.exec(config(file))![1])
  expect(new Set(names).size).toBe(names.length)
})

it('no config leaves version preview URLs as a second public entry point', () => {
  for (const file of ['wrangler.toml', 'wrangler.kv.toml']) {
    expect(config(file), `${file} must disable preview URLs`).toContain('preview_urls = false')
  }
})

it('keeps lockfile sources on the pinned registries with content hashes', () => {
  const lock = JSON.parse(read('../package-lock.json')) as {
    packages: Record<string, { resolved?: string; integrity?: string; hasInstallScript?: boolean }>
  }
  const allowedHosts = new Set(['registry.npmjs.org', 'registry.npmmirror.com'])
  // Postinstall code runs before any Worker policy applies, so the set is allow-listed.
  const allowedInstallScripts = new Set([
    'node_modules/core-js-pure',
    'node_modules/esbuild',
    'node_modules/fsevents',
    'node_modules/workerd',
  ])
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name || !entry.resolved) continue
    const url = new URL(entry.resolved)
    expect(url.protocol, `${name} is not fetched over https`).toBe('https:')
    expect(allowedHosts.has(url.host), `${name} comes from ${url.host}`).toBe(true)
    expect(entry.integrity, `${name} has no integrity hash`).toBeTruthy()
    if (entry.hasInstallScript) {
      expect(allowedInstallScripts.has(name), `${name} added an install script`).toBe(true)
    }
  }
})

it('SECURITY.md keeps describing the guards that actually exist', () => {
  const security = read('../SECURITY.md')
  const quota = read('../src/worker/db/quota.ts')
  const passcode = read('../src/shared/share-passcode.ts')
  const request = read('../src/worker/lib/request.ts')

  expect(security).toContain(SECURITY_DEPENDENT_FLAGS)
  expect(security).toContain('SETUP_TOKEN')
  expect(security).toContain('DO_AUTH_KEY')

  const minChars = Number(/sharePasscodeMinLength: (\d+)/.exec(read('../src/shared/constants.ts'))![1])
  expect(passcode).toContain('LIMITS.sharePasscodeMinLength')
  expect(security).toContain(`at least ${minChars} characters`)

  const setupFloor = Number(
    /expected\.length < (\d+)/.exec(read('../src/worker/routes/auth.ts'))![1],
  )
  expect(security).toContain(`at least ${setupFloor} characters`)

  expect(quota).toContain('LIMITS.notesMaxPerUser')
  expect(request).toContain('CF-Connecting-IP')
})

it('the only client IP rule set is the one that checks for cf', () => {
  const sources = [
    'src/worker/routes/auth.ts',
    'src/worker/routes/share.ts',
    'src/worker/mcp/oauth.ts',
    'src/worker/lib/request.ts',
  ]
  for (const file of sources) {
    if (file.endsWith('request.ts')) continue
    expect(read(`../${file}`), `${file} must not read CF-Connecting-IP itself`)
      .not.toContain('CF-Connecting-IP')
  }
  expect(read('../src/worker/mcp/oauth.ts')).toContain('requestClientIp(request)')
})
