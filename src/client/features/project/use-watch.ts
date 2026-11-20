/**
 * Whether this account is watching one block, and the toggle that changes it.
 *
 * The reminder sweep and the comment notifications both read the subscription rows, so a board with
 * no watchers is a board whose notifications nobody receives. The list is read once per mount and
 * the toggle writes through it, rather than each caller keeping its own copy of the same roster.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ProjectSubscription, ProjectSubscriptionBlock } from '@shared/project/model'
import { useUi } from '../../store/ui'
import { fetchProjectSubscriptions, unwatchProjectBlock, watchProjectBlock } from './api'

// The board page and the card dialog ask the same question within seconds of each other; the roster
// is one read until a toggle makes it stale.
let cachedSubscriptions: ProjectSubscription[] | null = null

export function resetProjectSubscriptionCache(): void {
  cachedSubscriptions = null
}

export function useProjectWatch(blockType: ProjectSubscriptionBlock, blockId: string): { watching: boolean, toggle: () => Promise<void> } {
  const [watching, setWatching] = useState(false)
  const [busy, setBusy] = useState(false)
  const toast = useUi((state) => state.toast)

  useEffect(() => {
    if (cachedSubscriptions) {
      setWatching(cachedSubscriptions.some((entry) => entry.blockId === blockId))
      return
    }
    const controller = new AbortController()
    fetchProjectSubscriptions(controller.signal)
      .then((list) => {
        cachedSubscriptions = list
        setWatching(list.some((entry) => entry.blockId === blockId))
      })
      .catch(() => { if (!controller.signal.aborted) setWatching(false) })
    return () => controller.abort()
  }, [blockId])

  const toggle = useCallback(async () => {
    if (busy) return
    setBusy(true)
    const next = !watching
    setWatching(next)
    try {
      if (next) await watchProjectBlock(blockType, blockId)
      else await unwatchProjectBlock(blockId)
      cachedSubscriptions = null
    } catch (reason) {
      setWatching(!next)
      toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }, [blockType, blockId, watching, busy, toast])

  return { watching, toggle }
}