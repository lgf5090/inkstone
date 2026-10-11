import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '..')
const SIDEBAR = readFileSync(resolve(ROOT, 'src/client/features/sidebar/Sidebar.tsx'), 'utf8')

function headerBody(): string {
  const start = SIDEBAR.indexOf('<header')
  expect(start, 'the sidebar no longer opens with a header element').toBeGreaterThan(-1)
  const end = SIDEBAR.indexOf('</header>', start)
  expect(end, 'the sidebar header is no longer closed').toBeGreaterThan(start)
  return SIDEBAR.slice(start, end)
}

function railBody(): string {
  const start = SIDEBAR.indexOf('function SidebarRail')
  expect(start, 'the collapsed rail is no longer a function of the sidebar').toBeGreaterThan(-1)
  const end = SIDEBAR.indexOf('\nfunction ', start + 1)
  return SIDEBAR.slice(start, end === -1 ? SIDEBAR.length : end)
}

function entryBody(): string {
  const start = SIDEBAR.indexOf('function CommandPaletteEntry')
  expect(start, 'the sidebar no longer defines its command palette entry').toBeGreaterThan(-1)
  const end = SIDEBAR.indexOf('\nfunction ', start + 1)
  return SIDEBAR.slice(start, end === -1 ? SIDEBAR.length : end)
}

describe('the sidebar header opens the command palette', () => {
  it('sits in front of the Omnisearch entry', () => {
    const header = headerBody()
    expect(header.indexOf('<CommandPaletteEntry/>')).toBeGreaterThan(-1)
    expect(header.indexOf('<CommandPaletteEntry/>')).toBeLessThan(header.indexOf('<OmnisearchEntry'))
  })

  it('keeps the collapsed rail in the same order', () => {
    const rail = railBody()
    const palette = rail.indexOf('common.command_palette')
    expect(palette).toBeGreaterThan(-1)
    expect(palette).toBeLessThan(rail.indexOf('<OmnisearchRailButton/>'))
  })

  it('toggles the palette through the store rather than a second opener', () => {
    expect(entryBody()).toContain("togglePanel('command')")
    expect(entryBody()).toContain("active={panel === 'command'}")
  })

  it('names itself after the palette and spells the chord from the shared table', () => {
    const entry = entryBody()
    expect(entry).toContain('t("common.command_palette")')
    expect(entry).toContain('combo={APP_SHORTCUTS.command}')
    expect(SIDEBAR).not.toMatch(/['"]mod\+shift\+p['"]/)
  })

  it('reads only the state its own button draws, so the tree below does not re-render', () => {
    const entry = entryBody()
    expect(entry.match(/useUi\(\(s\) => s\.\w+\)/g)).toEqual([
      'useUi((s) => s.panel)',
      'useUi((s) => s.togglePanel)',
    ])
  })
})
