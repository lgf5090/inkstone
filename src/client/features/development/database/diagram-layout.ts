import type { DiagramPosition, DiagramPositions } from './diagram'

export interface DiagramLayoutStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const STORAGE_PREFIX = 'inkstone.development.database.diagram.v1'

const CONNECTION_KEY_MAX_LENGTH = 120

const FALLBACK_CONNECTION_KEY = 'default'

export const MAX_DIAGRAM_POSITIONS = 500

function defaultStorage(): DiagramLayoutStore | null {
  return typeof localStorage !== 'undefined' ? localStorage : null
}

function sanitizeConnectionKey(connectionKey: string): string {
  const sanitized = connectionKey
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, '_')
    .slice(0, CONNECTION_KEY_MAX_LENGTH)
  return sanitized || FALLBACK_CONNECTION_KEY
}

export function diagramLayoutStorageKey(connectionKey: string): string {
  return `${STORAGE_PREFIX}.${sanitizeConnectionKey(connectionKey)}`
}

function readPosition(value: unknown): DiagramPosition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { x, y } = value as { x?: unknown; y?: unknown }
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    return null
  }
  return { x, y }
}

function collectPositions(source: object): DiagramPositions {
  const positions: DiagramPositions = {}
  let count = 0
  for (const [name, value] of Object.entries(source)) {
    if (count >= MAX_DIAGRAM_POSITIONS) break
    if (name === '__proto__') continue
    const position = readPosition(value)
    if (!position) continue
    positions[name] = position
    count += 1
  }
  return positions
}

export function loadDiagramPositions(
  connectionKey: string,
  storage?: DiagramLayoutStore,
): DiagramPositions {
  const target = storage ?? defaultStorage()
  if (!target) return {}
  try {
    const raw = target.getItem(diagramLayoutStorageKey(connectionKey))
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return collectPositions(parsed)
  } catch (error) {
    console.warn('[inkstone] Development database diagram positions could not be read:', error)
    return {}
  }
}

export function saveDiagramPositions(
  connectionKey: string,
  positions: DiagramPositions,
  storage?: DiagramLayoutStore,
): void {
  const target = storage ?? defaultStorage()
  if (!target) return
  try {
    target.setItem(
      diagramLayoutStorageKey(connectionKey),
      JSON.stringify(collectPositions(positions)),
    )
  } catch (error) {
    console.warn('[inkstone] Development database diagram positions could not be saved:', error)
  }
}

export function pruneDiagramPositions(
  positions: DiagramPositions,
  tableNames: readonly string[],
): DiagramPositions {
  const keep = new Set(tableNames)
  const pruned: DiagramPositions = {}
  for (const [name, position] of Object.entries(positions)) {
    if (name === '__proto__' || !keep.has(name)) continue
    pruned[name] = position
  }
  return pruned
}