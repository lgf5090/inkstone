import { useCallback, useEffect, useState } from 'react'
import type { FileViewerRendererPluginInput } from '@file-viewer/core'
import type { ViewerState } from '@file-viewer/react'
import { Modal } from '../../components/overlay'
import { Empty } from '../../components/feedback'
import { Button, Spinner } from '../../components/primitives'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { resolveFilePreviewLoader } from './registry'
import type { FilePreviewModalProps, FilePreviewTarget } from './types'

type ReactViewerModule = typeof import('@file-viewer/react')

type PreviewPhase = 'loading' | 'ready' | 'error' | 'unsupported'

interface LoadedPreview {
  module: ReactViewerModule
  plugin: FileViewerRendererPluginInput
  native: File
}

export default function FilePreviewModal({ open, onClose, file }: FilePreviewModalProps) {
  const { url, filename, mime, size } = file
  const toast = useUi((state) => state.toast)

  const [phase, setPhase] = useState<PreviewPhase>('loading')
  const [loaded, setLoaded] = useState<LoadedPreview | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [isViewerLoading, setViewerLoading] = useState(true)
  const [viewerFailed, setViewerFailed] = useState(false)

  const target = { url, filename, mime, size }

  const reportFailure = useCallback(() => {
    toast({ title: t('filepreview.failed', { value0: filename }), tone: 'danger' })
  }, [toast, filename])

  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    setPhase('loading')
    setLoaded(null)
    setViewerLoading(true)
    setViewerFailed(false)

    const loader = resolveFilePreviewLoader(target)
    if (!loader) {
      setPhase('unsupported')
      return
    }

    void Promise.all([import('@file-viewer/react'), loader()])
      .then(async ([module, rendererModule]) => {
        // The viewer names a file off its URL when handed one, and our object URLs
        // (`/api/files/<26-char id>`) carry no extension — so it fell back to synthesising
        // `preview.<mime>` and read the extension as `.image/png`, declaring every attachment
        // unsupported. Handing it a real File keeps the name authoritative instead.
        const blob = await fetch(url, { credentials: 'same-origin' }).then((response) => {
          if (!response.ok) throw new Error(`Attachment fetch failed: ${response.status}`)
          return response.blob()
        })
        if (cancelled) return
        const native = new File([blob], filename, { type: mime || blob.type })
        setLoaded({ module, plugin: rendererModule.default, native })
        setPhase('ready')
      })
      .catch(() => {
        if (cancelled) {
          return
        }
        setPhase('error')
        reportFailure()
      })

    return () => {
      cancelled = true
    }
    // `attempt` re-runs the same load on retry; `target` is rebuilt from primitives each render, so the
    // effect keys on the fields that actually identify a preview rather than on a fresh object identity.
  }, [open, url, filename, mime, size, attempt, reportFailure])

  const handleStateChange = useCallback((state: ViewerState) => {
    setViewerLoading(state.loading)
    if (state.error) {
      setViewerFailed(true)
      reportFailure()
    }
  }, [reportFailure])

  const retry = () => {
    setAttempt((current) => current + 1)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      variant='fullscreen'
      title={<span className='min-w-0 truncate'>{filename}</span>}
    >
      <div className='flex min-h-0 flex-1 flex-col bg-[var(--bg-base)]'>
        {phase === 'loading' && <LoadingMessage />}

        {phase === 'unsupported' && (
          <Empty
            art='archive'
            title={t('filepreview.unsupported', { value0: filename })}
            action={<DownloadLink file={target} />}
          />
        )}

        {phase === 'error' && (
          <Empty
            art='folder'
            title={t('filepreview.failed', { value0: filename })}
            action={(
              <div className='flex items-center gap-[var(--sp-2)]'>
                <Button size='sm' variant='secondary' onClick={retry}>
                  {t('filepreview.retry')}
                </Button>
                <DownloadLink file={target} />
              </div>
            )}
          />
        )}

        {phase === 'ready' && loaded && (
          <div className='relative min-h-0 flex-1'>
            <LoadedViewer loaded={loaded} onStateChange={handleStateChange} />
            {isViewerLoading && !viewerFailed && <LoadingOverlay />}
            {viewerFailed && (
              <Empty
                art='folder'
                title={t('filepreview.failed', { value0: filename })}
                action={<DownloadLink file={target} />}
              />
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}

function LoadedViewer({ loaded, onStateChange }: {
  loaded: LoadedPreview
  onStateChange: (state: ViewerState) => void
}) {
  const Viewer = loaded.module.FileViewer
  return (
    <Viewer
      file={loaded.native}
      options={{ renderers: [loaded.plugin] }}
      onStateChange={onStateChange}
      className='h-full w-full'
    />
  )
}

function LoadingMessage() {
  return (
    <div className='flex flex-1 flex-col items-center justify-center gap-[var(--sp-3)] text-[length:var(--text-12)] text-[var(--text-tertiary)]'>
      <Spinner size={20} />
      <span>{t('filepreview.loading')}</span>
    </div>
  )
}

function LoadingOverlay() {
  return (
    <div className='absolute inset-0 flex flex-col items-center justify-center gap-[var(--sp-3)] bg-[var(--bg-overlay)] text-[length:var(--text-12)] text-[var(--text-tertiary)]'>
      <Spinner size={20} />
      <span>{t('filepreview.loading')}</span>
    </div>
  )
}

function DownloadLink({ file }: { file: FilePreviewTarget }) {
  return (
    <a
      href={file.url}
      download={file.filename}
      rel='noopener noreferrer'
      className='inline-flex h-9 items-center gap-[var(--sp-1-5)] rounded-[var(--r-sm)] border border-[var(--border-default)] px-[var(--sp-3)] text-[length:var(--text-12)] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)] md:h-7 md:px-2.5'
    >
      {t('common.download')}
    </a>
  )
}
