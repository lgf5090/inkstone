import { Suspense, useEffect, useRef, useState, type ComponentType } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import type { OfficeFileType } from '@shared/office/constants'
import type { OfficeSnapshot } from '@shared/office/model'
import { ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { LoadingBlock } from '../../components/feedback'
import { ErrorBoundary } from '../../components/ErrorBoundary'
import { officeErrorText, officeApi } from './api'
import { OFFICE_EDITOR_COMPONENTS } from './editor/registry'
import type { OfficeEditorHandle, OfficeEditorProps } from './editor/contracts'
import { OfficeAiBridge } from './ai/OfficeAiBridge'
import { officeSaveStateLabel, type OfficeSaveState } from './OfficeEditorTabs'
import { officeTypeLabel, officeTypeIcon } from './office-menus'

/**
 * What the shell would like each product to report, on top of the frozen editor contract.
 *
 * `contracts.ts` only promises a ready handle, so dirty/save state has no channel yet. The props
 * are optional and passed to every editor anyway: an editor that adopts them lights the tab's dot
 * and the status row, and one that ignores them simply writes its own autosave. The handle is what
 * makes switching tabs safe in either case — `flush()` is part of the frozen contract.
 */
type OfficeEditorRuntimeComponent = ComponentType<OfficeEditorProps & {
  onDirtyChange?: (dirty: boolean) => void
  onSaveState?: (state: OfficeSaveState) => void
}>

export interface OfficeEditorHostProps {
  file: { id: string; type: OfficeFileType; title: string }
  /** Bumped by the shell after a version restore, so the open editor reloads its snapshot. */
  reloadKey?: number
  onDirtyChange: (fileId: string, dirty: boolean) => void
  onSaveState: (fileId: string, state: OfficeSaveState) => void
  onHandle: (fileId: string, handle: OfficeEditorHandle | null) => void
  onUnavailable: (fileId: string) => void
}

export function OfficeEditorHost({ file, reloadKey = 0, onDirtyChange, onSaveState, onHandle, onUnavailable }: OfficeEditorHostProps) {
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading')
  const [snapshot, setSnapshot] = useState<OfficeSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [saveState, setSaveState] = useState<OfficeSaveState>('idle')
  const handleRef = useRef<OfficeEditorHandle | null>(null)
  // The snapshot read depends on the file, not on the shell's handler identities: a handler rebuilt on a
  // parent render would otherwise restart the read, unmount the editor mid-edit, and let the editor's own
  // state report drive the next render — a loop that never reaches a stable frame.
  const callbacks = useRef({ onUnavailable })
  callbacks.current = { onUnavailable }

  useEffect(() => {
    let alive = true
    setStatus('loading')
    setError(null)
    setSnapshot(null)
    setSaveState('idle')
    officeApi.snapshot(file.id)
      .then((result) => {
        if (!alive) return
        setSnapshot(result.snapshot)
        setStatus('ready')
      })
      .catch((caught: unknown) => {
        if (!alive) return
        setError(officeErrorText(caught))
        setStatus('error')
        if (caught instanceof ApiError && caught.status === 404) callbacks.current.onUnavailable(file.id)
      })
    return () => {
      alive = false
    }
  }, [file.id, reloadKey, retry])

  useEffect(() => () => {
    handleRef.current = null
    onHandle(file.id, null)
  }, [file.id, onHandle])

  const Editor = OFFICE_EDITOR_COMPONENTS[file.type] as unknown as OfficeEditorRuntimeComponent
  const statusLabel = officeSaveStateLabel(saveState)

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]">
      <div className="min-h-0 flex-1">
        {status === 'loading' && <LoadingBlock label={t('office.editor.loading')} />}
        {status === 'error' && (
          <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <AlertTriangle size={24} className="text-[var(--danger)]" aria-hidden="true" />
            <p className="text-[length:var(--text-13)] font-medium text-[var(--text-secondary)]">{t('office.editor.failed')}</p>
            {error && <p className="max-w-[420px] text-[length:var(--text-11)] text-[var(--text-tertiary)]">{error}</p>}
            <Button variant="secondary" size="sm" icon={<RotateCcw size={13} />} onClick={() => setRetry((value) => value + 1)}>
              {t('office.editor.retry')}
            </Button>
          </div>
        )}
        {status === 'ready' && (
          <ErrorBoundary
            key={`${file.id}:${retry}`}
            fallback={(
              <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <p className="text-[length:var(--text-13)] text-[var(--text-secondary)]">{t('office.editor.failed')}</p>
                <Button variant="secondary" size="sm" onClick={() => setRetry((value) => value + 1)}>{t('office.editor.retry')}</Button>
              </div>
            )}
          >
            <Suspense fallback={<LoadingBlock label={t('office.editor.loading')} />}>
              <Editor
                key={file.id}
                fileId={file.id}
                fileType={file.type}
                title={file.title}
                snapshot={snapshot}
                onReady={(handle) => {
                  handleRef.current = handle
                  onHandle(file.id, handle)
                }}
                onError={(message) => {
                  setError(message)
                  setStatus('error')
                }}
                onDirtyChange={(dirty) => {
                  setSaveState(dirty ? 'dirty' : 'idle')
                  onDirtyChange(file.id, dirty)
                }}
                onSaveState={(state) => {
                  setSaveState(state)
                  onSaveState(file.id, state)
                }}
              />
            </Suspense>
          </ErrorBoundary>
        )}
      </div>
      <footer className="flex h-6 shrink-0 items-center gap-2 border-t border-[var(--border-subtle)] px-2 text-[length:var(--text-10)] text-[var(--text-tertiary)]">
        <span className="flex items-center gap-1">
          {officeTypeIcon(file.type, 11)}
          {officeTypeLabel(file.type)}
        </span>
        {statusLabel && <span aria-live="polite">{statusLabel}</span>}
        <span className="ml-auto truncate">{file.title}</span>
      </footer>
      <OfficeAiBridge />
    </div>
  )
}