// @vitest-environment node
/**
 * The backup file, both ways.
 *
 * A favourite colour used to be write-once in the worst sense: no export, no trash, and a delete button on
 * hover. The file format is the smallest thing that makes loss recoverable, so its rules — what counts as a
 * backup, how many rows one may carry — are what this test pins.
 */
import { describe, expect, it } from 'vitest'
import {
  buildColorBackup,
  COLOR_BACKUP_MAX_ROWS,
  COLOR_BACKUP_VERSION,
  parseColorBackup,
} from '@shared/tools/color/backup'
import { COLOR_LIST_LIMIT, COLOR_PALETTE_MAX_COLORS } from '@shared/tools/color/contract'

const backup = {
  version: COLOR_BACKUP_VERSION,
  exportedAt: '2026-11-01T00:00:00.000Z',
  favorites: [
    { id: 'fav_a001', hex: '#22aa33', name: 'Fern', tags: ['primary'], note: 'buttons', sort: 0 },
  ],
  palettes: [
    {
      id: 'pal_a001',
      title: 'Dusk',
      colors: [{ hex: '#0f172a', name: 'Navy', ratio: 30 }],
      sourceType: 'custom' as const,
      description: 'evening work',
      tags: ['night'],
      isFavorite: true,
      sort: 1,
    },
  ],
}

describe('round trip', () => {
  it('reads back what it wrote', () => {
    const parsed = parseColorBackup(buildColorBackup(backup))
    expect(parsed?.favorites).toEqual(backup.favorites)
    expect(parsed?.palettes).toEqual(backup.palettes)
    expect(parsed?.exportedAt).toBe('2026-11-01T00:00:00.000Z')
  })

  it('stamps the version and the moment', () => {
    const written = JSON.parse(buildColorBackup({ favorites: [], palettes: [], exportedAt: 'x' })) as {
      version: number
      exportedAt: string
    }
    expect(written.version).toBe(COLOR_BACKUP_VERSION)
    expect(written.exportedAt).toBe('x')
  })
})

describe('what is not a backup', () => {
  it('refuses junk, a foreign shape and a stale version', () => {
    expect(parseColorBackup('not json')).toBeNull()
    expect(parseColorBackup('[]')).toBeNull()
    expect(parseColorBackup(JSON.stringify({ hello: 'world' }))).toBeNull()
    expect(parseColorBackup(JSON.stringify({ ...backup, version: COLOR_BACKUP_VERSION + 1 }))).toBeNull()
  })

  it('refuses a row missing the colour', () => {
    const missing = JSON.parse(buildColorBackup(backup)) as { favorites: Array<Record<string, unknown>> }
    delete missing.favorites[0]!.hex
    expect(parseColorBackup(JSON.stringify(missing))).toBeNull()
  })

  it('refuses more rows than a page of each collection', () => {
    const rows = Array.from({ length: COLOR_BACKUP_MAX_ROWS + 1 }, (_, index) => ({
      id: `fav_${String(index).padStart(4, '0')}`,
      hex: '#22aa33',
      name: '',
      tags: [],
      note: '',
      sort: index,
    }))
    expect(parseColorBackup(JSON.stringify({ ...backup, favorites: rows }))).toBeNull()
  })

  it('refuses an empty palette and one over the saved-size ceiling', () => {
    const base = backup.palettes[0]!
    expect(parseColorBackup(JSON.stringify({ ...backup, palettes: [{ ...base, colors: [] }] }))).toBeNull()
    const tooMany = Array.from({ length: COLOR_PALETTE_MAX_COLORS + 1 }, () => ({ hex: '#22aa33' }))
    expect(
      parseColorBackup(JSON.stringify({ ...backup, palettes: [{ ...base, colors: tooMany }] })),
    ).toBeNull()
  })

  it('keeps the ceiling aligned with what the lists can load', () => {
    // A backup that could hold more rows than a list read returns would silently lose them on restore.
    expect(COLOR_BACKUP_MAX_ROWS).toBe(COLOR_LIST_LIMIT)
  })
})
