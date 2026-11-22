/**
 * The editor's save loop, per §8.5 of the office plan: a command mutation arms a 1.2 s debounce, the
 * timer writes the snapshot once, an unchanged body is skipped by its sha256, and a `409` becomes a
 * question for the reader instead of a silent overwrite.
 *
 * One save runs at a time. A timer that fires mid-save, a tab switch and an explicit `flush()` all join
 * the same chain, so two revisions can never race each other, and a command that lands while a save is
 * in flight bumps a generation counter so the completion cannot mark the newer edit as saved.
 */
import { OFFICE_LIMITS } from '@shared/office/constants'
import type { OfficeSnapshot } from '@shared/office/model'
import { sha256Hex } from '@shared/office/snapshot'
import { ApiError } from '../../../lib/api'
import { t } from '../../../lib/i18n'
import { uploadInlineOfficeImages } from './assets'
import { fetchOfficeFileRev, saveOfficeSnapshot } from './office-api'

export type OfficeSaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'failed' | 'conflict'

export interface OfficeAutosaveOptions {
  fileId: string
  /** The revision the editor loaded; every save is conditional on it. */
  baseRev: number
  /** The snapshot the editor loaded, used only to prime the hash so opening a file is not a write. */
  initialSnapshot?: OfficeSnapshot | null
  /** Reads the current model. Called on the save's own turn, so it never races a dispose. */
  readSnapshot: () => OfficeSnapshot
  /** Fires on every content mutation that reaches the snapshot. */
  subscribe: (listener: () => void) => () => void
  onStateChange?: (state: OfficeSaveState) => void
  onConflict: (currentRev: number) => void
  /** A save that failed for a reason other than a revision conflict. */
  onFailure?: (message: string) => void
  /** Inline images the last save could not store; they stay data URLs in the saved snapshot. */
  onAssetFailure?: (failed: number) => void
  delayMs?: number
}

export interface OfficeAutosave {
  markDirty(): void
  /**
   * Writes the snapshot now. `force` skips the hash comparison and the conflict guard — it is what
   * "overwrite" means after the reader chose it.
   */
  flush(options?: { force?: boolean }): Promise<void>
  state(): OfficeSaveState
  baseRev(): number
  /** A failed save, retried on the reader's request. A conflict is not retried from here. */
  retry(): void
  /** After the reader chose overwrite: adopt the newer revision and write immediately. */
  overwrite(currentRev: number): void
  dispose(): void
}

function conflictRev(error: ApiError): number | null {
  const details = error.details
  if (!details || typeof details !== 'object') return null
  const value = (details as Record<string, unknown>).currentRev
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function createOfficeAutosave(options: OfficeAutosaveOptions): OfficeAutosave {
  const delay = options.delayMs ?? OFFICE_LIMITS.autosaveDelayMs
  /** The data-URL-to-URL table this editor has already uploaded; the model keeps its data URLs. */
  const assetCache = new Map<string, string>()

  let state: OfficeSaveState = 'clean'
  let dirty = false
  let disposed = false
  let timer: number | undefined
  let baseRev = options.baseRev
  let generation = 0
  let lastHash: string | null = null
  /** Resolves once the loaded snapshot's hash is known; until then the first save always writes. */
  let primed: Promise<void> | null = null
  /** Serializes attempts. Always resolves: a failed attempt is recorded, not rethrown into the chain. */
  let chain: Promise<void> = Promise.resolve()
  /** The in-flight attempt as its caller sees it, so a second `flush()` joins the same outcome. */
  let inFlight: Promise<void> | null = null

  const unsubscribe = options.subscribe(() => {
    markDirty()
  })

  if (options.initialSnapshot) {
    primed = sha256Hex(JSON.stringify(options.initialSnapshot))
      .then((hash) => {
        if (lastHash === null) lastHash = hash
      })
      .catch(() => {
        // A platform without `crypto.subtle` cannot skip by hash. Saving once more is the safe failure.
      })
  }

  function setState(next: OfficeSaveState): void {
    if (state === next) return
    state = next
    options.onStateChange?.(next)
  }

  function clearTimer(): void {
    if (timer === undefined) return
    window.clearTimeout(timer)
    timer = undefined
  }

  function schedule(): void {
    if (disposed || state === 'conflict') return
    clearTimer()
    timer = window.setTimeout(() => {
      timer = undefined
      // A background save reports through the save state and the conflict callback; there is no
      // caller above it to receive the rejection.
      void flush().catch(() => {})
    }, delay)
  }

  function markDirty(): void {
    if (disposed) return
    generation += 1
    dirty = true
    if (state !== 'conflict') setState('dirty')
    schedule()
  }

  function handleFailure(error: unknown): void {
    dirty = true
    if (error instanceof ApiError && error.isConflict) {
      setState('conflict')
      const known = conflictRev(error)
      if (known !== null) {
        options.onConflict(known)
        return
      }
      // The route documents `currentRev` beside the code; a deployment that omits it gets one read
      // rather than a dialog that cannot name the revision it is about.
      void fetchOfficeFileRev(options.fileId)
        .then((rev) => options.onConflict(rev))
        .catch(() => options.onConflict(-1))
      return
    }
    setState('failed')
    options.onFailure?.(error instanceof Error ? error.message : t('office.save.failed'))
  }

  async function performSave(force: boolean): Promise<void> {
    if (primed) await primed
    const startedAt = generation
    const snapshot = options.readSnapshot()
    const hash = await sha256Hex(JSON.stringify(snapshot))

    if (!force && hash === lastHash) {
      if (generation === startedAt) {
        dirty = false
        setState('saved')
      }
      return
    }

    const upload = await uploadInlineOfficeImages(snapshot, { known: assetCache })
    for (const [dataUrl, url] of upload.mapping) assetCache.set(dataUrl, url)

    const result = await saveOfficeSnapshot(options.fileId, { baseRev, snapshot: upload.snapshot })
    baseRev = result.rev
    lastHash = hash
    if (generation === startedAt) {
      dirty = false
      setState('saved')
    } else {
      // The reader typed while this snapshot was uploading; that edit is not in what was written.
      setState('dirty')
    }
    if (upload.failed > 0) options.onAssetFailure?.(upload.failed)
  }

  function flush(flushOptions: { force?: boolean } = {}): Promise<void> {
    const force = flushOptions.force === true
    if (disposed) return Promise.resolve()
    if (inFlight) return inFlight
    if (!dirty && !force) return chain
    if (state === 'conflict' && !force) {
      return Promise.reject(new Error(t('office.conflict.description')))
    }

    clearTimer()
    setState('saving')
    const attempt = chain.then(() => performSave(force))
    // Keep the internal chain resolved: the caller sees the rejection, the next retry still runs.
    chain = attempt.then(
      () => {},
      (error: unknown) => {
        handleFailure(error)
      },
    )
    const settled = attempt.finally(() => {
      inFlight = null
      if (dirty && state !== 'conflict' && !disposed) schedule()
    })
    inFlight = settled
    return settled
  }

  return {
    markDirty,
    flush,
    state: () => state,
    baseRev: () => baseRev,
    retry() {
      if (disposed || state === 'conflict') return
      dirty = true
      setState('dirty')
      // The reader asked; a failure is reported again through `onFailure`.
      void flush().catch(() => {})
    },
    overwrite(currentRev: number) {
      if (disposed) return
      baseRev = currentRev
      dirty = true
      setState('dirty')
      // The reader chose to replace the newer revision; a second 409 is still reported.
      void flush({ force: true }).catch(() => {})
    },
    dispose() {
      if (disposed) return
      disposed = true
      clearTimer()
      unsubscribe()
    },
  }
}