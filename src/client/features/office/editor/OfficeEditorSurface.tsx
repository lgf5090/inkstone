/**
 * The React half of every P1 editor: load the revision, mount the product's Univer instance, and keep
 * the reader's app theme, language and save failures visible without the shell having to know Univer.
 *
 * The three product modules differ only in the packages they load, so the loading/error/save chrome is
 * written once here. The one piece of state this file does not own is the editor tab: the shell decides
 * when an editor exists, and a remount is how a revision is reloaded.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { OfficeSnapshot } from '@shared/office/model'
import { t, useLocale } from '../../../lib/i18n'
import { useThemeDark } from '../../../lib/hooks'
import { useUi } from '../../../store/ui'
import { Button } from '../../../components/primitives'
import { ApiError } from '../../../lib/api'
import type { OfficeSaveState } from './autosave'
import type { OfficeEditorContext, OfficeEditorHandle, OfficeEditorProps } from './contracts'
import type { OfficeEditorInstance, OfficeEditorProduct } from './runtime'
import { mountOfficeEditor } from './runtime'
import { fetchOfficeFileRev, fetchOfficeSnapshot } from './office-api'
import { OfficeEditorPlaceholder } from './Placeholder'

export interface OfficeEditorSurfaceProps extends OfficeEditorProps {
  product: OfficeEditorProduct
  onDirtyChange?: (dirty: boolean) => void
  onSaveState?: (state: 'idle' | 'dirty' | 'saving' | 'saved' | 'failed') => void
}

interface Conflict {
  currentRev: number
}

type LoadStatus = 'loading' | 'ready' | 'failed'

/**
 * The stored revision, not the `snapshot` prop, decides what the editor opens when the shell has no
 * snapshot to hand over. With a snapshot, only the revision is read: the shell did the download, and a
 * second one would make a large file open twice as slowly.
 */
async function loadRevision(
  fileId: string,
  provided: OfficeSnapshot | null,
  signal: AbortSignal,
): Promise<{ snapshot: OfficeSnapshot | null; rev: number }> {
  if (provided) return { snapshot: provided, rev: await fetchOfficeFileRev(fileId, signal) }
  const loaded = await fetchOfficeSnapshot(fileId, signal)
  return { snapshot: loaded.snapshot, rev: loaded.rev }
}

export function OfficeEditorSurface(props: OfficeEditorSurfaceProps) {
  const { product, fileId, fileType, title, snapshot } = props
  const locale = useLocale()
  const dark = useThemeDark()
  const hostRef = useRef<HTMLDivElement>(null)
  const instanceRef = useRef<OfficeEditorInstance | null>(null)
  /** The next mount must read the server copy, because the conflict reload replaces the shell's. */
  const requireServerCopy = useRef(false)

  const [status, setStatus] = useState<LoadStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<OfficeSaveState>('clean')
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [attempt, setAttempt] = useState(0)

  // The mount effect owns one editor for one file; callbacks are read from here so a render that only
  // changes a parent handler does not tear the engine down.
  const callbacks = useRef({
    onReady: props.onReady,
    onContext: props.onContext,
    onError: props.onError,
    onDirtyChange: props.onDirtyChange,
    onSaveState: props.onSaveState,
  })
  callbacks.current = {
    onReady: props.onReady,
    onContext: props.onContext,
    onError: props.onError,
    onDirtyChange: props.onDirtyChange,
    onSaveState: props.onSaveState,
  }

  const localeRef = useRef(locale)
  const darkRef = useRef(dark)
  localeRef.current = locale
  darkRef.current = dark

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    const controller = new AbortController()
    setStatus('loading')
    setError(null)
    setConflict(null)

    const provided = requireServerCopy.current ? null : snapshot
    requireServerCopy.current = false

    void loadRevision(fileId, provided, controller.signal)
      .then((loaded) => {
        if (cancelled) return
        const instance = mountOfficeEditor({
          type: fileType,
          host,
          fileId,
          title,
          snapshot: loaded.snapshot,
          baseRev: loaded.rev,
          locale: localeRef.current,
          dark: darkRef.current,
          product,
          onReady: (handle: OfficeEditorHandle) => {
            if (cancelled) return
            setStatus('ready')
            callbacks.current.onReady?.(handle)
          },
          onContext: (context: OfficeEditorContext) => {
            if (!cancelled) callbacks.current.onContext?.(context)
          },
          onError: (message) => {
            if (cancelled) return
            setError(message)
            setStatus('failed')
          },
          onSaveState: (state) => {
            if (cancelled) return
            setSaveState(state)
            callbacks.current.onDirtyChange?.(state === 'dirty' || state === 'conflict')
            callbacks.current.onSaveState?.(
              state === 'clean' ? 'idle' : state === 'conflict' ? 'failed' : state,
            )
          },
          onConflict: (currentRev) => {
            if (!cancelled) setConflict({ currentRev })
          },
          onAssetFailure: (failed) => {
            if (!cancelled) useUi.getState().toast({ title: t('office.asset.upload_failed'), description: `×${failed}`, tone: 'warning' })
          },
        })
        instanceRef.current = instance
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        const message = cause instanceof ApiError || cause instanceof Error ? cause.message : t('office.editor.failed')
        setStatus('failed')
        setError(message)
        callbacks.current.onError?.(message)
      })

    return () => {
      cancelled = true
      controller.abort()
      const current = instanceRef.current
      instanceRef.current = null
      if (!current) return
      // The last edit has to reach the server before the model goes away. `flush()` captures the snapshot
      // synchronously and finishes over the network, so the dispose queued right after it cannot lose it.
      void current.flush().catch((cause: unknown) => {
        // The surface is already gone: a failed final save is reported by the next open, not by chrome
        // that no longer exists.
        console.warn('[office] final save failed', cause)
      })
      current.dispose()
    }
    // A new revision is a new editor: `attempt` is the remount for reload/retry. The snapshot and title
    // props are read once, on purpose — a parent re-render that recreates either object must not throw
    // away the reader's editing session; a changed revision arrives as a new `fileId` or an `attempt`.
  }, [fileId, fileType, product, attempt])

  // Theme and language are live: Univer repaints in place rather than losing the reader's selection.
  useEffect(() => {
    instanceRef.current?.setLocale(locale)
  }, [locale])

  useEffect(() => {
    instanceRef.current?.setDarkMode(dark)
  }, [dark])

  const reload = useCallback(() => {
    requireServerCopy.current = true
    setAttempt((value) => value + 1)
  }, [])

  const overwrite = useCallback(() => {
    const current = instanceRef.current
    const chosen = conflict
    setConflict(null)
    if (current && chosen) current.overwriteConflict(chosen.currentRev)
  }, [conflict])

  const retry = useCallback(() => {
    instanceRef.current?.retrySave()
  }, [])

  return (
    <div className="relative h-full min-h-0 bg-[var(--bg-base)]">
      <div ref={hostRef} className="h-full min-h-0" />
      {status !== 'ready' && (
        <div className="absolute inset-0 z-[var(--z-menu)]">
          <OfficeEditorPlaceholder
            title={title}
            failed={status === 'failed'}
            {...(error ? { detail: error } : {})}
            onRetry={status === 'failed' ? reload : undefined}
          />
        </div>
      )}
      {status === 'ready' && saveState === 'failed' && (
        <div
          role="alert"
          className="absolute inset-x-0 bottom-0 z-[var(--z-menu)] flex items-center justify-between gap-3 border-t border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2"
        >
          <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{t('office.save.failed')}</p>
          <Button size="sm" onClick={retry}>
            {t('office.save.retry')}
          </Button>
        </div>
      )}
      {conflict && (
        <div
          role="alert"
          className="absolute inset-x-0 bottom-0 z-[var(--z-menu)] flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2"
        >
          <div className="min-w-0">
            <p className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('office.conflict.title')}</p>
            <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('office.conflict.description')}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" onClick={reload}>
              {t('office.conflict.reload')}
            </Button>
            <Button size="sm" variant="primary" onClick={overwrite}>
              {t('office.conflict.overwrite')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}