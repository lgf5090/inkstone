/**
 * Natural-language search over one recorded session.
 *
 * The worker reads the cast from R2, turns its output events into timestamped text and asks the
 * model for the moments that match. The answer is a list of timestamps, and choosing one opens the
 * replay at that moment rather than making the reader scrub a timeline.
 */

import { useState } from 'react'
import { Search } from 'lucide-react'
import type { WebsshAiRecordingSearchResult } from '@shared/webssh/ai'
import { Button, Spinner } from '../../components/primitives'
import { Empty } from '../../components/feedback'
import { Input } from '../../components/form'
import { Modal } from '../../components/overlay'
import { t } from '../../lib/i18n'
import { websshAiApi } from './ai-client'
import { websshAiErrorText } from './ai-error'

function timeLabel(atMs: number): string {
  const seconds = Math.max(0, Math.round(atMs / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function RecordingAiDialog({ open, sessionId, hostName, onClose, onSeek }: {
  open: boolean
  sessionId: string | null
  hostName: string
  onClose: () => void
  onSeek: (atMs: number) => void
}) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<WebsshAiRecordingSearchResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const search = async () => {
    if (!sessionId || !query.trim()) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      setResult(await websshAiApi.recordingSearch({ sessionId, query: query.trim() }))
    } catch (caught) {
      setError(websshAiErrorText(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('webssh.ai.recording.title')}
      description={t('webssh.ai.recording.description', { host: hostName })}
      width={680}
      footer={<Button variant="ghost" onClick={onClose}>{t('webssh.actions.close')}</Button>}
    >
      <div className="space-y-3">
        <div className="flex items-end gap-2">
          <Input
            value={query}
            aria-label={t('webssh.ai.recording.query_label')}
            placeholder={t('webssh.ai.recording.query_placeholder')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) void search()
            }}
            leading={<Search size={13} aria-hidden="true" />}
            className="min-w-0 flex-1"
          />
          <Button variant="primary" loading={busy} disabled={!query.trim()} onClick={() => void search()}>
            {t('webssh.ai.recording.search')}
          </Button>
        </div>
        {busy && (
          <div role="status" aria-live="polite" className="flex items-center gap-2 py-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            <Spinner size={13} />
            {t('webssh.ai.recording.scanning')}
          </div>
        )}
        {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
        {result && !busy && (
          <>
            {result.truncated && <p className="text-[length:var(--text-11)] text-[var(--warning)]">{t('webssh.ai.recording.truncated')}</p>}
            {result.matches.length === 0 ? (
              <Empty art="search" compact title={t('webssh.ai.recording.empty')} description={t('webssh.ai.recording.empty_description')} />
            ) : (
              <ul className="space-y-1.5">
                {result.matches.map((match, index) => (
                  <li key={`${match.atMs}-${index}`} className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2">
                    <div className="flex items-start gap-2">
                      <Button size="sm" variant="secondary" onClick={() => onSeek(match.atMs)}>
                        {timeLabel(match.atMs)}
                      </Button>
                      <div className="min-w-0 flex-1">
                        <p className="break-all font-mono text-[length:var(--text-11-5)] text-[var(--text-primary)]">{match.text || '—'}</p>
                        {match.reason && <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{match.reason}</p>}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
              {t('webssh.ai.recording.scanned', { seconds: Math.round(result.scannedMs / 1000) })}
            </p>
          </>
        )}
        {!result && !busy && !error && (
          <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('webssh.ai.recording.hint')}</p>
        )}
      </div>
    </Modal>
  )
}
