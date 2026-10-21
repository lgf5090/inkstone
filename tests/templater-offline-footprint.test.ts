// @vitest-environment node
/**
 * What the first screen and the offline shell are allowed to know about the template sandbox.
 *
 * The port brings the heaviest single file in the app: a 503,134-byte QuickJS WebAssembly module, the worker
 * chunk that loads it (~185 KB) and the door that starts a run (~26 KB). None of it belongs on the first
 * screen, and today none of it is there — for a structural reason rather than a lucky one. `pwa.config.ts`
 * builds the service worker's `CORE_URLS`, the set the worker downloads at `install` before a reader has read
 * anything, by walking the *static* import graph of the entry chunk and of the modules hand-written into
 * `CORE_LAZY_MODULES` (`collectCoreFiles`). A chunk that a dynamic `import()` pulls in is not in that graph,
 * so it cannot reach the shell. The ways it can are both one-line changes: turn a lazy import into a static
 * one, or write the module's name into the shell's hand-written lists.
 *
 * Neither is visible when it happens. Nothing throws when the shell grows by three quarters of a megabyte —
 * the app still opens, offline still works, and a reader on a plane quietly downloads an interpreter they will
 * never start. So this file reads the built `dist/client/sw.js` and asks the artifact which URLs it preheats,
 * the way `tests/service-worker-warmup.test.ts` asks the generated worker what it fetches.
 *
 * The artifacts are found by following references rather than by matching names, because a chunk name carries
 * a content hash that changes on every edit and because `templater-*` is also the prefix the *editor*'s
 * chunks get: `templater-completion-<hash>.js` is legitimately in the shell (syntax highlighting and
 * completion have to be instant, and it cannot start a run), while `templater-<hash>.js` is the door and must
 * not be. The door is therefore identified as the chunk whose code names the worker chunk, the worker as the
 * chunk named `templater.worker-*`, and the WebAssembly module as the URL the worker fetches. A guard built on
 * names alone would have been wrong in both directions within a week.
 *
 * The background set is a different question and is deliberately not asserted here: `WARMUP_URLS` is
 * `ALL_OFFLINE_URLS` minus `CORE_URLS` minus `ON_DEMAND_PATTERN`, so it is a complement, and a lazily imported
 * chunk joins it unless something names it. Measured on this branch's build, the door, the worker and the wasm
 * are all three in that background set (713,909 bytes), and the numbers below print it rather than hide it.
 * Excluding them is `pwa.config.ts`'s on-demand list to decide — plan card P11-6 — not a first-screen fact, so
 * it is reported here and asserted nowhere.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const BUILD_DIR = join(process.cwd(), 'dist', 'client')
const SW_PATH = join(BUILD_DIR, 'sw.js')
const ASSETS_DIR = join(BUILD_DIR, 'assets')
const PWA_CONFIG = join(process.cwd(), 'pwa.config.ts')

const buildPresent = existsSync(SW_PATH) && existsSync(ASSETS_DIR)

// A guard that measured nothing must not look like a guard that passed. Vitest counts these cases as skipped
// in the run summary, and this line names the file and the command so the reason is in the log too.
if (!buildPresent) {
  console.warn(
    '[templater-offline-footprint] SKIPPED: no dist/client/sw.js to measure. '
    + 'Run `npm run build` first — this guard reads the built bundle and has tested nothing without it.',
  )
}

function readUrlList(source: string, name: string): string[] {
  const marker = `const ${name} = `
  const at = source.indexOf(marker)
  // Failing here instead of returning an empty list is the point: an emptied set satisfies every
  // "must not contain" assertion below, silently.
  if (at < 0) throw new Error(`sw.js no longer declares ${name} as a literal array — reread this guard, do not trust it`)
  return JSON.parse(source.slice(at + marker.length, source.indexOf('\n', at)).trim()) as string[]
}

function readOnDemandPattern(source: string): RegExp {
  const match = source.match(/const ON_DEMAND_PATTERN = new RegExp\((".*?"), 'i'\)/)
  if (!match) throw new Error('sw.js no longer builds ON_DEMAND_PATTERN from a literal — reread this guard')
  return new RegExp(JSON.parse(match[1]!) as string, 'i')
}

/**
 * The sandbox's own emitted files, traced through the build.
 *
 * Each step is a reference one file makes to another, so the WebAssembly module is attributed to Templater by
 * the worker that loads it and the door is attributed by the worker it spawns. If a step ever finds nothing,
 * that is reported as a failure of this guard rather than as a pass: a build whose sandbox cannot be located
 * is a build nobody has measured.
 */
function sandboxArtifacts(): string[] {
  const names = readdirSync(ASSETS_DIR).filter((name) => name.endsWith('.js'))
  const worker = names.filter((name) => /^templater\.worker-[A-Za-z0-9_-]+\.js$/.test(name))
  expect(worker.length, 'the build emitted no templater worker chunk — the sandbox moved or vanished')
    .toBeGreaterThan(0)

  const door = names.filter((name) => !worker.includes(name)
    && readFileSync(join(ASSETS_DIR, name), 'utf8').includes(worker[0]!))
  expect(door.length, `no chunk references ${worker[0]}, so nothing in the build starts the worker`)
    .toBeGreaterThan(0)

  const wasm = new Set<string>()
  for (const name of worker) {
    for (const match of readFileSync(join(ASSETS_DIR, name), 'utf8').matchAll(/['"`](\/assets\/[A-Za-z0-9_.-]+\.wasm)['"`]/g)) {
      wasm.add(match[1]!)
    }
  }
  expect([...wasm], 'the templater worker chunk references no .wasm URL — the guard has lost its subject')
    .not.toHaveLength(0)

  return [...new Set([...door, ...worker, ...wasm].map((name) => (name.startsWith('/') ? name : `/assets/${name}`)))].sort()
}

function bytesOf(url: string): number {
  return statSync(join(BUILD_DIR, url.slice(1))).size
}

const formatBytes = (value: number) => value.toLocaleString('en-US')

describe('the built offline shell carries no template sandbox', () => {
  const swSource = buildPresent ? readFileSync(SW_PATH, 'utf8') : ''
  const core = buildPresent ? readUrlList(swSource, 'CORE_URLS') : []
  const all = buildPresent ? readUrlList(swSource, 'ALL_OFFLINE_URLS') : []
  const onDemand = buildPresent ? readOnDemandPattern(swSource) : null
  const artifacts = buildPresent ? sandboxArtifacts() : []
  const warmup = buildPresent && onDemand
    ? all.filter((url) => !core.includes(url)).filter((url) => !onDemand.test(url))
    : []

  it.skipIf(!buildPresent)('measures a build that really contains the sandbox', () => {
    for (const url of artifacts) {
      expect(bytesOf(url), `${url} is listed by the build but reads as empty`).toBeGreaterThan(1000)
    }
    const shellBytes = core.reduce(
      (sum, url) => sum + (existsSync(join(BUILD_DIR, url.slice(1))) ? bytesOf(url) : 0),
      0,
    )
    console.info(
      '[templater-offline-footprint] sandbox artifacts: '
      + artifacts.map((url) => `${url} (${formatBytes(bytesOf(url))} B)`).join(', '),
    )
    console.info(
      `[templater-offline-footprint] CORE_URLS ${core.length} entries / ${formatBytes(shellBytes)} B, `
      + `ALL_OFFLINE_URLS ${all.length}, background WARMUP_URLS ${warmup.length}`,
    )
    console.info(
      '[templater-offline-footprint] templater-named entries inside the shell: '
      + (core.filter((url) => /templater/i.test(url)).join(', ') || 'none'),
    )
  })

  it.skipIf(!buildPresent)('keeps the door, the worker and the wasm out of the preheated shell', () => {
    const offenders = artifacts.filter((url) => core.includes(url))
    expect(offenders, `the install-time shell preheates template-sandbox files: ${offenders.join(', ')}`).toEqual([])
  })

  it.skipIf(!buildPresent)('leaves no shell chunk able to start the interpreter', () => {
    // The name-independent form of the same rule: whatever a shell chunk is called, it may not carry the URL
    // of the worker or of the WebAssembly module, because holding either is what makes a run startable from
    // the first screen — and a hand-written name in `CORE_LAZY_MODULES` is caught here even when the module it
    // pointed at has since been folded into another chunk.
    //
    // The door's own name is deliberately excluded. `await import()` compiles to a statement that spells the
    // target's file name, so the shell chunk `run-shell-*.js` legitimately names the door while keeping the
    // door, the worker and the wasm off the download. Requiring that name to be absent would ask the shell to
    // stop knowing what it lazily loads, which is the mechanism this guard depends on rather than a leak.
    const offenders: string[] = []
    const loadable = artifacts
      .filter((url) => /templater\.worker-/.test(url) || url.endsWith('.wasm'))
      .map((url) => url.split('/').pop()!)
    expect(loadable.length).toBeGreaterThan(0)
    for (const url of core.filter((entry) => entry.endsWith('.js'))) {
      const code = readFileSync(join(BUILD_DIR, url.slice(1)), 'utf8')
      const hits = loadable.filter((name) => code.includes(name))
      if (hits.length) offenders.push(`${url} -> ${hits.join(', ')}`)
    }
    expect(offenders, `these shell chunks reference the sandbox worker or its wasm: ${offenders.join('; ')}`).toEqual([])
  })

  it.skipIf(!buildPresent)('still serves the sandbox offline once a reader has opened it', () => {
    // The other half of the promise. Excluded from the shell must not mean unreachable: this is the §7.6
    // delivery-channel check, and a missing entry here is what turns "offline, first template" into a 404.
    for (const url of artifacts) {
      expect(all, `${url} is not in ALL_OFFLINE_URLS, so the worker cannot cache it`).toContain(url)
    }
  })

  it.skipIf(!buildPresent)('reports what the sandbox costs, and where it is allowed to sit', () => {
    const shellBytes = artifacts.filter((url) => core.includes(url)).reduce((sum, url) => sum + bytesOf(url), 0)
    const warmed = artifacts.filter((url) => warmup.includes(url))
    expect(shellBytes, 'the shell carries sandbox bytes this guard says it must not').toBe(0)
    console.info(
      '[templater-offline-footprint] shell share of the sandbox: 0 B of '
      + `${formatBytes(artifacts.reduce((sum, url) => sum + bytesOf(url), 0))} B; the background warm-up `
      + `downloads ${warmed.length} of ${artifacts.length} files `
      + `(${formatBytes(warmed.reduce((sum, url) => sum + bytesOf(url), 0))} B) — `
      + 'that list is pwa.config.ts `onDemandSource`, plan card P11-6',
    )
  })
})

/**
 * The two hand-written inputs to the shell, which need no build to check.
 *
 * `CORE_URLS` is derived, but it is derived from these lists plus the static graph. The cases above keep the
 * derived part honest; keeping the written part honest is cheap enough to do here, so a reader who runs the
 * suite before building still gets half the guard instead of nothing.
 */
describe('the shell hand-written lists name no sandbox module', () => {
  const source = readFileSync(PWA_CONFIG, 'utf8')

  const listLiteral = (name: string): string[] => {
    const marker = `const ${name} = [`
    const at = source.indexOf(marker)
    if (at < 0) throw new Error(`pwa.config.ts no longer declares ${name} as an array literal`)
    return [...source.slice(at + marker.length, source.indexOf(']', at)).matchAll(/['"`]([^'"`]+)['"`]/g)]
      .map((match) => match[1]!)
  }

  it('lists no templater module among the lazy modules that make the shell', () => {
    const lazy = listLiteral('CORE_LAZY_MODULES')
    expect(lazy.length).toBeGreaterThan(0)
    for (const entry of lazy) {
      expect(entry, `CORE_LAZY_MODULES points at the templater: ${entry}`).not.toMatch(/templater/i)
    }
  })

  it('lists no sandbox file among the public shell assets', () => {
    const assets = [...listLiteral('CORE_PUBLIC_ASSETS'), ...listLiteral('OPTIONAL_PUBLIC_ASSETS')]
    expect(assets.length).toBeGreaterThan(0)
    for (const entry of assets) {
      expect(entry, `a public asset named for the sandbox joined the shell: ${entry}`)
        .not.toMatch(/templater|quickjs|emscripten/i)
    }
  })
})
