/**
 * The version history of one snippet, in place rather than in a dialog.
 *
 * The list is the left column and the diff is the page: selecting a version reads it, reads the one
 * before it, and draws the lines that version itself added or removed, the way a commit reads on
 * GitHub. The line counts on the list come from the server, written once when the version was made,
 * so opening the panel does not re-diff the whole history. Restoring is a new version, never a
 * rewind; the way forward stays readable.
 */
import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Copy, RotateCcw, Wand2 } from 'lucide-react'
import { diffLines } from 'diff'
import type {
  ScriptRevisionMeta,
  ScriptRevisionSnapshot,
  ScriptSnippetDetail,
  ScriptFile,
} from '@shared/scriptshub/types'
import { t } from '../../lib/i18n'
import { relativeTime, fullTime } from '../../lib/time'
import { cn } from '../../lib/cn'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { confirm, Tooltip } from '../../components/overlay'
import { copyText } from '../../lib/clipboard'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { scriptshubApi } from './api'
import { useScriptsHub } from './store'

const SOURCE_KEYS = {
  create: 'scriptshub.revisions.source_create',
  save: 'scriptshub.revisions.source_save',
  restore: 'scriptshub.revisions.source_restore',
  import: 'scriptshub.revisions.source_import',
  overwrite: 'scriptshub.revisions.source_overwrite',
} as const

const MAX_DIFF_LINES = 900

type DiffLine = { kind: 'context' | 'added' | 'removed', oldLine: number | null, newLine: number | null, text: string }

function buildDiff(before: string, after: string): { rows: DiffLine[]; added: number; removed: number; truncated: number } {
  const rows: DiffLine[] = []
  let oldLine = 1
  let newLine = 1
  let added = 0
  let removed = 0
  let truncated = 0
  for (const part of diffLines(before, after)) {
    const lines = part.value.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    if (part.removed) {
      for (const text of lines) {
        removed += 1
        if (rows.length < MAX_DIFF_LINES) rows.push({ kind: 'removed', oldLine: oldLine++, newLine: null, text })
        else truncated += 1
      }
    } else if (part.added) {
      for (const text of lines) {
        added += 1
        if (rows.length < MAX_DIFF_LINES) rows.push({ kind: 'added', oldLine: null, newLine: newLine++, text })
        else truncated += 1
      }
    } else {
      for (const text of lines) {
        if (rows.length < MAX_DIFF_LINES) rows.push({ kind: 'context', oldLine: oldLine++, newLine: newLine++, text })
        else truncated += 1
      }
    }
  }
  return { rows, added, removed, truncated }
}

function fileChanges(previous: ScriptFile | null, current: ScriptFile | null): { added: number; removed: number } {
  if (!previous) return { added: current ? current.content.replace(/\n$/, '').split('\n').length : 0, removed: 0 }
  if (!current) return { added: 0, removed: previous.content.replace(/\n$/, '').split('\n').length }
  let added = 0
  let removed = 0
  for (const part of diffLines(previous.content, current.content)) {
    const count = part.value ? part.value.replace(/\n$/, '').split('\n').length : 0
    if (part.added) added += count
    else if (part.removed) removed += count
  }
  return { added, removed }
}

export function RevisionsPanel({ detail, activeFileId, onClose }: {
  detail: ScriptSnippetDetail
  activeFileId: string | null
  onClose: () => void
}) {
  const toast = useUi((state) => state.toast)
  const user = useSession((state) => state.user)
  const [revisions, setRevisions] = useState<ScriptRevisionMeta[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [snapshot, setSnapshot] = useState<ScriptRevisionSnapshot | null>(null)
  const [previous, setPrevious] = useState<ScriptRevisionSnapshot | null>(null)
  const [fileId, setFileId] = useState<string | null>(activeFileId)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)
  const author = user?.name || user?.username || t('scriptshub.revisions.author_you')

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    setSnapshot(null)
    setPrevious(null)
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
  }, [detail.id])

  useEffect(() => {
    if (selected === null) return
    let alive = true
    setLoading(true)
    setError(null)
    void Promise.all([
      scriptshubApi.readRevision(detail.id, selected),
      selected > 1 ? scriptshubApi.readRevision(detail.id, selected - 1) : Promise.resolve(null),
    ]).then(([read, prior]) => {
      if (!alive) return
      setSnapshot(read)
      setPrevious(prior)
      setFileId((current) => {
        if (current && read.files.some((file) => file.id === current)) return current
        return read.files.find((file) => file.id === activeFileId)?.id ?? read.files[0]?.id ?? null
      })
    }).catch((readError: unknown) => {
      if (alive) setError(readError instanceof Error ? readError.message : String(readError))
    }).finally(() => {
      if (alive) setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [activeFileId, detail.id, selected])

  const currentFile = snapshot?.files.find((file) => file.id === fileId) ?? snapshot?.files[0] ?? null
  const previousFile = currentFile
    ? previous?.files.find((entry) => entry.id === currentFile.id) ?? null
    : null
  const diff = useMemo(
    () => currentFile ? buildDiff(previousFile?.content ?? '', currentFile.content) : null,
    [currentFile, previousFile],
  )

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
      toast({ title: t('scriptshub.revisions.restored'), tone: 'success' })
      onClose()
    } catch (restoreError) {
      toast({
        title: t('scriptshub.revisions.restore_failed'),
        description: restoreError instanceof Error ? restoreError.message : String(restoreError),
        tone: 'danger',
      })
    } finally {
      setRestoring(false)
    }
  }

  const copyVersion = async () => {
    if (!currentFile) return
    const ok = await copyText(currentFile.content)
    toast({ title: ok ? t('scriptshub.editor.copied') : t('scriptshub.common.copy_failed'), tone: ok ? 'success' : 'danger' })
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]">
      <header className="flex h-11 shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] px-3">
        <IconButton label={t('scriptshub.revisions.back_to_code')} onClick={onClose}>
          <ArrowLeft size={15} aria-hidden="true" />
        </IconButton>
        <Wand2 size={14} aria-hidden="true" className="text-[var(--accent)]" />
        <h2 className="min-w-0 flex-1 truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {t('scriptshub.revisions.title')}
        </h2>
        <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
          {t('scriptshub.revisions.count', { count: revisions.length })}
        </span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="max-h-[40%] shrink-0 overflow-y-auto border-b border-[var(--border-subtle)] p-1.5 md:max-h-none md:w-[262px] md:border-r md:border-b-0">
          {loading && revisions.length === 0 && <div className="flex justify-center py-6"><Spinner size={16} /></div>}
          {!loading && revisions.length === 0 && (
            <p className="px-2 py-6 text-center text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('scriptshub.revisions.empty')}</p>
          )}
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
                <span className="min-w-0 flex-1 truncate">{t('scriptshub.revisions.version', { version: revision.version })}</span>
                {(revision.added > 0 || revision.removed > 0) && (
                  <span className="shrink-0 tabular text-[length:var(--text-10)]">
                    <span className="text-[var(--success)]">+{revision.added}</span>
                    {' '}
                    <span className="text-[var(--danger)]">−{revision.removed}</span>
                  </span>
                )}
              </span>
              <span className="truncate text-[length:var(--text-10)] text-[var(--text-quaternary)]">
                <Tooltip label={fullTime(revision.createdAt)} side="bottom">
                  <span>{relativeTime(revision.createdAt)}</span>
                </Tooltip>
                {' · '}{author}{' · '}{t(SOURCE_KEYS[revision.source])}
              </span>
              {revision.description && (
                <span className="truncate text-[length:var(--text-10)] text-[var(--text-quaternary)]">{revision.description}</span>
              )}
            </button>
          ))}
        </aside>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {error && <p role="alert" className="px-3 py-2 text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
          {snapshot && (
            <>
              <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--border-subtle)] px-3 py-2">
                {snapshot.files.map((file) => {
                  const counts = fileChanges(
                    previous?.files.find((entry) => entry.id === file.id) ?? null,
                    file,
                  )
                  return (
                    <button
                      key={file.id}
                      type="button"
                      onClick={() => setFileId(file.id)}
                      aria-pressed={file.id === currentFile?.id}
                      className={cn(
                        'flex items-center gap-1.5 rounded-[var(--r-sm)] px-2 py-1 text-[length:var(--text-11)]',
                        file.id === currentFile?.id ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]',
                      )}
                    >
                      <span className="max-w-[180px] truncate">{file.name}</span>
                      {(counts.added > 0 || counts.removed > 0) && (
                        <span className="tabular text-[length:var(--text-10)]">
                          <span className="text-[var(--success)]">+{counts.added}</span>
                          {' '}
                          <span className="text-[var(--danger)]">−{counts.removed}</span>
                        </span>
                      )}
                    </button>
                  )
                })}
                <div className="ml-auto flex items-center gap-1">
                  <Button size="sm" variant="ghost" icon={<Copy size={12} aria-hidden="true" />} onClick={() => void copyVersion()}>
                    {t('scriptshub.revisions.copy_body')}
                  </Button>
                  <Button size="sm" variant="secondary" loading={restoring} icon={<RotateCcw size={12} aria-hidden="true" />} onClick={() => void restore()}>
                    {t('scriptshub.revisions.restore')}
                  </Button>
                </div>
              </div>
              {loading && !diff && <div className="flex flex-1 items-center justify-center"><Spinner size={16} /></div>}
              {diff && diff.rows.length === 0 && (
                <p className="m-3 rounded-[var(--r-md)] bg-[var(--bg-raised)] p-3 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
                  {t('scriptshub.revisions.identical')}
                </p>
              )}
              {diff && diff.rows.length > 0 && (
                <div className="min-h-0 flex-1 overflow-auto bg-[var(--bg-inset)]">
                  <table className="w-full border-collapse font-mono text-[length:var(--text-11-5)]">
                    <tbody>
                      {diff.rows.map((row, index) => (
                        <tr
                          key={index}
                          className={cn(
                            row.kind === 'added' ? 'bg-[color-mix(in_oklab,var(--success)_12%,transparent)]' : row.kind === 'removed' ? 'bg-[var(--danger-soft)]' : undefined,
                          )}
                        >
                          <td className="w-10 select-none border-r border-[var(--border-subtle)] px-1.5 text-right align-top tabular text-[var(--text-quaternary)]">{row.oldLine ?? ''}</td>
                          <td className="w-10 select-none border-r border-[var(--border-subtle)] px-1.5 text-right align-top tabular text-[var(--text-quaternary)]">{row.newLine ?? ''}</td>
                          <td className={cn('w-4 select-none px-1 align-top', row.kind === 'added' ? 'text-[var(--success)]' : row.kind === 'removed' ? 'text-[var(--danger)]' : 'text-transparent')}>
                            {row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ''}
                          </td>
                          <td className="whitespace-pre-wrap break-all px-1 align-top text-[var(--text-primary)]">{row.text || ' '}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {diff.truncated > 0 && (
                    <p className="px-3 py-2 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                      {t('scriptshub.revisions.truncated', { count: diff.truncated })}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
          {!snapshot && !error && (
            <div className="flex flex-1 items-center justify-center"><Spinner size={16} /></div>
          )}
        </main>
      </div>
    </div>
  )
}
