/**
 * What this account deleted, and the way back.
 *
 * Deletes are soft everywhere in this app, so the rows are still there — until now nothing listed
 * them, which made a delete permanent in practice. Boards are listed for their owner and cards for
 * a board admin, the same roles the restore routes themselves require.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { RotateCcw, SquareKanban } from 'lucide-react'
import type { ProjectBoardSummary } from '@shared/project/model'
import { t } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import { Button, IconButton } from '../../components/primitives'
import { Modal } from '../../components/overlay'
import { LoadingBlock } from '../../components/feedback'
import { useUi } from '../../store/ui'
import { fetchBoardTrash, fetchProjectTrash, restoreProjectBoard, undeleteProjectCard, type DeletedProjectCard } from './api'

export function TrashDialog({ boardId, onClose, onRestored }: {
  boardId?: string
  onClose: () => void
  onRestored: () => void
}): ReactElement {
  const [boards, setBoards] = useState<ProjectBoardSummary[] | null>(null)
  const [cards, setCards] = useState<DeletedProjectCard[] | null>(null)
  const [busy, setBusy] = useState(false)
  const toast = useUi((state) => state.toast)

  const load = useCallback(async (signal?: AbortSignal) => {
    if (boardId) setCards(await fetchBoardTrash(boardId, signal))
    else setBoards(await fetchProjectTrash(signal))
  }, [boardId])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal).catch((reason: unknown) => {
      if (controller.signal.aborted) return
      toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' })
      if (boardId) setCards([])
      else setBoards([])
    })
    return () => controller.abort()
  }, [load, boardId, toast])

  const restore = async (action: () => Promise<void>) => {
    setBusy(true)
    try {
      await action()
      await load()
      onRestored()
    } catch (reason) {
      toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const loading = boardId ? cards === null : boards === null
  const empty = boardId ? (cards ?? []).length === 0 : (boards ?? []).length === 0

  return (
    <Modal open onClose={onClose} title={t('project.trash.title')} width={480}>
      <div className="space-y-2" data-project-trash={boardId ?? 'boards'}>
        {loading
          ? <LoadingBlock />
          : empty
            ? <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.trash.empty')}</p>
            : (
              <ul className="space-y-1">
                {boardId
                  ? (cards ?? []).map((card) => (
                    <li key={card.id} className="flex items-center gap-2" data-trash-card={card.id}>
                      <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)] text-[var(--text-primary)]">{card.title || t('project.board.untitled_card')}</span>
                      <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{new Date(card.deleteAt).toLocaleDateString()}</span>
                      <IconButton label={`${t('project.trash.restore')}: ${card.title}`} size="sm" disabled={busy} onClick={() => { void restore(() => undeleteProjectCard(card.id)) }}>
                        <RotateCcw size={14} />
                      </IconButton>
                    </li>
                  ))
                  : (boards ?? []).map((board) => (
                    <li key={board.id} className="flex items-center gap-2" data-trash-board={board.id}>
                      <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center text-[length:var(--text-12)]">
                        {board.icon || <SquareKanban size={13} className="text-[var(--text-quaternary)]" />}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)] text-[var(--text-primary)]">{board.title || t('project.boards.untitled')}</span>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void restore(async () => { await restoreProjectBoard(board.id); onClose(); navigateToPath(`/project/boards/${board.id}`) }) }}>
                        {t('project.trash.restore')}
                      </Button>
                    </li>
                  ))}
              </ul>
            )}
      </div>
    </Modal>
  )
}