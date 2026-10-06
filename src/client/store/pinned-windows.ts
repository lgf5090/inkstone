import { create } from 'zustand'
import { PINNED_WINDOWS_STORAGE_KEY } from '../lib/runtime'
import type { WikiLinkHoverCardState } from '../types/hover-card'

export interface PersistedPinnedWindow {
  id: number
  noteId: string | null
  title: string
  missing: boolean
  headline?: string
  x: number
  y: number
  width: number
  height: number
  z: number
}

export interface PinnedWindowGeometry {
  x: number
  y: number
  width: number
  height: number
}

interface PinnedWindowsState {
  items: PersistedPinnedWindow[]
  seq: number
  flashId: number | null
  pin: (card: WikiLinkHoverCardState, rect: DOMRect) => void
  close: (id: number) => void
  closeAll: () => void
  closeFront: () => void
  bringToFront: (id: number) => void
  updateGeometry: (id: number, geometry: PinnedWindowGeometry) => void
  flash: (id: number) => void
  focusPinnedByNote: (noteId: string) => boolean
}

const MAX_PINNED_WINDOWS = 12

export function loadPersisted(): { items: PersistedPinnedWindow[], seq: number } {
  try {
    const raw = localStorage.getItem(PINNED_WINDOWS_STORAGE_KEY)
    if (!raw) return { items: [], seq: 1 }
    return decodePersisted(JSON.parse(raw) as unknown)
  } catch {
    return { items: [], seq: 1 }
  }
}

function decodePersisted(value: unknown): { items: PersistedPinnedWindow[], seq: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { items: [], seq: 1 }
  const record = value as Record<string, unknown>
  const items = Array.isArray(record.items) ? record.items : []
  const stored = items
    .filter(isPinnedWindow)
    .slice(0, MAX_PINNED_WINDOWS)
    .map((item) => ({ ...item }))
  const seq = isFiniteNumber(record.seq)
    ? record.seq
    : stored.reduce((max, item) => Math.max(max, item.id), 0) + 1
  return { items: stored, seq: Math.max(1, seq) }
}

function isPinnedWindow(value: unknown): value is PersistedPinnedWindow {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return (
    isFiniteNumber(item.id) &&
    (item.noteId === null || typeof item.noteId === 'string') &&
    typeof item.title === 'string' &&
    typeof item.missing === 'boolean' &&
    isFiniteNumber(item.x) &&
    isFiniteNumber(item.y) &&
    isFiniteNumber(item.width) &&
    isFiniteNumber(item.height) &&
    isFiniteNumber(item.z)
  )
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function maxZ(items: PersistedPinnedWindow[]): number {
  return items.reduce((max, item) => Math.max(max, item.z), 0)
}

function pushPinnedWindow(
  state: PinnedWindowsState,
  card: WikiLinkHoverCardState,
  rect: DOMRect,
): Partial<PinnedWindowsState> {
  if (state.items.length >= MAX_PINNED_WINDOWS) return state
  return {
    seq: state.seq + 1,
    items: [...state.items, {
      id: state.seq,
      noteId: card.noteId,
      title: card.title,
      missing: card.missing,
      headline: card.headline,
      x: rect.left,
      y: rect.top,
      width: rect.width || 340,
      height: rect.height || 0,
      z: maxZ(state.items) + 1,
    }],
  }
}

let persistTimer: number | undefined
let lastPersisted = ''
let flashTimer: number | undefined

function persist(state: PinnedWindowsState): void {
  const serialized = JSON.stringify({ items: state.items, seq: state.seq })
  if (serialized === lastPersisted) return
  window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(PINNED_WINDOWS_STORAGE_KEY, serialized)
      lastPersisted = serialized
    } catch {
    }
  }, 220)
}

const loaded = loadPersisted()

export const usePinnedWindows = create<PinnedWindowsState>((set, get) => ({
  items: loaded.items,
  seq: loaded.seq,
  flashId: null,

  pin: (card, rect) => set((state) => pushPinnedWindow(state, card, rect)),

  close: (id) => set((state) => ({ items: state.items.filter((item) => item.id !== id) })),

  closeAll: () => set({ items: [] }),

  closeFront: () => set((state) => {
    const front = state.items.reduce<PersistedPinnedWindow | null>((top, item) => !top || item.z > top.z ? item : top, null)
    return front ? { items: state.items.filter((item) => item.id !== front.id) } : state
  }),

  bringToFront: (id) => set((state) => ({
    items: state.items.map((item) => item.id === id ? { ...item, z: maxZ(state.items) + 1 } : item),
  })),

  updateGeometry: (id, geometry) => set((state) => ({
    items: state.items.map((item) => item.id === id ? { ...item, ...geometry } : item),
  })),

  flash: (id) => {
    window.clearTimeout(flashTimer)
    set((state) => ({
      flashId: id,
      items: state.items.map((item) => item.id === id ? { ...item, z: maxZ(state.items) + 1 } : item),
    }))
    flashTimer = window.setTimeout(() => set({ flashId: null }), 1100)
  },

  focusPinnedByNote: (noteId) => {
    const state = get()
    const item = state.items.find((candidate) => candidate.noteId === noteId)
    if (!item) return false
    state.flash(item.id)
    return true
  },
}))

usePinnedWindows.subscribe(persist)
