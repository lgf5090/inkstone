import { useCallback, useSyncExternalStore } from 'react'

export const MEMO_DOMAINS = [
  'list',
  'detail',
  'stats',
  'attachments',
  'spaces',
  'views',
  'shares',
  'preferences',
  'tokens',
  'webhooks',
] as const

export type MemoDomain = (typeof MEMO_DOMAINS)[number]

const revisions: Record<MemoDomain, number> = {
  list: 0,
  detail: 0,
  stats: 0,
  attachments: 0,
  spaces: 0,
  views: 0,
  shares: 0,
  preferences: 0,
  tokens: 0,
  webhooks: 0,
}

const listeners = new Map<MemoDomain, Set<() => void>>()

export function isMemoDomain(value: unknown): value is MemoDomain {
  return typeof value === 'string' && (MEMO_DOMAINS as readonly string[]).includes(value)
}

export function revisionOf(domain: MemoDomain): number {
  return revisions[domain]
}

export function bump(domain: MemoDomain): void {
  revisions[domain] += 1
  const subscribers = listeners.get(domain)
  if (!subscribers) return
  for (const listener of [...subscribers]) listener()
}

export function subscribeRevision(domain: MemoDomain, listener: () => void): () => void {
  const subscribers = listeners.get(domain) ?? new Set<() => void>()
  listeners.set(domain, subscribers)
  subscribers.add(listener)
  return () => {
    subscribers.delete(listener)
    if (subscribers.size === 0) listeners.delete(domain)
  }
}

export function useRevision(domain: MemoDomain): number {
  const subscribe = useCallback(
    (listener: () => void) => subscribeRevision(domain, listener),
    [domain],
  )
  return useSyncExternalStore(
    subscribe,
    () => revisions[domain],
    () => revisions[domain],
  )
}
