/**
 * Whether this account is watching one block, and the toggle that changes it.
 *
 * The reminder sweep and the comment notifications both read the subscription rows, so a board with
 * no watchers is a board whose notifications nobody receives. The list is read once per mount and
 * the toggle writes through it, rather than each caller keeping its own copy of the same roster.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectSubscription, ProjectSubscriptionBlock } from '@shared/project/model'
import { useUi } from '../../store/ui'
import { useSession } from '../../store/session'
import { fetchProjectSubscriptions, unwatchProjectBlock, watchProjectBlock } from './api'

// The board page and the card dialog ask the same question within seconds of each other; the roster
// is one read until a toggle makes it stale.
let cachedSubscriptions = new Map<string, ProjectSubscription[]>()

export function resetProjectSubscriptionCache(): void {
  cachedSubscriptions.clear()
}

export function useProjectWatch(blockType: ProjectSubscriptionBlock, blockId: string): { watching: boolean, status: 'loading' | 'ready' | 'error', toggle: () => Promise<void>, retry: () => void } {
  const [watching, setWatching] = useState(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const toast = useUi((state) => state.toast)
  const userId = useSession((state) => state.user?.id)
  const accountRef = useRef(userId)
  accountRef.current = userId
  const blockRef = useRef({ blockType, blockId })
  blockRef.current = { blockType, blockId }

  useEffect(() => {
    setStatus('loading')
    setWatching(false)
    if (!userId) { setStatus('ready'); return }
    const cached = cachedSubscriptions.get(userId)
    if (cached) {
      setWatching(cached.some((entry) => entry.blockId === blockId))
      setStatus('ready')
      return
    }
    const controller = new AbortController()
    fetchProjectSubscriptions(controller.signal)
      .then((list) => {
        if (accountRef.current !== userId) return
        cachedSubscriptions.set(userId, list)
        setWatching(list.some((entry) => entry.blockId === blockId))
        setStatus('ready')
      })
      .catch(() => { if (!controller.signal.aborted && accountRef.current === userId) setStatus('error') })
    return () => controller.abort()
  }, [blockId, userId, attempt])

  const toggle = useCallback(async () => {
    if (busy || !userId || status !== 'ready') return
    setBusy(true)
    const next = !watching
    setWatching(next)
    try {
      if (next) await watchProjectBlock(blockType, blockId)
      else await unwatchProjectBlock(blockId)
      cachedSubscriptions.delete(userId)
    } catch (reason) {
      if (accountRef.current === userId && blockRef.current.blockType === blockType && blockRef.current.blockId === blockId) setWatching(!next)
      toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }, [blockType, blockId, watching, busy, status, toast, userId])

  const retry = useCallback(() => setAttempt((current) => current + 1), [])
  return { watching, status, toggle, retry }
}