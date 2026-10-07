// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const UI_STORE = new URL('../src/client/store/ui.ts', import.meta.url)
const SHELL = new URL('../src/client/features/shell/AppShell.tsx', import.meta.url)

function panelNames(): string[] {
  const source = readFileSync(UI_STORE, 'utf8')
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.startsWith('export type PanelName ='))
  if (start < 0) throw new Error('PanelName is no longer declared in the ui store')
  const names: string[] = []
  for (const line of lines.slice(start + 1)) {
    const match = /^\s*\| '([a-z-]+)'/.exec(line)
    if (!match) break
    names.push(match[1])
  }
  return names
}

describe('every panel the ui store can open', () => {
  const names = panelNames()
  const shell = readFileSync(SHELL, 'utf8')

  it('is a non-empty list, so this test cannot pass by vacuity', () => {
    expect(names.length).toBeGreaterThanOrEqual(6)
  })

  for (const name of names) {
    it(`is mounted by the shell under panel === '${name}'`, () => {
      expect(shell).toContain(`panel === '${name}'`)
    })

    it(`mounts a component whose name is not just the panel key (${name})`, () => {
      const mounted = new RegExp(`panel === '${name}' && <([A-Z][A-Za-z]*)`).exec(shell)
      expect(mounted, `nothing is rendered for panel '${name}'`).not.toBeNull()
      expect(mounted![1].length).toBeGreaterThan(1)
    })
  }
})
