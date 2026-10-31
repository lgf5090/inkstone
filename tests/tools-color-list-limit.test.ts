// @vitest-environment node
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { COLOR_LIST_LIMIT } from '@shared/tools/color/contract'
import { TOOLS_COLOR_SCHEMA_STATEMENTS } from '../src/worker/tools/color/schema'
import { ColorStore } from '../src/worker/tools/color/store'
import { makeD1 } from './doubles/d1-sqlite'

/**
 * The two collection lists the panel reads on every mount.
 *
 * `listFavorites` and `listPalettes` were `SELECT *` with no ceiling: a long-lived account handed the
 * browser its whole saved-colour history, including the 50 KB `preview_svg` column that no list view
 * renders, and the tag filter ran after that transfer in JavaScript.
 */

const USER = 'user-alice'

let sqlite: DatabaseSync
let store: ColorStore
/** The rows each list query actually pulled out of the database, by table. */
let readColumns: { table: string; columns: string[] }[]

function spyingSqlite(db: DatabaseSync): DatabaseSync {
  return new Proxy(db, {
    get(target, property) {
      if (property !== 'prepare') {
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
      }
      return (sql: string) => {
        const statement = target.prepare(sql)
        const table = /tools_color_favorites/.test(sql) ? 'favorites' : /tools_color_palettes/.test(sql) ? 'palettes' : ''
        return new Proxy(statement, {
          get(inner, key) {
            const value = Reflect.get(inner, key, inner)
            if (key !== 'all' || !table || !/^\s*select/i.test(sql)) {
              return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(inner) : value
            }
            return (...args: unknown[]) => {
              const rows = (value as (...a: unknown[]) => object[]).apply(inner, args)
              const first = rows[0] as Record<string, unknown> | undefined
              readColumns.push({ table, columns: first ? Object.keys(first) : [] })
              return rows
            }
          },
        }) as StatementSync
      }
    },
  })
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of TOOLS_COLOR_SCHEMA_STATEMENTS) sqlite.exec(statement)
  readColumns = []
  store = new ColorStore(makeD1(spyingSqlite(sqlite)), USER)
})

/** Which columns a list query read for its first row. */
function columnsRead(table: 'favorites' | 'palettes'): string[] {
  const read = readColumns.find((entry) => entry.table === table)
  if (!read) throw new Error(`no ${table} list SELECT was issued`)
  return read.columns
}

describe('favorites list', () => {
  async function seedFavorites(count: number, userId = USER): Promise<void> {
    const other = new ColorStore(makeD1(sqlite), userId)
    for (let index = 0; index < count; index++) {
      await other.createFavorite({
        id: `fav_${index}`,
        hex: `#${index.toString(16).padStart(6, '0')}`,
        name: `Colour ${index}`,
        tags: ['seed'],
        note: `note ${index}`,
      })
    }
  }

  it('returns at most the shared page size', async () => {
    await seedFavorites(COLOR_LIST_LIMIT + 50)
    const list = await store.listFavorites()
    expect(list).toHaveLength(COLOR_LIST_LIMIT)
  })

  it('reads the owner id only where the row is filtered by it', async () => {
    await seedFavorites(1)
    await store.listFavorites()
    // `user_id` was carried into every row of the response only to be dropped again in the mapping.
    expect(columnsRead('favorites')).not.toContain('user_id')
  })

  it('keeps every field the panel renders after dropping the columns it does not read', async () => {
    await seedFavorites(3)
    const list = await store.listFavorites()
    expect(list).toHaveLength(3)
    // Newest first: the list is ordered by `sort`, then by the time each row was written.
    const first = list.find((favorite) => favorite.id === 'fav_0')
    expect(first).toMatchObject({
      id: 'fav_0',
      name: 'Colour 0',
      tags: ['seed'],
      note: 'note 0',
    })
    // The stored JSON blobs are decoded, not handed over raw.
    expect(first!.rgb).toMatchObject({ r: 0, g: 0, b: 0 })
    expect(first!.lab).toHaveProperty('l')
  })

  it('still answers the tag filter from the capped page', async () => {
    await seedFavorites(5)
    await store.createFavorite({ id: 'fav_odd', hex: '#123456', name: 'Odd', tags: ['odd-one'] })
    const filtered = await store.listFavorites('odd-one')
    expect(filtered.map((f) => f.id)).toEqual(['fav_odd'])
  })

  it('does not cross tenants', async () => {
    await seedFavorites(2)
    const otherStore = new ColorStore(makeD1(sqlite), 'user-carol')
    expect(await otherStore.listFavorites()).toHaveLength(0)
  })
})

describe('palette list', () => {
  async function seedPalettes(count: number): Promise<void> {
    for (let index = 0; index < count; index++) {
      await store.createPalette({
        id: `pal_${index}`,
        title: `Palette ${index}`,
        colors: [{ hex: '#112233', ratio: 1 }],
        previewSvg: `<svg xmlns="http://www.w3.org/2000/svg">${'x'.repeat(2000)}</svg>`,
      })
    }
  }

  it('returns at most the shared page size', async () => {
    await seedPalettes(COLOR_LIST_LIMIT + 50)
    const list = await store.listPalettes()
    expect(list).toHaveLength(COLOR_LIST_LIMIT)
  })

  it('leaves the 50 KB preview column in the table when listing', async () => {
    await seedPalettes(1)
    await store.listPalettes()
    expect(columnsRead('palettes')).not.toContain('preview_svg')
    expect(columnsRead('palettes')).not.toContain('user_id')
  })

  it('leaves the preview blob in the row instead of shipping it in a list', async () => {
    await seedPalettes(2)
    const list = await store.listPalettes()
    expect(list).toHaveLength(2)
    for (const palette of list) expect(palette.previewSvg).toBe('')

    // The column is unread by the list, not unread by the account: a single read still returns it.
    const single = await store.getPalette('pal_0')
    expect(single!.previewSvg).toContain('<svg')
  })

  it('keeps the fields the palette cards render', async () => {
    await store.createPalette({
      id: 'pal_1',
      title: 'Dusk',
      colors: [
        { hex: '#112233', ratio: 2 },
        { hex: '#445566' },
      ],
      description: 'evening',
      tags: ['night'],
      likesCount: 4,
      isFavorite: true,
    })
    const [palette] = await store.listPalettes()
    expect(palette).toMatchObject({
      id: 'pal_1',
      title: 'Dusk',
      description: 'evening',
      tags: ['night'],
      likesCount: 4,
      isFavorite: true,
      sourceType: 'custom',
    })
    expect(palette!.colors).toEqual([
      { hex: '#112233', ratio: 2 },
      { hex: '#445566' },
    ])
  })
})
