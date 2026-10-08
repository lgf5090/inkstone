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
import {
  attachQuickAddPromptHost,
  currentPromptGroup,
  resetQuickAddPrompts,
  subscribeQuickAddPrompts,
} from './prompt-queue'

function PromptChunkMissing(): null {
  useEffect(resetQuickAddPrompts, [])
  return null
}

const QuickAddPromptHost = lazy(() => import('./prompts')
  .then((module) => ({ default: module.QuickAddPromptHost }))
  .catch(() => ({ default: PromptChunkMissing })))

export function QuickAddPromptGate() {
  const group = useSyncExternalStore(subscribeQuickAddPrompts, currentPromptGroup)
  // The gate, not the dialog, is what stands for “a host is coming”: the chunk is still fetching
  // while the first prompt is already outstanding, and releasing the run in that gap would answer
  // it with nothing before the reader had a chance to be asked.
  useEffect(attachQuickAddPromptHost, [])
  if (!group) return null
  return (
    <Suspense fallback={null}>
      <QuickAddPromptHost />
    </Suspense>
  )
}
