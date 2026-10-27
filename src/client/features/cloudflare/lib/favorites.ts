/**
 * Template favourites, kept on this device.
 *
 * A favourite is a bookmark in the store, not data the server has any use for; keeping it in
 * localStorage means starring a template costs nothing and survives a reload. The store is small
 * (ids only), and a malformed entry is dropped rather than breaking every screen that asks.
 */
import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'inkstone:cloudflare:favorites'
const listeners = new Set<() => void>()
let ids: Set<string> = load()

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids].sort()))
  } catch {
    // A full quota leaves the in-memory set correct for this tab; the next write may succeed.
  }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function isFavorite(id: string): boolean {
  return ids.has(id)
}

export function toggleFavorite(id: string): boolean {
  if (ids.has(id)) ids.delete(id)
  else ids.add(id)
  persist()
  return ids.has(id)
}

export function useFavorite(id: string): [boolean, () => void] {
  const value = useSyncExternalStore(subscribe, () => (ids.has(id) ? 1 : 0), () => (ids.has(id) ? 1 : 0))
  return [value === 1, () => { toggleFavorite(id) }]
}

export function useFavoriteCount(): number {
  return useSyncExternalStore(subscribe, () => ids.size, () => ids.size)
}

export function favoriteIds(): string[] {
  return [...ids]
}
