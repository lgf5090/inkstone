import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { ArrowLeft, Plus, SquareKanban, Trash2 } from 'lucide-react'
import type { ProjectBoardBundle } from '@shared/project/model'
import { projectRoleAtLeast } from '@shared/project/model'
import { t } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import { Button, IconButton } from '../../components/primitives'
import { Input } from '../../components/form'
import { Empty, LoadingBlock } from '../../components/feedback'
import { confirm } from '../../components/overlay'
import { createProjectCard, deleteProjectCard, fetchProjectBoardBundle } from './api'

type Status = 'loading' | 'ready' | 'error' | 'notfound'

export function BoardPage({ boardId }: { boardId: string }): ReactElement {
  const [bundle, setBundle] = useState<ProjectBoardBundle | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')
    setError(null)
    fetchProjectBoardBundle(boardId, controller.signal)
      .then((result) => {
        setBundle(result)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        const isNotFound = typeof err === 'object' && err !== null && 'status' in err && (err as { status: number }).status === 404
        setStatus(isNotFound ? 'notfound' : 'error')
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => controller.abort()
  }, [boardId])

  const addCard = useCallback(async () => {
    const trimmed = title.trim()
    if (!trimmed || busy || !bundle) return
    setBusy(true)
    try {
      const card = await createProjectCard(boardId, { title: trimmed })
      setBundle((current) => (current ? { ...current, cards: [...current.cards, card] } : current))
      setTitle('')
    } finally {
      setBusy(false)
    }
  }, [title, busy, bundle, boardId])

  const removeCard = useCallback(async (cardId: string) => {
    const ok = await confirm({ title: t('project.board.delete_card'), tone: 'danger', confirmLabel: t('project.boards.delete_confirm') })
    if (!ok) return
    await deleteProjectCard(cardId)
    setBundle((current) => (current ? { ...current, cards: current.cards.filter((card) => card.id !== cardId) } : current))
  }, [])

  if (status === 'loading') return <LoadingBlock />
  if (status === 'notfound') return <Empty art="select" title={t('project.board.not_found')} action={<Button onClick={() => navigateToPath('/project')}>{t('project.board.back')}</Button>} />
  if (status === 'error' || !bundle) {
    return <Empty art="select" title={t('project.board.load_failed')} description={error ?? undefined} action={<Button onClick={() => navigateToPath('/project')}>{t('project.board.back')}</Button>} />
  }

  const canEdit = projectRoleAtLeast(bundle.role, 'editor')
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]" data-project-board-page={boardId}>
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <IconButton label={t('project.board.back')} size="sm" onClick={() => navigateToPath('/project')}>
          <ArrowLeft size={16} />
        </IconButton>
        <span aria-hidden="true" className="flex size-7 items-center justify-center rounded-[var(--r-md)] bg-[var(--accent-soft)] text-[length:var(--text-14)]">
          {bundle.board.icon || <SquareKanban size={16} className="text-[var(--accent-on-soft)]" />}
        </span>
        <h1 className="min-w-0 truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {bundle.board.title || t('project.boards.untitled')}
        </h1>
        <span className="ml-auto shrink-0 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {t('project.board.cards_count', { count: bundle.cards.length })}
        </span>
      </header>
      {canEdit && (
        <form
          className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2"
          onSubmit={(event) => {
            event.preventDefault()
            void addCard()
          }}
        >
          <Input
            className="min-w-0 flex-1"
            value={title}
            placeholder={t('project.board.card_placeholder')}
            aria-label={t('project.board.card_placeholder')}
            onChange={(event) => setTitle(event.target.value)}
          />
          <Button type="submit" variant="primary" disabled={busy || !title.trim()} icon={<Plus size={15} />}>
            {t('project.board.new_card')}
          </Button>
        </form>
      )}
      {bundle.cards.length === 0
        ? <Empty art="folder" title={t('project.board.empty_cards')} />
        : (
            <ul className="min-h-0 flex-1 overflow-y-auto" aria-label={t('project.board.title_column')}>
              {bundle.cards.map((card) => (
                <li key={card.id} className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2" data-project-card={card.id}>
                  <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center text-[length:var(--text-14)]">
                    {card.icon || <SquareKanban size={15} className="text-[var(--text-quaternary)]" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)] text-[var(--text-primary)]">
                    {card.title || t('project.board.untitled_card')}
                  </span>
                  {canEdit && (
                    <IconButton label={t('project.board.delete_card')} size="sm" onClick={() => void removeCard(card.id)}>
                      <Trash2 size={15} />
                    </IconButton>
                  )}
                </li>
              ))}
            </ul>
          )}
    </div>
  )
}