/**
 * What this account archived, and the way back.
 *
 * Archiving hides a board from the live list without deleting it, so the rows are still whole. Only
 * the owner archives and restores, the same role the write itself requires.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { ArchiveRestore, SquareKanban } from 'lucide-react'
import type { ProjectBoardSummary } from '@shared/project/model'
import { t } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import { Button, IconButton } from '../../components/primitives'
import { Modal } from '../../components/overlay'
import { LoadingBlock } from '../../components/feedback'
import { useUi } from '../../store/ui'
import { useProjectStore } from './store'
import { fetchArchivedBoards } from './api'

export function ArchiveDialog({ onClose, onRestored }: {
  onClose: () => void
  onRestored: () => void
}): ReactElement {
  const [boards, setBoards] = useState<ProjectBoardSummary[] | null>(null)
  const [busy, setBusy] = useState(false)
  const toast = useUi((state) => state.toast)
  const setBoardArchived = useProjectStore((state) => state.setBoardArchived)

  const load = useCallback(async (signal?: AbortSignal) => {
    setBoards(await fetchArchivedBoards(signal))
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal).catch((reason: unknown) => {
      if (controller.signal.aborted) return
      toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' })
      setBoards([])
    })
    return () => controller.abort()
  }, [load, toast])

  const restore = async (board: ProjectBoardSummary) => {
    setBusy(true)
    try {
      await setBoardArchived(board.id, false)
      onRestored()
      onClose()
      navigateToPath(`/project/boards/${board.id}`)
    } catch (reason) {
      toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={t('project.archive.title')} width={480}>
      <div className="space-y-2" data-project-archive="">
        {boards === null
          ? <LoadingBlock />
          : boards.length === 0
            ? <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.archive.empty')}</p>
            : (
              <ul className="space-y-1">
                {boards.map((board) => (
                  <li key={board.id} className="flex items-center gap-2" data-archived-board={board.id}>
                    <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center text-[length:var(--text-12)]">
                      {board.icon || <SquareKanban size={13} className="text-[var(--text-quaternary)]" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)] text-[var(--text-primary)]">{board.title || t('project.boards.untitled')}</span>
                    <IconButton label={`${t('project.archive.open')}: ${board.title}`} size="sm" disabled={busy} onClick={() => { onClose(); navigateToPath(`/project/boards/${board.id}`) }}>
                      <SquareKanban size={14} />
                    </IconButton>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void restore(board) }}>
                      <ArchiveRestore size={14} />
                      {t('project.archive.restore')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
      </div>
    </Modal>
  )
}