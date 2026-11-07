// Host import dialog (plan W7-02). Parsing is server-side so the same rules guard the API and the
// preview; the file is read locally and only its text is posted, never the binary upload.

import { useRef, useMemo, useState } from 'react'
import { Upload } from 'lucide-react'
import type { WebsshHost, WebsshImportPreview } from '@shared/webssh/types'
import { Button } from '../../components/primitives'
import { Field, Select, Textarea } from '../../components/form'
import { Empty } from '../../components/feedback'
import { Modal } from '../../components/overlay'
import { ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { websshApi } from './api'

const FILE_LIMIT = 1024 * 1024

function errorText(caught: unknown): string {
  return caught instanceof ApiError ? caught.message : t('webssh.error.generic')
}

function issueText(issue: string): string {
  if (issue === 'name_invalid') return t('webssh.import.issue_name_invalid')
  if (issue === 'host_invalid') return t('webssh.import.issue_host_invalid')
  if (issue === 'port_invalid') return t('webssh.import.issue_port_invalid')
  if (issue === 'username_missing') return t('webssh.import.issue_username_missing')
  if (issue === 'tags_invalid') return t('webssh.import.issue_tags_invalid')
  if (issue === 'duplicate') return t('webssh.import.issue_duplicate')
  return t('webssh.import.issue_invalid')
}

export function ImportDialog({ open, onClose, onImported }: {
  open: boolean
  onClose: () => void
  onImported: (hosts: WebsshHost[]) => void
}) {
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [content, setContent] = useState('')
  const [format, setFormat] = useState<'auto' | 'ssh-config' | 'csv'>('auto')
  const [preview, setPreview] = useState<WebsshImportPreview | null>(null)
  const [deselected, setDeselected] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const chosenCount = useMemo(
    () => preview?.candidates.filter((candidate, index) => candidate.issues.length === 0 && !deselected.has(index)).length ?? 0,
    [preview, deselected],
  )

  const reset = () => {
    setContent('')
    setPreview(null)
    setDeselected(new Set())
    setError(null)
  }

  const close = () => {
    reset()
    onClose()
  }

  const loadFile = async (file: File | undefined) => {
    if (!file) return
    if (file.size > FILE_LIMIT) {
      setError(t('webssh.import.file_too_large'))
      return
    }
    try {
      setContent(await file.text())
      setPreview(null)
      setError(null)
    } catch {
      setError(t('webssh.import.preview_failed'))
    }
  }

  const runPreview = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await websshApi.previewImport(content, format)
      setPreview(result)
      setDeselected(new Set())
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  const commit = async () => {
    if (!preview) {
      setError(t('webssh.import.need_preview'))
      return
    }
    const rows = preview.candidates.filter((candidate, index) => (
      candidate.issues.length === 0 && !deselected.has(index)
    )).map((candidate) => ({
      name: candidate.name,
      host: candidate.host,
      port: candidate.port,
      username: candidate.username,
      tags: candidate.tags,
    }))
    if (!rows.length) {
      setError(t('webssh.import.no_selection'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await websshApi.commitImport(rows)
      useUi.getState().toast({
        title: t('webssh.import.imported', { count: result.created.length }),
        tone: result.created.length ? 'success' : 'warning',
      })
      if (result.skipped.length) {
        useUi.getState().toast({ title: t('webssh.import.skipped', { count: result.skipped.length }), tone: 'warning' })
      }
      onImported(result.created)
      close()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={t('webssh.import.title')}
      description={t('webssh.import.description')}
      width={760}
      dismissible={!busy}
      footer={
        <>
          <Button onClick={close}>{t('webssh.actions.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={!content.trim()} onClick={() => void commit()}>
            {t('webssh.import.commit')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t('webssh.import.format')} className="w-[200px]">
            <Select value={format} onChange={(event) => setFormat(event.target.value as 'auto' | 'ssh-config' | 'csv')}>
              <option value="auto">{t('webssh.import.format_auto')}</option>
              <option value="ssh-config">{t('webssh.import.format_ssh')}</option>
              <option value="csv">{t('webssh.import.format_csv')}</option>
            </Select>
          </Field>
          <Button variant="secondary" icon={<Upload size={13} aria-hidden="true" />} onClick={() => fileRef.current?.click()}>
            {t('webssh.import.choose_file')}
          </Button>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept=".csv,.txt,text/plain"
            onChange={(event) => {
              void loadFile(event.target.files?.[0])
              event.target.value = ''
            }}
          />
          <Button loading={busy} disabled={!content.trim()} onClick={() => void runPreview()}>
            {t('webssh.import.preview')}
          </Button>
        </div>
        <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('webssh.import.file_hint')}</p>

        <Field label={t('webssh.import.content')}>
          <Textarea
            rows={6}
            value={content}
            spellCheck={false}
            className="font-mono"
            placeholder={t('webssh.import.content_placeholder')}
            onChange={(event) => {
              setContent(event.target.value)
              setPreview(null)
            }}
          />
        </Field>

        {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}

        {preview ? (
          <div className="space-y-2">
            <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
              {t('webssh.import.summary', { count: preview.candidates.length, rejected: preview.rejected })}
            </p>
            {preview.candidates.length === 0 ? (
              <Empty art="search" compact title={t('webssh.import.empty')} />
            ) : (
              <div className="max-h-[320px] overflow-auto rounded-[var(--r-md)] border border-[var(--border-subtle)]">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="sticky top-0 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] text-[length:var(--text-11)] uppercase tracking-wide text-[var(--text-quaternary)]">
                      <th className="w-8 px-2 py-1.5">
                        <span className="sr-only">{t('webssh.import.commit')}</span>
                      </th>
                      <th className="px-2 py-1.5 font-medium">{t('webssh.import.column_name')}</th>
                      <th className="px-2 py-1.5 font-medium">{t('webssh.import.column_host')}</th>
                      <th className="px-2 py-1.5 font-medium">{t('webssh.import.column_port')}</th>
                      <th className="hidden px-2 py-1.5 font-medium sm:table-cell">{t('webssh.import.column_username')}</th>
                      <th className="hidden px-2 py-1.5 font-medium sm:table-cell">{t('webssh.import.column_status')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-subtle)]">
                    {preview.candidates.map((candidate, index) => {
                      const ready = candidate.issues.length === 0
                      return (
                        <tr key={`${candidate.name}-${candidate.host}-${index}`} className={ready ? '' : 'opacity-70'}>
                          <td className="px-2 py-1.5">
                            <input
                              type="checkbox"
                              aria-label={candidate.name}
                              checked={ready && !deselected.has(index)}
                              disabled={!ready}
                              onChange={(event) => {
                                setDeselected((current) => {
                                  const next = new Set(current)
                                  if (event.target.checked) next.delete(index)
                                  else next.add(index)
                                  return next
                                })
                              }}
                            />
                          </td>
                          <td className="px-2 py-1.5 text-[length:var(--text-12)] text-[var(--text-primary)]">{candidate.name}</td>
                          <td className="px-2 py-1.5 font-mono text-[length:var(--text-11-5)] text-[var(--text-secondary)]">{candidate.host}</td>
                          <td className="tabular px-2 py-1.5 text-[length:var(--text-11-5)] text-[var(--text-secondary)]">{candidate.port}</td>
                          <td className="hidden px-2 py-1.5 text-[length:var(--text-11-5)] text-[var(--text-secondary)] sm:table-cell">{candidate.username}</td>
                          <td className="hidden px-2 py-1.5 sm:table-cell">
                            {ready ? (
                              <span className="text-[length:var(--text-11)] text-[var(--success)]">{t('webssh.import.status_ready')}</span>
                            ) : (
                              <span className="text-[length:var(--text-11)] text-[var(--danger)]">
                                {candidate.issues.map(issueText).join(' · ')}
                              </span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {preview.candidates.length > 0 && (
              <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                {t('webssh.import.commit')}: {chosenCount}
              </p>
            )}
          </div>
        ) : (
          <Empty art="select" compact title={t('webssh.import.empty')} />
        )}
      </div>
    </Modal>
  )
}
