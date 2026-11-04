/**
 * The version history of one snippet.
 *
 * Every save writes a full snapshot, so a version can restore a file a later save deleted. The list
 * is metadata only; the body is read for the one version selected. The preview is the shared write
 * diff used by the assistant, with the older version on the left and the current text on the right.
 */
import { useEffect, useMemo, useState } from 'react'
import { History, Loader2, RotateCcw } from 'lucide-react'
import type { ScriptRevisionMeta, ScriptRevisionSnapshot, ScriptSnippetDetail } from '@shared/scriptshub/types'
import { t } from '../../lib/i18n'
import { relativeTime } from '../../lib/time'
import { cn } from '../../lib/cn'
import { Button, Spinner } from '../../components/primitives'
import { Modal, confirm } from '../../components/overlay'
import { buildWriteDiff, WriteDiffView } from '../chat/editor-ai-diff'
import { scriptshubApi } from './api'
import { useScriptsHub } from './store'

const MAX_DIFF_CHARS = 60_000

const SOURCE_KEYS = {
  create: 'scriptshub.revisions.source_create',
  save: 'scriptshub.revisions.source_save',
  restore: 'scriptshub.revisions.source_restore',
  import: 'scriptshub.revisions.source_import',
  overwrite: 'scriptshub.revisions.source_overwrite',
} as const

export function RevisionsDialog({ open, detail, activeFileId, onClose }: {
  open: boolean
  detail: ScriptSnippetDetail
  activeFileId: string | null
  onClose: () => void
}) {
  const [revisions, setRevisions] = useState<ScriptRevisionMeta[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [snapshot, setSnapshot] = useState<ScriptRevisionSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setError(null)
    setSnapshot(null)
    void scriptshubApi.revisions(detail.id).then((response) => {
      if (!alive) return
      setRevisions(response.revisions)
      setSelected(response.revisions[0]?.version ?? null)
    }).catch((loadError: unknown) => {
      if (alive) setError(loadError instanceof Error ? loadError.message : String(loadError))
    }).finally(() => {
      if (alive) setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [open, detail.id])

  useEffect(() => {
    if (!open || selected === null) return
    let alive = true
    setLoading(true)
    setError(null)
    void scriptshubApi.readRevision(detail.id, selected).then((read) => {
      if (alive) setSnapshot(read)
    }).catch((readError: unknown) => {
      if (alive) setError(readError instanceof Error ? readError.message : String(readError))
    }).finally(() => {
      if (alive) setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [open, detail.id, selected])

  const file = useMemo(() => {
    if (!snapshot) return null
    const id = activeFileId ?? detail.files[0]?.id
    return snapshot.files.find((entry) => entry.id === id)
      ?? snapshot.files.find((entry) => entry.name === detail.files[0]?.name)
      ?? snapshot.files[0]
      ?? null
  }, [snapshot, activeFileId, detail.files])

  const current = detail.files.find((entry) => entry.id === file?.id) ?? detail.files[0] ?? null
  const diff = useMemo(() => {
    if (!file || !current) return null
    if (file.content.length > MAX_DIFF_CHARS || current.content.length > MAX_DIFF_CHARS) return 'too-long' as const
    return buildWriteDiff(file.content, current.content)
  }, [file, current])

  const restore = async () => {
    if (selected === null) return
    const agreed = await confirm({
      title: t('scriptshub.revisions.restore_title', { version: selected }),
      description: t('scriptshub.revisions.restore_body'),
      confirmLabel: t('scriptshub.revisions.restore'),
    })
    if (!agreed) return
    setRestoring(true)
    try {
      await scriptshubApi.restoreRevision(detail.id, selected)
      await useScriptsHub.getState().select(detail.id)
      onClose()
    } finally {
      setRestoring(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('scriptshub.revisions.title')}
      description={t('scriptshub.revisions.description')}
      width={880}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('scriptshub.common.close')}</Button>
          <Button variant="primary" loading={restoring} disabled={selected === null} icon={<RotateCcw size={12} aria-hidden="true" />} onClick={() => void restore()}>
            {t('scriptshub.revisions.restore')}
          </Button>
        </>
      )}
    >
      <div className="grid gap-3 md:grid-cols-[210px_minmax(0,1fr)]">
        <div className="max-h-[52vh] space-y-1 overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] p-1.5">
          {loading && revisions.length === 0 && <div className="flex justify-center py-6"><Spinner size={16} /></div>}
          {revisions.length === 0 && !loading && <p className="px-2 py-6 text-center text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('scriptshub.revisions.empty')}</p>}
          {revisions.map((revision) => (
            <button
              key={revision.version}
              type="button"
              onClick={() => setSelected(revision.version)}
              aria-pressed={selected === revision.version}
              className={cn(
                'flex w-full flex-col gap-0.5 rounded-[var(--r-sm)] px-2 py-1.5 text-left',
                selected === revision.version ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
              )}
            >
              <span className="flex items-center gap-1.5 text-[length:var(--text-11-5)] font-medium">
                <History size={11} aria-hidden="true" />
                {t('scriptshub.revisions.version', { version: revision.version })}
              </span>
              <span className="text-[length:var(--text-10)] text-[var(--text-quaternary)]">
                {relativeTime(revision.createdAt)} · {t(SOURCE_KEYS[revision.source])}
              </span>
              <span className="text-[length:var(--text-10)] text-[var(--text-quaternary)]">
                {t('scriptshub.revisions.files_chars', { files: revision.fileCount, chars: revision.charCount })}
              </span>
            </button>
          ))}
        </div>
        <div className="min-w-0 space-y-2">
          {error && <p className="text-[length:var(--text-12)] text-[var(--danger)]" role="alert">{error}</p>}
          {snapshot && file && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                <span className="font-medium text-[var(--text-secondary)]">{file.name}</span>
                <span>{file.language}</span>
                {snapshot.title !== detail.title && <span>· {snapshot.title}</span>}
              </div>
              {diff === 'too-long' ? (
                <p className="rounded-[var(--r-md)] bg-[var(--bg-raised)] p-3 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('scriptshub.revisions.too_large')}</p>
              ) : diff && diff.changed ? (
                <WriteDiffView diff={diff} />
              ) : (
                <p className="rounded-[var(--r-md)] bg-[var(--bg-raised)] p-3 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('scriptshub.revisions.identical')}</p>
              )}
            </>
          )}
          {loading && snapshot && <div className="flex items-center gap-2 text-[length:var(--text-11)] text-[var(--text-quaternary)]"><Loader2 size={12} aria-hidden="true" />{t('scriptshub.common.loading')}</div>}
        </div>
      </div>
    </Modal>
  )
}
