// SFTP text editor (W5-03). It reads a whole file through the same bounded download route the
// browser uses, refuses anything that is not UTF-8 text within the editing ceiling, and writes back
// through staged upload chunks only after an explicit overwrite confirmation.

import { useEffect, useMemo, useState } from 'react'
import type { WebsshSftpEntry } from '@shared/webssh/types'
import { Button, Spinner } from '../../components/primitives'
import { Modal, confirm } from '../../components/overlay'
import { ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { websshApi } from './api'
// The editor's write ceiling and the shared read ceiling are the same number on purpose.
import { readSftpText, SFTP_TEXT_READ_LIMIT as EDIT_LIMIT } from './sftp-text'

function errorText(caught: unknown): string {
  // Local guards (size, encoding) throw plain Errors with a user-facing message; only show a generic
  // string when nothing carried one.
  if (caught instanceof ApiError) return caught.message
  if (caught instanceof Error && caught.message) return caught.message
  return t('webssh.error.generic')
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

export function FileEditorDialog({ open, entry, sessionId, onClose, onSaved }: {
  open: boolean
  entry: WebsshSftpEntry | null
  sessionId: string
  onClose: () => void
  onSaved: () => void
}) {
  const [text, setText] = useState('')
  const [original, setOriginal] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    if (!open || !entry) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setText('')
    setOriginal('')
    void (async () => {
      const decoded = await readSftpText(sessionId, entry, EDIT_LIMIT)
      if (cancelled) return
      setText(decoded)
      setOriginal(decoded)
    })().catch((caught: unknown) => {
      if (!cancelled) setError(errorText(caught))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [open, entry, sessionId, reloadToken])

  const dirty = text !== original
  const lines = useMemo(() => (text ? text.split('\n').length : 0), [text])
  const bytes = useMemo(() => new TextEncoder().encode(text).byteLength, [text])

  const close = async () => {
    if (saving) return
    if (dirty) {
      const approved = await confirm({
        title: t('webssh.editor.discard_title'),
        description: t('webssh.editor.discard_description'),
        tone: 'danger',
        confirmLabel: t('webssh.actions.close'),
      })
      if (!approved) return
    }
    onClose()
  }

  const save = async () => {
    if (!entry || !dirty) return
    const buffer = new TextEncoder().encode(text)
    if (buffer.byteLength > EDIT_LIMIT) {
      setError(t('webssh.editor.too_large', { name: entry.name }))
      return
    }
    const approved = await confirm({
      title: t('webssh.editor.overwrite_title'),
      description: t('webssh.editor.overwrite_description', { name: entry.name }),
      tone: 'danger',
      confirmLabel: t('webssh.editor.confirm_overwrite'),
    })
    if (!approved) return
    setSaving(true)
    setError(null)
    try {
      const created = await websshApi.createUpload(sessionId, entry.path, buffer.byteLength)
      let offset = 0
      try {
        while (offset < buffer.byteLength) {
          const chunk = buffer.slice(offset, Math.min(offset + created.chunkSize, buffer.byteLength))
          await websshApi.putChunk(sessionId, created.transferId, offset, new Blob([chunk]))
          offset += chunk.byteLength
        }
        await websshApi.completeUpload(sessionId, created.transferId)
      } catch (caught) {
        // Staging cleanup is best effort: the completed save already failed, and a leftover transfer
        // is collected by the 24-hour sweep.
        await websshApi.cancelUpload(sessionId, created.transferId).catch((error: unknown) => {
          console.warn('[inkstone] Could not cancel staged editor upload:', error)
        })
        throw caught
      }
      setOriginal(text)
      useUi.getState().toast({ title: t('webssh.editor.saved', { name: entry.name }), tone: 'success' })
      onSaved()
      onClose()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => void close()}
      title={t('webssh.editor.title')}
      description={t('webssh.editor.description')}
      width={760}
      dismissible={!saving}
      footer={
        <>
          <Button onClick={() => void close()}>{t('webssh.actions.close')}</Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={!dirty || loading || saving || error !== null}
            onClick={() => void save()}
          >
            {t('webssh.editor.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          <span className="min-w-0 truncate font-mono text-[var(--text-primary)]">{entry?.path}</span>
          <span>{t('webssh.editor.encoding')}</span>
          {text && <span>{t('webssh.editor.lines', { count: lines })}</span>}
          {text && <span>{t('webssh.editor.bytes', { size: formatBytes(bytes) })}</span>}
          {dirty && <span className="text-[var(--warning)]">{t('webssh.editor.modified')}</span>}
        </div>

        {error ? (
          <div className="space-y-2">
            <p role="alert" className="text-[length:var(--text-12-5)] text-[var(--danger)]">{error}</p>
            <Button size="sm" onClick={() => setReloadToken((value) => value + 1)}>{t('webssh.actions.retry')}</Button>
          </div>
        ) : loading ? (
          <div className="flex items-center gap-2 py-6 text-[length:var(--text-12-5)] text-[var(--text-tertiary)]">
            <Spinner size={14} />
            {t('webssh.editor.loading', { name: entry?.name ?? '' })}
          </div>
        ) : (
          <textarea
            value={text}
            spellCheck={false}
            aria-label={t('webssh.editor.title')}
            className="h-[46vh] min-h-[220px] w-full resize-y rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-editor)] p-2 font-mono text-[length:var(--text-12)] leading-relaxed text-[var(--text-primary)] outline-none focus:border-[var(--border-strong)]"
            onChange={(event) => setText(event.target.value)}
          />
        )}
      </div>
    </Modal>
  )
}
