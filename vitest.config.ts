import { createRequire } from 'node:module'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vitest/config'

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const require = createRequire(import.meta.url)

/**
 * A `.wasm` import, the way the platform serves it.
 *
 * In a deployment the bundler turns a WebAssembly file into a module compiled at deploy time; Workers
 * refuse to compile one from bytes at runtime. Vite would instead hand back an asset URL, which is a
 * string — so a test of the interpreter would be testing a path the product never takes. This compiles
 * the file the way the platform does, which is the whole point: the sandbox test runs the real engine.
 *
 * The specifier is claimed at `resolveId` rather than `load`, because Vite's own asset handling answers
 * first otherwise and hands back the URL this plugin exists to avoid.
 */
/** The query this hook appends to a wasm file, so its own ids are recognisable and never re-claimed. */
const MARKER = '?inkstone-wasm-module'

const wasmAsModule = (): Plugin => ({
  name: 'inkstone:wasm-module',
  enforce: 'pre',
  resolveId(source, importer) {
    // A package may expose its module under a subpath rather than a file name — `pkg/wasm` is the usual
    // shape — so that specifier is followed to the file it names. A relative path is resolved against the
    // module that wrote it, which is the only reading that means anything. An id this hook already claimed
    // is left alone, or the marker would be applied to itself.
    if (source.includes(MARKER)) return null
    const isPackageSubpath = /^[^./\\][^:]*\/wasm$/.test(source)
    const isRelative = source.startsWith('.') && source.endsWith('.wasm')
    if (!isRelative && !isPackageSubpath) return null
    const path = isRelative && importer
      ? resolvePath(dirname(importer.startsWith('file:') ? fileURLToPath(importer) : importer), source)
      : require.resolve(source)
    if (!path.endsWith('.wasm')) return null
    return `${path}${MARKER}`
  },
  load(id) {
    if (!id.includes(MARKER)) return null
    const path = id.split('?')[0] ?? ''
    return `import { readFileSync } from 'node:fs'\nexport default new WebAssembly.Module(readFileSync(${JSON.stringify(path)}))\n`
  },
})

export default defineConfig({
  plugins: [wasmAsModule()],
  resolve: {
    alias: {
      '@': resolve('./src/client'),
      '@shared': resolve('./src/shared'),
      'cloudflare:workers': resolve('./tests/doubles/cloudflare-workers.ts'),
    },
  },
  test: {
    // The suite's own tail decides this number. Measured over a full parallel run of every file:
    // one test is 8 ms at the median and 1.5 s at p99, but 38 files hold at least one test above
    // 1.5 s — a 19.8k-note vault rebuilt step by step, a 120-card board mounted six ways, a gate
    // that parses every source file — and those stretch three to five times when the machine is
    // busy. Re-running the whole suite under 24 extra CPU hogs took the source-scanning gate to
    // 12 s, where the five-second default this replaces left it red. Files whose work is far above
    // the line still state their own budget (kanban render, calendar vault); this is the net under
    // the rest, so a heavy test says so out loud instead of racing a stopwatch it cannot win.
    testTimeout: 30_000,
    // hookTimeout keeps its 10 s default because the suite never came near it. Measured over the
    // three full-suite runs behind the number above (5,279 to 5,441 tests, the last under 24 extra
    // CPU hogs): no hook timed out, and everything a file spends outside its tests — imports, hooks,
    // teardown — peaked at 254 ms and 169 ms at p99. Forty times of headroom; a wider clock would
    // only delay the report of a hook that genuinely stalls, which is worth a red run by itself.
    projects: [
      {
        extends: true,
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          // `.tsx` joins `.ts` here because the organizer's icon picker is a component and its test
          // spoke the component suffix — under the old pair of globs that file was collected by no
          // project at all and never ran once. The scratch-probe marker (`*.tmp.*`) stays excluded.
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts', 'tests/**/*.test.tsx'],
          // The last entry is the scratch-probe marker: a `*.tmp.*` file is a measurement in flight,
          // and it is the tsconfig exclusion plus tests/no-scratch-test-files.test.ts that make it
          // invisible to the gates and impossible to leave behind.
          exclude: ['src/worker/lib/request.test.ts', 'src/client/demo/backend.test.ts', 'src/worker/lib/obsidian-import.test.ts', 'tests/backup-retention.test.ts', 'src/client/lib/linter/**', '**/*.tmp.*'],
          server: {
            deps: {
              // Both halves of the interpreter, so the `.wasm` import inside the variant reaches this
              // config's own loader instead of Node's, which cannot read a WebAssembly file as a module.
              inline: ['@cloudflare/workers-oauth-provider', 'quickjs-emscripten-core', '@jitl/quickjs-wasmfile-release-sync'],
            },
          },
        },
      },
      {
        extends: true,
        test: {
          // The linter's own suite, in a UTC worker. Several ported fixtures state a file timestamp
          // with an explicit offset and compare it to a wall clock, which is only decidable in one
          // zone; the reference project's CI runs UTC, so the fixtures were written that way. Giving
          // them a project of their own keeps that assumption in one place instead of leaking a
          // process-wide TZ change into every other suite.
          name: 'linter',
          environment: 'jsdom',
          include: ['src/client/lib/linter/**/*.test.ts'],
          exclude: ['**/*.tmp.*'],
          setupFiles: ['src/client/lib/linter/__tests__/i18n-setup.ts'],
          env: { TZ: 'UTC' },
        },
      },
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/worker/lib/request.test.ts', 'src/client/demo/backend.test.ts', 'src/worker/lib/obsidian-import.test.ts', 'tests/backup-retention.test.ts'],
        },
      },
    ],
  },
})
