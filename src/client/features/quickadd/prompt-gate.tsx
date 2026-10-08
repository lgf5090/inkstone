/**
 * Mounts the QuickAdd prompt dialogs on demand.
 *
 * A prompt is the only part of a choice run that needs form controls, and it is needed by nobody who
 * never runs a choice, so the dialogs are fetched when the first prompt arrives rather than at boot.
 * The gate subscribes to the same queue the engine pushes into, which keeps the promise contract
 * honest: if the chunk cannot be fetched, the outstanding run is released with no answer instead of
 * waiting forever for a dialog that will never be rendered.
 */
import { lazy, Suspense, useEffect, useSyncExternalStore } from 'react'
import { currentPromptGroup, resetQuickAddPrompts, subscribeQuickAddPrompts } from './prompt-queue'

function PromptChunkMissing(): null {
  useEffect(resetQuickAddPrompts, [])
  return null
}

const QuickAddPromptHost = lazy(() => import('./prompts')
  .then((module) => ({ default: module.QuickAddPromptHost }))
  .catch(() => ({ default: PromptChunkMissing })))

export function QuickAddPromptGate() {
  const group = useSyncExternalStore(subscribeQuickAddPrompts, currentPromptGroup)
  if (!group) return null
  return (
    <Suspense fallback={null}>
      <QuickAddPromptHost />
    </Suspense>
  )
}
