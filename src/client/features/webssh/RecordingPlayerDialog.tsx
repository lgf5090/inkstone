import { useCallback, useEffect, useState } from 'react'
import { Link2, RefreshCw, Share2, Trash2 } from 'lucide-react'
import type { WebsshRecordingView, WebsshShareView } from '@shared/webssh/types'
import { Button, IconButton } from '../../components/primitives'
import { Modal, Tooltip, confirm } from '../../components/overlay'
import { ApiError } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { websshApi } from './api'
import { CastPlayer } from './CastPlayer'

function errorText(caught: unknown): string {
  return caught instanceof ApiError ? caught.message : t('webssh.error.generic')
}

export function RecordingPlayerDialog({ open, sessionId, onClose }: {
  open: boolean
  sessionId: string | null
  onClose: () => void
}) {
  const [recording, setRecording] = useState<WebsshRecordingView | null>(null)
  const [share, setShare] = useState<WebsshShareView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [sharing, setSharing] = useState(false)

  useEffect(() => {
    if (!open || !sessionId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setRecording(null)
    setShare(null)
    Promise.all([
      websshApi.recording(sessionId),
      websshApi.getShare(sessionId).catch(() => null),
    ])
      .then(([nextRecording, nextShare]) => {
        if (cancelled) return
        setRecording(nextRecording)
        setShare(nextShare)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorText(caught))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, sessionId])

  const loadSlice = useCallback(async (offset: number, limit: number) => {
    if (!sessionId) throw new Error(t('webssh.replay.not_ready'))
    const slice = await websshApi.recordingFrames(sessionId, offset, limit)
    return { nextOffset: slice.nextOffset, complete: slice.complete, frames: slice.frames, header: slice.header }
  }, [sessionId])

  const createShare = async () => {
    if (!sessionId) return
    setSharing(true)
    try {
      const created = await websshApi.createShare(sessionId, {})
      setShare(created)
      useUi.getState().toast({ title: t('webssh.share.created'), tone: 'success' })
    } catch (caught) {
      useUi.getState().toast({ title: errorText(caught), tone: 'danger' })
    } finally {
      setSharing(false)
    }
  }

  const revokeShare = async () => {
    if (!sessionId) return
    const approved = await confirm({
      title: t('webssh.share.revoke_title'),
      description: t('webssh.share.revoke_description'),
      tone: 'danger',
      confirmLabel: t('webssh.share.revoke'),
    })
    if (!approved) return
    setSharing(true)
    try {
      await websshApi.deleteShare(sessionId)
      setShare(null)
      useUi.getState().toast({ title: t('webssh.share.revoked'), tone: 'success' })
    } catch (caught) {
      useUi.getState().toast({ title: errorText(caught), tone: 'danger' })
    } finally {
      setSharing(false)
    }
  }

  const copyShare = async () => {
    if (!share) return
    const ok = await copyText(share.url)
    useUi.getState().toast({
      title: ok ? t('webssh.toast.copied') : t('webssh.toast.copy_failed'),
      tone: ok ? 'success' : 'danger',
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('webssh.replay.title')}
      description={recording ? t('webssh.replay.description') : undefined}
      width={900}
      footer={<Button onClick={onClose}>{t('webssh.actions.close')}</Button>}
    >
      {loading ? (
        <p className="text-[length:var(--text-12-5)] text-[var(--text-tertiary)]">{t('webssh.replay.loading')}</p>
      ) : error ? (
        <p className="text-[length:var(--text-12-5)] text-[var(--danger)]">{error}</p>
      ) : recording ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            <span>{t('webssh.replay.size', { size: recording.sizeBytes })}</span>
            <span>{t('webssh.replay.duration', { seconds: Math.round(recording.durationMs / 1000) })}</span>
            <span>{t('webssh.replay.dimensions', { cols: recording.cols, rows: recording.rows })}</span>
            <span>{t('webssh.replay.expires', { date: new Date(recording.expiresAt).toLocaleDateString() })}</span>
          </div>

          <CastPlayer
            loadSlice={loadSlice}
            durationMs={recording.durationMs}
          />

          <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Share2 size={14} aria-hidden="true" className="text-[var(--text-secondary)]" />
              <h3 className="min-w-0 flex-1 text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">
                {t('webssh.share.title')}
              </h3>
              {share ? (
                <>
                  <Tooltip label={t('webssh.share.copy')}>
                    <IconButton label={t('webssh.share.copy')} size="sm" onClick={() => void copyShare()}>
                      <Link2 size={14} aria-hidden="true" />
                    </IconButton>
                  </Tooltip>
                  <Button size="sm" variant="ghost" icon={<RefreshCw size={13} aria-hidden="true" />} loading={sharing} onClick={() => void createShare()}>
                    {t('webssh.share.rotate')}
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Trash2 size={13} aria-hidden="true" />} loading={sharing} onClick={() => void revokeShare()}>
                    {t('webssh.share.revoke')}
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="secondary" loading={sharing} onClick={() => void createShare()}>
                  {t('webssh.share.create')}
                </Button>
              )}
            </div>
            {share ? (
              <div className="mt-2 space-y-1">
                <p className="break-all font-mono text-[length:var(--text-11-5)] text-[var(--text-primary)]">{share.url}</p>
                <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                  {t('webssh.share.stats', {
                    views: share.views,
                    max: share.maxViews === 0 ? t('webssh.share.unlimited') : String(share.maxViews),
                    expires: new Date(share.expiresAt).toLocaleString(),
                  })}
                </p>
              </div>
            ) : (
              <p className="mt-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('webssh.share.hint')}</p>
            )}
          </div>
        </div>
      ) : (
        <p className="text-[length:var(--text-12-5)] text-[var(--text-tertiary)]">{t('webssh.replay.missing')}</p>
      )}
    </Modal>
  )
}
