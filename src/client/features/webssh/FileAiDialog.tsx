/**
 * Read-only AI over one remote text file.
 *
 * The file is fetched through the same bounded SFTP read the editor uses, then only a 48k window
 * leaves the browser: the beginning for a summary or a question, the end for log anomalies where
 * the failure is usually at the bottom. This call never proposes or applies an edit.
 */

import { useEffect, useState } from 'react'
import type { WebsshAiFileFinding, WebsshAiFileMode, WebsshAiFileResult } from '@shared/webssh/ai'
import type { WebsshSftpEntry } from '@shared/webssh/types'
import { Badge, Button, Spinner } from '../../components/primitives'
import { Textarea } from '../../components/form'
import { Modal } from '../../components/overlay'
import { t } from '../../lib/i18n'
import { websshAiApi } from './ai-client'
import { websshAiErrorText } from './ai-error'
import { readSftpText } from './sftp-text'

const SEND_LIMIT = 48000
/** A log is read further than an editor file, then reduced to the 48k window before it leaves. */
const READ_LIMIT = 8 * 1024 * 1024

function severityTone(severity: WebsshAiFileFinding['severity']): 'neutral' | 'warning' | 'danger' {
  if (severity === 'danger') return 'danger'
  if (severity === 'warning') return 'warning'
  return 'neutral'
}

export function FileAiDialog({ open, sessionId, entry, onClose }: {
  open: boolean
  sessionId: string
  entry: WebsshSftpEntry | null
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const [reading, setReading] = useState(false)
  const [readError, setReadError] = useState<string | null>(null)
  const [mode, setMode] = useState<WebsshAiFileMode>('summary')
  const [question, setQuestion] = useState('')
  const [result, setResult] = useState<WebsshAiFileResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !entry) return
    let cancelled = false
    setReading(true)
    setReadError(null)
    setText('')
    setResult(null)
    setError(null)
    setMode('summary')
    setQuestion('')
    readSftpText(sessionId, entry, READ_LIMIT)
      .then((content) => {
        if (!cancelled) setText(content)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setReadError(caught instanceof Error && caught.message ? caught.message : t('webssh.error.generic'))
      })
      .finally(() => {
        if (!cancelled) setReading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, entry, sessionId])

  const analyze = async () => {
    if (!entry) return
    const content = text.length > SEND_LIMIT
      ? (mode === 'anomaly' ? text.slice(-SEND_LIMIT) : text.slice(0, SEND_LIMIT))
      : text
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      setResult(await websshAiApi.file({
        path: entry.path,
        content,
        mode,
        question: question.trim(),
        sessionId,
      }))
    } catch (caught) {
      setError(websshAiErrorText(caught))
    } finally {
      setBusy(false)
    }
  }

  const truncated = text.length > SEND_LIMIT

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('webssh.ai.file.title')}
      description={t('webssh.ai.file.description')}
      width={760}
      footer={<Button variant="ghost" onClick={onClose}>{t('webssh.actions.close')}</Button>}
    >
      <div className="space-y-3">
        <p className="break-all font-mono text-[length:var(--text-11-5)] text-[var(--text-primary)]">{entry?.path}</p>
        {readError ? (
          <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{readError}</p>
        ) : reading ? (
          <div className="flex items-center gap-2 py-4 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            <Spinner size={14} />
            {t('webssh.ai.file.loading')}
          </div>
        ) : (
          <>
            <div role="group" aria-label={t('webssh.ai.file.modes')} className="flex flex-wrap items-center gap-1">
              <Button size="sm" variant={mode === 'summary' ? 'primary' : 'secondary'} onClick={() => setMode('summary')}>
                {t('webssh.ai.file.mode_summary')}
              </Button>
              <Button size="sm" variant={mode === 'question' ? 'primary' : 'secondary'} onClick={() => setMode('question')}>
                {t('webssh.ai.file.mode_question')}
              </Button>
              <Button size="sm" variant={mode === 'anomaly' ? 'primary' : 'secondary'} onClick={() => setMode('anomaly')}>
                {t('webssh.ai.file.mode_anomaly')}
              </Button>
            </div>
            {mode === 'question' && (
              <Textarea
                value={question}
                aria-label={t('webssh.ai.file.question_label')}
                placeholder={t('webssh.ai.file.question_placeholder')}
                rows={2}
                onChange={(event) => setQuestion(event.target.value)}
              />
            )}
            {truncated && (
              <p className="text-[length:var(--text-11)] text-[var(--warning)]">{t('webssh.ai.file.truncated')}</p>
            )}
            <div className="flex items-center gap-2">
              <Button size="sm" variant="primary" loading={busy} disabled={mode === 'question' && !question.trim()} onClick={() => void analyze()}>
                {t('webssh.ai.file.analyze')}
              </Button>
              {busy && <span role="status" aria-live="polite" className="inline-flex items-center gap-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]"><Spinner size={12} />{t('webssh.ai.thinking')}</span>}
            </div>
            {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
            {result && (
              <div className="space-y-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
                <div>
                  <h3 className="text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{t('webssh.ai.file.answer')}</h3>
                  <p className="mt-1 whitespace-pre-wrap text-[length:var(--text-12)] text-[var(--text-primary)]">{result.answer || '—'}</p>
                </div>
                {result.findings.length > 0 && (
                  <div>
                    <h3 className="text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{t('webssh.ai.file.findings')}</h3>
                    <ul className="mt-1 space-y-1">
                      {result.findings.map((finding, index) => (
                        <li key={`${finding.line ?? 'file'}-${index}`} className="flex items-start gap-1.5">
                          <Badge tone={severityTone(finding.severity)}>
                            {finding.line === null ? t('webssh.ai.file.file_wide') : t('webssh.ai.file.line', { line: finding.line })}
                          </Badge>
                          <span className="min-w-0 flex-1 text-[length:var(--text-11-5)] text-[var(--text-secondary)]">{finding.message}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {(result.truncated || truncated) && (
                  <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('webssh.ai.file.truncated')}</p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
