// @vitest-environment node
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { securityHeaders } from '../src/worker/lib/security-headers'
import { isDrainFire, isHourStart } from '../src/worker/index'

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

it('a reminder’s minute is a minute the cron actually fires, and only the sweeps ride it', () => {
  // The cadence lives in a deployment file, so no Worker-side test could ever notice it drifting back to a
  // pattern like `0,15,45 * * * *` — where a reminder set at :16 waits until :45 while every sweep still
  // passes its own tests. Both halves are pinned: the pattern fires on every minute, and the extra fires
  // buy nothing but sweeps.
  for (const file of ['wrangler.toml', 'wrangler.kv.toml']) {
    const declaration = /^crons = \[(.*)\]$/m.exec(config(file))
    expect(declaration, `${file} must declare a cron trigger`).not.toBeNull()
    const patterns = [...declaration![1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!)
    expect(patterns.length, `${file} must schedule something`).toBeGreaterThan(0)
    for (const pattern of patterns) {
      expect(pattern.split(' ')[0], `${file} fires ${pattern} on more than one minute an hour`).toBe('*')
    }
  }
  const hour = Array.from({ length: 60 }, (_, minute) => Date.UTC(2026, 9, 18, 12, minute))
  expect(hour.filter((time) => isDrainFire(time)), 'the drains must not run sixty times an hour').toHaveLength(3)
  expect(hour.filter((time) => isHourStart(time)), 'the whole-library work must run once an hour').toHaveLength(1)
})

it('keeps lockfile sources on the pinned registries with content hashes', () => {
  const lock = JSON.parse(read('../package-lock.json')) as {
    packages: Record<string, { resolved?: string; integrity?: string; hasInstallScript?: boolean }>
  }
  // Mirror-sourced `resolved` entries were normalised to the official registry once the
  // recorded hashes were confirmed identical there; new drift must be deliberate.
  const allowedHosts = new Set(['registry.npmjs.org'])
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

// The sanitising chain decides what the browser is allowed to execute, so a floating range
// means one `npm install` can swap the implementation with no gate going red.
it('pins the sanitising and rendering chain to exact versions', () => {
  const pkg = JSON.parse(read('../package.json')) as { dependencies: Record<string, string> }
  const pinned = [
    'dompurify', 'mermaid', 'katex', 'markdown-it', 'markdown-it-anchor',
    'markdown-it-footnote', 'markdown-it-mark', 'markdown-it-task-lists', 'prismjs',
  ]
  for (const name of pinned) {
    const range = pkg.dependencies[name]
    expect(range, `${name} is missing`).toBeTruthy()
    expect(range, `${name} floats at ${range}`).toMatch(/^\d+\.\d+\.\d+$/)
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

it('relaxes script-src for nothing but a dev HTML document', () => {
  const strict = securityHeaders('https://note.test/')['Content-Security-Policy']
  const dev = securityHeaders('https://note.test/', { allowDevInlineScripts: true })['Content-Security-Policy']
  const scriptSrc = "script-src 'self' https://static.cloudflareinsights.com"

  expect(strict).toContain(`${scriptSrc};`)
  expect(/script-src([^;]*)/.exec(strict)?.[1] ?? '').not.toContain("'unsafe-inline'")
  // the relaxation touches that one source expression and no other directive
  expect(dev).toContain(`${scriptSrc} 'unsafe-inline';`)
  expect(dev.replace(`${scriptSrc} 'unsafe-inline'; `, `${scriptSrc}; `)).toBe(strict)

  // opting in requires a Vite dev build *and* an HTML response, so /api/* stays strict
  const app = read('../src/worker/app.ts')
  expect(app).toContain('import.meta.env?.DEV === true')
  expect(app).toContain("includes('text/html')")
  // the provider/MCP edge responses build their own headers and never opt in
  expect(read('../src/worker/index.ts')).not.toContain('allowDevInlineScripts')
})
