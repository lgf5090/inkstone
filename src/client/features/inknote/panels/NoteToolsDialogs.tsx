/** Find/replace, outline and statistics over the pages the editor already holds. */
import { useEffect, useMemo, useState } from 'react'
import type { InknoteNoteMeta, InknotePage } from '@shared/inknote/types'
import { HIGHLIGHTER_COLORS } from '@shared/inknote/constants'
import { t } from '../../../lib/i18n'
import { Button } from '../../../components/primitives'
import { Modal } from '../../../components/overlay'
import { Input } from '../../../components/form'
import { LoadingBlock } from '../../../components/feedback'
import { countsOfPages, findPageText, highlightPageText, outlineOfPages, replacePageText } from '../../../lib/inknote/note-search'
import { useInknoteStore } from '../store'
import { useUi } from '../../../store/ui'
import { inknoteApi } from '../api'

interface ToolProps {
  open: boolean
  onClose: () => void
  pages: InknotePage[]
  onJump: (pageId: string) => void
}

export function FindDialog({ open, onClose, pages, onJump }: ToolProps) {
  const replacePageContent = useInknoteStore((state) => state.replacePageContent)
  const savePage = useInknoteStore((state) => state.savePage)
  const toast = useUi((state) => state.toast)
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [busy, setBusy] = useState(false)
  const matches = useMemo(() => findPageText(pages, query), [pages, query])

  const applyPages = async (next: InknotePage[], changedPageIds: string[]): Promise<void> => {
    setBusy(true)
    try {
      for (const id of changedPageIds) {
        const page = next.find((entry) => entry.id === id)
        if (page) replacePageContent(page.id, page.content)
        await savePage(id)
      }
    } finally {
      setBusy(false)
    }
  }

  const replaceAll = async () => {
    const result = replacePageText(pages, query, replacement)
    if (result.count === 0) { toast({ title: t('inknote.find.no_results') }); return }
    await applyPages(result.pages, result.changedPageIds)
    toast({ title: t('inknote.find.replaced', { count: String(result.count) }) })
  }

  const highlight = async (color: string | null) => {
    const result = highlightPageText(pages, query, color)
    if (result.count === 0) { toast({ title: t('inknote.find.no_results') }); return }
    await applyPages(result.pages, result.changedPageIds)
  }

  return (
    <Modal open={open} onClose={onClose} title={t('inknote.find.title')} width={520}>
      <div className="space-y-2">
        <Input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('inknote.find.placeholder')} aria-label={t('inknote.find.placeholder')}/>
        <div className="flex gap-2">
          <Input value={replacement} onChange={(event) => setReplacement(event.target.value)} placeholder={t('inknote.find.replace')} aria-label={t('inknote.find.replace')}/>
          <Button size="sm" onClick={() => void replaceAll()} disabled={busy || !query.trim()}>{t('inknote.find.replace_all')}</Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void highlight(HIGHLIGHTER_COLORS[0]!)} disabled={busy || !query.trim()}>{t('inknote.find.highlight_all')}</Button>
          <Button size="sm" onClick={() => void highlight(null)} disabled={busy}>{t('inknote.find.clear_highlight')}</Button>
          <span className="self-center text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('inknote.find.result_count', { count: String(matches.length) })}</span>
        </div>
        <div className="max-h-64 overflow-y-auto rounded-[var(--r-sm)] border border-[var(--border-subtle)]">
          {matches.length === 0 && <p className="py-4 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('inknote.find.no_results')}</p>}
          {matches.map((match, index) => (
            <button key={`${match.textId}:${match.start}:${index}`} type="button" onClick={() => onJump(match.pageId)} className="block w-full border-b border-[var(--border-subtle)] px-2 py-1.5 text-left last:border-b-0 hover:bg-[var(--bg-hover)]">
              <span className="me-2 text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">{match.pageIndex + 1}</span>
              <span className="text-[length:var(--text-12)]">{match.snippet}</span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}

export function OutlineDialog({ open, onClose, pages, onJump }: ToolProps) {
  const entries = useMemo(() => outlineOfPages(pages), [pages])
  return (
    <Modal open={open} onClose={onClose} title={t('inknote.outline.title')} width={520}>
      <div className="max-h-80 overflow-y-auto">
        {entries.length === 0 && <p className="py-4 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('inknote.outline.empty')}</p>}
        {entries.map((entry, index) => (
          <button key={`${entry.textId}:${index}`} type="button" onClick={() => onJump(entry.pageId)} className="flex w-full items-baseline gap-2 border-b border-[var(--border-subtle)] px-2 py-1.5 text-left last:border-b-0 hover:bg-[var(--bg-hover)]" style={{ paddingInlineStart: entry.level === 1 ? 8 : 24 }}>
            <span className="truncate text-[length:var(--text-12)]" style={{ fontWeight: entry.level === 1 ? 600 : 400 }}>{entry.text}</span>
            <span className="ms-auto shrink-0 text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">{entry.pageIndex + 1}</span>
          </button>
        ))}
      </div>
    </Modal>
  )
}

export function StatsDialog({ open, onClose, note, pages }: Omit<ToolProps, 'onJump'> & { note: InknoteNoteMeta | null }) {
  const counts = useMemo(() => countsOfPages(pages), [pages])
  const [recordings, setRecordings] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open || !note) return
    let cancelled = false
    setError(null)
    setRecordings(null)
    inknoteApi.recordings(note.id).then((response) => {
      if (!cancelled) setRecordings(response.recordings.length)
    }).catch((reason: unknown) => {
      if (!cancelled) setError(String(reason))
    })
    return () => { cancelled = true }
  }, [open, note?.id])
  const rows: { label: string; value: string }[] = [
    { label: t('inknote.stats.pages'), value: String(counts.pages) },
    { label: t('inknote.stats.strokes'), value: String(counts.strokes) },
    { label: t('inknote.stats.texts'), value: String(counts.texts) },
    { label: t('inknote.stats.images'), value: String(counts.images) },
    { label: t('inknote.stats.recordings'), value: error ?? (recordings === null ? '…' : String(recordings)) },
    { label: t('inknote.stats.created'), value: note ? new Date(note.createdAt).toLocaleString() : '—' },
    { label: t('inknote.stats.updated'), value: note ? new Date(note.updatedAt).toLocaleString() : '—' },
  ]
  return (
    <Modal open={open} onClose={onClose} title={t('inknote.stats.title')} width={420}>
      {recordings === null && !error ? <LoadingBlock /> : (
        <dl className="grid grid-cols-2 gap-1 text-[length:var(--text-12)]">
          {rows.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-[var(--text-tertiary)]">{row.label}</dt>
              <dd className="text-end tabular-nums">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </Modal>
  )
}
