// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  asOfficeSnapshot,
  detectOfficeSnapshotType,
  findInlineOfficeImages,
  replaceInlineOfficeImages,
  sha256Hex,
} from '../src/shared/office/snapshot'

/**
 * The snapshot helpers decide two things the editors depend on: which product an imported file is, and
 * which inline images still need a trip to R2. Both run on data the app did not author, so the tests
 * cover the shapes that made them necessary — nested arrays, repeated images, and depth cut-offs.
 */

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const GIF = 'data:image/gif;base64,R0lGODlhAQABAA=='

describe('office snapshot type detection', () => {
  it('names each product by the keys its snapshot carries', () => {
    expect(detectOfficeSnapshotType({ sheetOrder: [], sheets: {} })).toBe('sheets')
    expect(detectOfficeSnapshotType({ sheets: {}, styles: {} })).toBe('sheets')
    expect(detectOfficeSnapshotType({ body: {} })).toBe('docs')
    expect(detectOfficeSnapshotType({ documentStyle: {} })).toBe('docs')
    expect(detectOfficeSnapshotType({ pages: [], pageSize: {} })).toBe('slides')
    expect(detectOfficeSnapshotType({ tables: {}, tableOrder: [] })).toBe('bases')
    expect(detectOfficeSnapshotType({ pageOrder: [], pages: {} })).toBe('boards')
    expect(detectOfficeSnapshotType({ pages: [] })).toBe('pdfs')
  })

  it('refuses anything it cannot name instead of guessing', () => {
    expect(detectOfficeSnapshotType(null)).toBeNull()
    expect(detectOfficeSnapshotType([])).toBeNull()
    expect(detectOfficeSnapshotType('sheets')).toBeNull()
    expect(detectOfficeSnapshotType({})).toBeNull()
  })
})

describe('inline image scanning', () => {
  it('finds images nested in objects and arrays, once each', () => {
    const snapshot = {
      pages: [{ drawings: [{ source: PNG }, { source: GIF }] }, { source: PNG }],
      styles: { header: { image: PNG } },
    }
    const found = findInlineOfficeImages(snapshot)
    expect(found.map((image) => image.mime).sort()).toEqual(['image/gif', 'image/png'])
    expect(found).toHaveLength(2)
  })

  it('ignores empty payloads and non-image data URLs', () => {
    const found = findInlineOfficeImages({
      a: 'data:image/png;base64,',
      b: 'data:text/plain;base64,QQ==',
      c: 'https://example.test/a.png',
      d: '',
    })
    expect(found).toEqual([])
  })

  it('stops at the configured depth so a cyclic object cannot hang the scan', () => {
    const deep = { level1: { level2: { level3: PNG } } }
    expect(findInlineOfficeImages(deep, 1)).toEqual([])
    expect(findInlineOfficeImages(deep, 4)).toHaveLength(1)
  })
})

describe('inline image replacement', () => {
  it('returns a new tree with the mapped values and leaves the input untouched', () => {
    const snapshot = { pages: [{ source: PNG }, { source: GIF }] }
    const mapping = new Map([[PNG, '/api/office/assets/one']])
    const replaced = replaceInlineOfficeImages(snapshot, mapping) as typeof snapshot

    expect(replaced.pages[0]?.source).toBe('/api/office/assets/one')
    expect(replaced.pages[1]?.source).toBe(GIF)
    expect(snapshot.pages[0]?.source).toBe(PNG)
    expect(replaced).not.toBe(snapshot)
    expect(replaced.pages).not.toBe(snapshot.pages)
  })
})

describe('snapshot coercion and hashing', () => {
  it('only accepts an object as a snapshot', () => {
    expect(asOfficeSnapshot({ sheets: {} })).toEqual({ sheets: {} })
    expect(asOfficeSnapshot([])).toBeNull()
    expect(asOfficeSnapshot('x')).toBeNull()
    expect(asOfficeSnapshot(null)).toBeNull()
  })

  it('hashes the same text to the same digest', async () => {
    const first = await sha256Hex('{"a":1}')
    expect(first).toBe(await sha256Hex('{"a":1}'))
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(first).not.toBe(await sha256Hex('{"a":2}'))
  })
})
