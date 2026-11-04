/**
 * The line diff for a large pair of files, off the main thread.
 *
 * `@codemirror/merge` renders through a viewport, but the comparison itself is a synchronous
 * algorithm; on a megabyte-sized pair it is the one step that can freeze the tab. Above the
 * threshold in `TEXT_LIMITS` the diff runs here, and the screen shows a computing state until it
 * answers.
 */
import { computeTextDiff } from '@shared/tools/compare/engine'
import type { TextCompareOptions } from '@shared/tools/compare/types'

interface DiffRequest {
  left: string
  right: string
  options: TextCompareOptions
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<DiffRequest>) => void) | null
  postMessage: (message: unknown) => void
}

scope.onmessage = (event: MessageEvent<DiffRequest>) => {
  try {
    const result = computeTextDiff(event.data.left, event.data.right, event.data.options)
    scope.postMessage({ ok: true, result })
  } catch (error) {
    scope.postMessage({ ok: false, error: error instanceof Error ? error.message : 'diff-failed' })
  }
}
