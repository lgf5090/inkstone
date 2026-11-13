import { useEffect, useState, type ReactElement } from 'react'
import { SquareKanban } from 'lucide-react'
import { t } from '../../lib/i18n'
import { navigateToAddress } from '../../lib/app-history'
import { Input } from '../../components/form'
import { Modal } from '../../components/overlay'
import { Button } from '../../components/primitives'
import { LoadingBlock } from '../../components/feedback'
import { searchProject, type ProjectSearchResult } from './api'

export function SearchDialog({ onClose }: { onClose: () => void }): ReactElement {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<ProjectSearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const trimmed = query.trim()
    setFailed(false)
    if (!trimmed) { setResult(null); return }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setLoading(true)
      searchProject(trimmed, controller.signal)
        .then(setResult)
        .catch(() => { if (!controller.signal.aborted) { setFailed(true); setResult(null) } })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, 200)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [query, attempt])

  const go = (path: string, search = '') => { onClose(); navigateToAddress(path, search) }

  return (
    <Modal open onClose={onClose} title={t('project.search.title')} width={560}>
      <div className="space-y-3">
        <Input className="w-full" value={query} placeholder={t('project.search.placeholder')} aria-label={t('project.search.placeholder')} onChange={(event) => setQuery(event.target.value)} data-autofocus />
        {loading && <LoadingBlock />}
        {!loading && failed && (
          <div className="space-y-2">
            <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{t('project.common.load_failed')}</p>
            <Button size="sm" onClick={() => setAttempt((current) => current + 1)}>{t('project.common.retry')}</Button>
          </div>
        )}
        {!loading && !failed && result && result.boards.length === 0 && result.cards.length === 0 && (
          <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.search.no_results')}</p>
        )}
        {!loading && result && result.boards.length > 0 && (
          <section aria-label={t('project.search.boards')}>
            <h3 className="mb-1 text-[length:var(--text-11)] font-semibold uppercase text-[var(--text-tertiary)]">{t('project.search.boards')}</h3>
            <ul className="space-y-0.5">
              {result.boards.map((board) => (
                <li key={board.id}>
                  <button type="button" className="flex w-full items-center gap-2 rounded-[var(--r-sm)] px-2 py-1 text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={() => go(`/project/boards/${board.id}`)}>
                    <span aria-hidden="true">{board.icon || <SquareKanban size={14} className="text-[var(--text-quaternary)]" />}</span>
                    <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)] text-[var(--text-primary)]">{board.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {!loading && result && result.cards.length > 0 && (
          <section aria-label={t('project.search.cards')}>
            <h3 className="mb-1 text-[length:var(--text-11)] font-semibold uppercase text-[var(--text-tertiary)]">{t('project.search.cards')}</h3>
            <ul className="space-y-0.5">
              {result.cards.map((card) => (
                <li key={card.id}>
                  <button type="button" className="flex w-full items-center gap-2 rounded-[var(--r-sm)] px-2 py-1 text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={() => go(`/project/boards/${card.boardId}`, `card=${encodeURIComponent(card.id)}`)}>
                    <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)] text-[var(--text-primary)]">{card.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Modal>
  )
}