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
    projects: [
      {
        extends: true,
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
          exclude: ['src/worker/lib/request.test.ts', 'src/client/demo/backend.test.ts', 'src/worker/lib/obsidian-import.test.ts', 'tests/backup-retention.test.ts'],
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
