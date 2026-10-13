// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  SHELF_VIEW_MODES,
  isShelfViewMode,
  resolveShelfView,
  type ResolvedShelfView,
} from '../src/client/features/reading/shelf-view'

/**
 * Which layout the shelf actually draws.
 *
 * `adaptive` is the only mode with a condition in it, and a condition that lives inside a component is
 * invisible to every other surface — so it is stated here as a table a reader can check by eye.
 */
describe('the shelf layout a mode asks for', () => {
  it('takes the three named modes literally, on any width', () => {
    for (const mode of ['grid', 'list', 'covers'] as const) {
      expect(resolveShelfView(mode, false)).toBe(mode)
      expect(resolveShelfView(mode, true)).toBe(mode)
    }
  })

  it('falls back to the list only when adaptive has no room for a grid', () => {
    expect(resolveShelfView('adaptive', false)).toBe('grid')
    expect(resolveShelfView('adaptive', true)).toBe('list')
  })

  it('offers exactly the four modes the toolbar prints', () => {
    expect([...SHELF_VIEW_MODES].sort()).toEqual(['adaptive', 'covers', 'grid', 'list'])
    for (const mode of SHELF_VIEW_MODES) expect(isShelfViewMode(mode)).toBe(true)
  })

  it('refuses a stored value that is not a mode', () => {
    for (const junk of ['two-column', '', 'GRID', 'adaptive ', 7, null, undefined]) {
      expect(isShelfViewMode(junk)).toBe(false)
    }
  })

  it('resolves every mode to something the shelf can draw', () => {
    const drawable: ResolvedShelfView[] = ['grid', 'list', 'covers']
    for (const mode of SHELF_VIEW_MODES) {
      expect(drawable).toContain(resolveShelfView(mode, false))
      expect(drawable).toContain(resolveShelfView(mode, true))
    }
  })
})
