// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { BUILTIN_ID_PHOTO_SPECS } from '../src/shared/tools/id-photo/specs'
import type { IdPhotoSpec } from '../src/shared/tools/id-photo/types'
import {
  compareSize,
  defaultCompareIds,
  MAX_COMPARE,
  MIN_COMPARE,
  toggleCompareId,
} from '../src/client/features/tools/id-photo/compare/compare-model'

const spec = (overrides: Partial<IdPhotoSpec>): IdPhotoSpec => ({
  id: 'x',
  name: 'X',
  category: 'custom',
  countryCode: '',
  countryNameKey: '',
  widthMm: 25,
  heightMm: 35,
  widthPx: 295,
  heightPx: 413,
  dpi: 300,
  recommendedBgColors: ['#ffffff'],
  faceRatioMin: 0.6,
  faceRatioMax: 0.8,
  ...overrides,
})

describe('ID photo compare strip model', () => {
  it('shrinks a frame to the shared edge without changing its shape', () => {
    const small = compareSize(spec({ widthPx: 295, heightPx: 413 }))
    expect(small.width).toBe(214)
    expect(small.height).toBe(300)
    expect(Math.abs(small.width / small.height - 295 / 413)).toBeLessThan(0.01)

    const wide = compareSize(spec({ widthPx: 600, heightPx: 300 }))
    expect(wide).toEqual({ width: 300, height: 150 })
  })

  it('never enlarges a specification that is already smaller than the strip', () => {
    expect(compareSize(spec({ widthPx: 90, heightPx: 120 }))).toEqual({ width: 90, height: 120 })
    expect(compareSize(spec({ widthPx: 0, heightPx: 0 }))).toEqual({ width: 1, height: 1 })
  })

  it('starts with the working specification plus one neighbour', () => {
    const active = BUILTIN_ID_PHOTO_SPECS[4]
    const ids = defaultCompareIds(active.id, BUILTIN_ID_PHOTO_SPECS)
    expect(ids).toHaveLength(MIN_COMPARE)
    expect(ids[0]).toBe(active.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('still fills the strip when the active specification is unknown', () => {
    const ids = defaultCompareIds('deleted_custom', BUILTIN_ID_PHOTO_SPECS)
    expect(ids).toHaveLength(MIN_COMPARE)
    expect(ids).not.toContain('deleted_custom')
  })

  it('settles on one specification when the catalogue holds only one', () => {
    const only = [spec({ id: 'solo' })]
    expect(defaultCompareIds('solo', only)).toEqual(['solo'])
  })

  it('adds a frame until the strip is full and then refuses', () => {
    let ids = ['a', 'b']
    const added = toggleCompareId(ids, 'c')
    expect(added).toEqual({ ids: ['a', 'b', 'c'], refused: 'none' })
    ids = added.ids
    ids = toggleCompareId(ids, 'd').ids
    expect(ids).toHaveLength(MAX_COMPARE)
    expect(toggleCompareId(ids, 'e').refused).toBe('max')
    expect(toggleCompareId(ids, 'e').ids).toEqual(ids)
  })

  it('keeps re-adding the frame it just removed', () => {
    const ids = ['a', 'b', 'c']
    const removed = toggleCompareId(ids, 'b')
    expect(removed.ids).toEqual(['a', 'c'])
    expect(toggleCompareId(removed.ids, 'b').ids).toEqual(['a', 'c', 'b'])
  })

  it('will not let the strip fall below two frames', () => {
    const ids = ['a', 'b']
    const refused = toggleCompareId(ids, 'a')
    expect(refused).toEqual({ ids: ['a', 'b'], refused: 'min' })
  })

  it('bounds the catalogue so the strip can never ask for more than it holds', () => {
    expect(MIN_COMPARE).toBeLessThanOrEqual(MAX_COMPARE)
    expect(BUILTIN_ID_PHOTO_SPECS.length).toBeGreaterThanOrEqual(MAX_COMPARE)
  })
})
