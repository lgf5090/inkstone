// Recording library (W6-02). Rows are grouped by host, newest first, and each row opens the same
// replay/share dialog the terminal uses, so the share capability has one implementation.

import { useEffect, useMemo, useState } from 'react'
import { Play, Share2, Sparkles, Trash2 } from 'lucide-react'
import type { WebsshRecordingListItem } from '@shared/webssh/types'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Empty } from '../../components/feedback'
import { Modal, Tooltip, confirm } from '../../components/overlay'
import { ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { websshApi } from './api'
import { RecordingPlayerDialog } from './RecordingPlayerDialog'
import { RecordingAiDialog } from './RecordingAiDialog'

function errorText(caught: unknown): string {
  return caught instanceof ApiError ? caught.message : t('webssh.error.generic')
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function statusText(status: string): string {
  if (status === 'recording') return t('webssh.recordings.status_recording')
  if (status === 'finalizing') return t('webssh.recordings.status_finalizing')
  if (status === 'failed') return t('webssh.recordings.status_failed')
  if (status === 'deleted') return t('webssh.recordings.status_deleted')
  return t('webssh.recordings.status_ready')
}

export function RecordingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [items, setItems] = useState<WebsshRecordingListItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [replaySession, setReplaySession] = useState<string | null>(null)
  const [replaySeekMs, setReplaySeekMs] = useState<number | null>(null)
  const [aiTarget, setAiTarget] = useState<WebsshRecordingListItem | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    websshApi.listRecordings({ page, pageSize })
      .then((response) => {
        if (cancelled) return
        setItems(response.items)
        setTotal(response.total)
        setError(null)
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
  }, [open, page, pageSize, reloadToken])

  const groups = useMemo(() => {
    const map = new Map<string, WebsshRecordingListItem[]>()
    for (const item of items) {
      const name = item.hostName || t('webssh.recordings.group_unknown')
      const group = map.get(name)
      if (group) group.push(item)
      else map.set(name, [item])
    }
    return [...map.entries()]
  }, [items])

  const remove = async (item: WebsshRecordingListItem) => {
    const approved = await confirm({
      title: t('webssh.recordings.remove_title'),
      description: t('webssh.recordings.remove_description'),
      tone: 'danger',
      confirmLabel: t('webssh.recordings.delete'),
    })
    if (!approved) return
    try {
      await websshApi.deleteRecording(item.sessionId)
      useUi.getState().toast({ title: t('webssh.recordings.deleted'), tone: 'success' })
      setReloadToken((value) => value + 1)
    } catch (caught) {
      useUi.getState().toast({ title: errorText(caught), tone: 'danger' })
    }
  }

  const pages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={t('webssh.recordings.title')}
        description={t('webssh.recordings.description')}
        width={900}
        footer={<Button variant="ghost" onClick={onClose}>{t('webssh.actions.close')}</Button>}
      >
        {error && <p role="alert" className="mb-2 text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
        {loading && items.length === 0 ? (
          <div className="flex justify-center py-8"><Spinner size={16} /></div>
        ) : items.length === 0 ? (
          <Empty art="select" compact title={t('webssh.recordings.empty')} />
        ) : (
          <div className="max-h-[60vh] overflow-auto rounded-[var(--r-md)] border border-[var(--border-subtle)]">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="sticky top-0 z-10 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] text-[length:var(--text-11)] uppercase tracking-wide text-[var(--text-quaternary)]">
                  <th className="px-2 py-1.5 font-medium">{t('webssh.recordings.column_host')}</th>
                  <th className="hidden px-2 py-1.5 font-medium sm:table-cell">{t('webssh.recordings.column_session')}</th>
                  <th className="px-2 py-1.5 font-medium">{t('webssh.recordings.column_created')}</th>
                  <th className="hidden px-2 py-1.5 font-medium sm:table-cell">{t('webssh.recordings.column_duration')}</th>
                  <th className="px-2 py-1.5 font-medium">{t('webssh.recordings.column_size')}</th>
                  <th className="hidden px-2 py-1.5 font-medium sm:table-cell">{t('webssh.recordings.column_status')}</th>
                  <th className="px-2 py-1.5 font-medium text-end">{t('webssh.recordings.actions')}</th>
                </tr>
              </thead>
              {groups.map(([hostName, group]) => (
                <tbody key={hostName} className="divide-y divide-[var(--border-subtle)]">
                  <tr className="bg-[var(--bg-inset)]">
                    <td colSpan={7} className="px-2 py-1 text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">
                      {hostName}
                    </td>
                  </tr>
                  {group.map((item) => (
                    <tr key={item.id} className="align-top hover:bg-[var(--bg-hover)]">
                      <td className="px-2 py-1.5 text-[length:var(--text-12)] text-[var(--text-primary)]">
                        {item.hostName || t('webssh.recordings.group_unknown')}
                      </td>
                      <td className="hidden px-2 py-1.5 font-mono text-[length:var(--text-10-5)] text-[var(--text-tertiary)] sm:table-cell">
                        {item.sessionId.slice(-8)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
                        {new Date(item.createdAt).toLocaleString()}
                      </td>
                      <td className="hidden tabular px-2 py-1.5 text-[length:var(--text-11-5)] text-[var(--text-secondary)] sm:table-cell">
                        {formatDuration(item.durationMs)}
                      </td>
                      <td className="tabular px-2 py-1.5 text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
                        {formatBytes(item.sizeBytes)}
                      </td>
                      <td className="hidden px-2 py-1.5 text-[length:var(--text-11)] text-[var(--text-tertiary)] sm:table-cell">
                        {statusText(item.status)}
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex items-center justify-end gap-0.5">
                          <Tooltip label={t('webssh.recordings.replay')}>
                            <IconButton
                              label={t('webssh.recordings.replay')}
                              size="xs"
                              disabled={item.status !== 'ready'}
                              onClick={() => {
                                setReplaySeekMs(null)
                                setReplaySession(item.sessionId)
                              }}
                            >
                              <Play size={13} aria-hidden="true" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip label={t('webssh.share.title')}>
                            <IconButton
                              label={t('webssh.share.title')}
                              size="xs"
                              disabled={item.status !== 'ready'}
                              onClick={() => {
                                setReplaySeekMs(null)
                                setReplaySession(item.sessionId)
                              }}
                            >
                              <Share2 size={13} aria-hidden="true" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip label={t('webssh.ai.recording.open')}>
                            <IconButton
                              label={t('webssh.ai.recording.open')}
                              size="xs"
                              disabled={item.status !== 'ready'}
                              onClick={() => setAiTarget(item)}
                            >
                              <Sparkles size={13} aria-hidden="true" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip label={t('webssh.recordings.delete')}>
                            <IconButton label={t('webssh.recordings.delete')} size="xs" onClick={() => void remove(item)}>
                              <Trash2 size={13} aria-hidden="true" />
                            </IconButton>
                          </Tooltip>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        )}

        <div className="mt-2 flex items-center justify-between gap-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          <span>{t('webssh.recordings.count', { count: total })}</span>
          <span className="flex items-center gap-1">
            <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
              {t('webssh.audit.previous')}
            </Button>
            <span>{t('webssh.audit.page', { page, pages })}</span>
            <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>
              {t('webssh.audit.next')}
            </Button>
          </span>
        </div>
      </Modal>

      <RecordingPlayerDialog
        open={replaySession !== null}
        sessionId={replaySession}
        initialSeekMs={replaySeekMs}
        onClose={() => {
          setReplaySession(null)
          setReplaySeekMs(null)
        }}
      />

      <RecordingAiDialog
        open={aiTarget !== null}
        sessionId={aiTarget?.sessionId ?? null}
        hostName={aiTarget?.hostName || t('webssh.recordings.group_unknown')}
        onClose={() => setAiTarget(null)}
        onSeek={(atMs) => {
          if (!aiTarget) return
          setAiTarget(null)
          setReplaySeekMs(atMs)
          setReplaySession(aiTarget.sessionId)
        }}
      />
    </>
  )
}
