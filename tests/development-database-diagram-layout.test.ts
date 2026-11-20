import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiagramPositions } from '../src/client/features/development/database/diagram'
import {
  diagramLayoutStorageKey,
  loadDiagramPositions,
  MAX_DIAGRAM_POSITIONS,
  pruneDiagramPositions,
  saveDiagramPositions,
  type DiagramLayoutStore,
} from '../src/client/features/development/database/diagram-layout'

class MemoryStorage implements DiagramLayoutStore {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

function positions(count: number): DiagramPositions {
  const result: DiagramPositions = {}
  for (let index = 0; index < count; index += 1) {
    result[`table_${index}`] = { x: index, y: index }
  }
  return result
}

describe('diagramLayoutStorageKey', () => {
  it('namespaces the connection key', () => {
    expect(diagramLayoutStorageKey('local.db')).toBe('inkstone.development.database.diagram.v1.local.db')
  })

  it('replaces illegal characters and trims', () => {
    expect(diagramLayoutStorageKey('  my conn/one  ')).toBe(
      'inkstone.development.database.diagram.v1.my_conn_one',
    )
  })

  it('truncates the connection key to 120 characters', () => {
    expect(diagramLayoutStorageKey('x'.repeat(500))).toBe(
      `inkstone.development.database.diagram.v1.${'x'.repeat(120)}`,
    )
  })

  it('falls back when the connection key is blank', () => {
    expect(diagramLayoutStorageKey('   ')).toBe('inkstone.development.database.diagram.v1.default')
  })
})

describe('loadDiagramPositions', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('round-trips saved positions', () => {
    const storage = new MemoryStorage()
    saveDiagramPositions('local', { users: { x: 10, y: 20 } }, storage)
    expect(loadDiagramPositions('local', storage)).toEqual({ users: { x: 10, y: 20 } })
  })

  it('keeps each connection separate', () => {
    const storage = new MemoryStorage()
    saveDiagramPositions('one', { users: { x: 1, y: 2 } }, storage)
    saveDiagramPositions('two', { users: { x: 3, y: 4 } }, storage)
    expect(loadDiagramPositions('one', storage)).toEqual({ users: { x: 1, y: 2 } })
    expect(loadDiagramPositions('two', storage)).toEqual({ users: { x: 3, y: 4 } })
  })

  it('returns an empty map when nothing is stored', () => {
    expect(loadDiagramPositions('local', new MemoryStorage())).toEqual({})
  })

  it('returns an empty map for malformed JSON', () => {
    const storage = new MemoryStorage()
    storage.setItem(diagramLayoutStorageKey('local'), '{not json')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(loadDiagramPositions('local', storage)).toEqual({})
  })

  it('returns an empty map for non-object payloads', () => {
    const storage = new MemoryStorage()
    for (const raw of ['null', '42', '"text"', '[]']) {
      storage.setItem(diagramLayoutStorageKey('local'), raw)
      expect(loadDiagramPositions('local', storage)).toEqual({})
    }
  })

  it('drops entries without finite coordinates', () => {
    const storage = new MemoryStorage()
    storage.setItem(
      diagramLayoutStorageKey('local'),
      JSON.stringify({
        good: { x: 1, y: 2 },
        stringX: { x: '1', y: 2 },
        missingY: { x: 1 },
        nullEntry: null,
        arrayEntry: [1, 2],
        scalarEntry: 7,
      }),
    )
    expect(loadDiagramPositions('local', storage)).toEqual({ good: { x: 1, y: 2 } })
  })

  it('keeps at most the maximum number of positions', () => {
    const storage = new MemoryStorage()
    storage.setItem(diagramLayoutStorageKey('local'), JSON.stringify(positions(MAX_DIAGRAM_POSITIONS + 100)))
    const loaded = loadDiagramPositions('local', storage)
    expect(Object.keys(loaded)).toHaveLength(MAX_DIAGRAM_POSITIONS)
    expect(loaded.table_0).toEqual({ x: 0, y: 0 })
    expect(loaded.table_500).toBeUndefined()
  })

  it('survives a storage that throws on read', () => {
    const storage: DiagramLayoutStore = {
      getItem: () => {
        throw new Error('unavailable')
      },
      setItem: () => {},
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(loadDiagramPositions('local', storage)).toEqual({})
  })
})

describe('saveDiagramPositions', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes only finite coordinates', () => {
    const storage = new MemoryStorage()
    saveDiagramPositions(
      'local',
      {
        good: { x: 1, y: 2 },
        badX: { x: Number.NaN, y: 0 },
        badY: { x: 0, y: Number.POSITIVE_INFINITY },
      },
      storage,
    )
    expect(loadDiagramPositions('local', storage)).toEqual({ good: { x: 1, y: 2 } })
  })

  it('truncates saved positions to the maximum', () => {
    const storage = new MemoryStorage()
    saveDiagramPositions('local', positions(MAX_DIAGRAM_POSITIONS + 100), storage)
    const raw = storage.getItem(diagramLayoutStorageKey('local')) ?? '{}'
    expect(Object.keys(JSON.parse(raw) as DiagramPositions)).toHaveLength(MAX_DIAGRAM_POSITIONS)
  })

  it('warns instead of throwing when storage rejects the write', () => {
    const storage: DiagramLayoutStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded')
      },
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => saveDiagramPositions('local', { users: { x: 1, y: 1 } }, storage)).not.toThrow()
    expect(warn).toHaveBeenCalledWith(
      '[inkstone] Development database diagram positions could not be saved:',
      expect.any(Error),
    )
  })
})

describe('pruneDiagramPositions', () => {
  it('keeps only names that still exist', () => {
    const stored: DiagramPositions = {
      users: { x: 1, y: 2 },
      legacy: { x: 3, y: 4 },
    }
    expect(pruneDiagramPositions(stored, ['users', 'orders'])).toEqual({ users: { x: 1, y: 2 } })
  })

  it('does not mutate its input', () => {
    const stored: DiagramPositions = {
      users: { x: 1, y: 2 },
      legacy: { x: 3, y: 4 },
    }
    pruneDiagramPositions(stored, ['users'])
    expect(stored).toEqual({ users: { x: 1, y: 2 }, legacy: { x: 3, y: 4 } })
  })
})