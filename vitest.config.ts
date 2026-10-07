import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
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
          include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
          // The last entry is the scratch-probe marker: a `*.tmp.*` file is a measurement in flight,
          // and it is the tsconfig exclusion plus tests/no-scratch-test-files.test.ts that make it
          // invisible to the gates and impossible to leave behind.
          exclude: ['src/worker/lib/request.test.ts', 'src/client/demo/backend.test.ts', 'src/worker/lib/obsidian-import.test.ts', 'tests/backup-retention.test.ts', '**/*.tmp.*'],
          server: {
            deps: {
              inline: ['@cloudflare/workers-oauth-provider'],
            },
          },
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
