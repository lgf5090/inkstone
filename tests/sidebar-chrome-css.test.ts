import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The pinned panel chrome is one CSS rule shared by every sidebar tab, so the rule
 * itself is the thing that has to stay intact — the per-panel guards can only see the
 * class on the element. Read here rather than in the component's own test because this
 * is the project that may touch the filesystem.
 */
describe('the pinned sidebar chrome rule', () => {
  const css = readFileSync('src/client/styles/app.css', 'utf8')
  const rule = /\.sidebar-chrome\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''

  it('exists', () => {
    expect(rule).toBeTruthy()
  })

  it('pins to the top of the panel that scrolls', () => {
    expect(rule).toContain('position: sticky')
    // Without a top the rule pins to the element's own static position, which is exactly
    // the upward drift this exists to stop.
    expect(rule).toMatch(/top:\s*0/)
  })

  it('stacks above the rows that scroll under it and below every portal', () => {
    const z = Number(/z-index:\s*(\d+)/.exec(rule)?.[1])
    expect(z).toBeGreaterThan(0)
    expect(z).toBeLessThan(100)
  })
})
