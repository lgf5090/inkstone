import { useEffect, useState, type ReactElement } from 'react'
import { t } from '../../lib/i18n'
import { LoadingBlock } from '../../components/feedback'
import { BoardViews } from './BoardViews'
import { useBoardSession } from './use-board-session'

const ignoreOpenCard = (): void => undefined

export function ProjectBoardEmbed({ boardId, viewId }: { boardId: string, viewId: string }): ReactElement {
  const { bundle, refresh } = useBoardSession(boardId, ignoreOpenCard)
  const [error, setError] = useState(false)
  useEffect(() => {
    void refresh().catch(() => setError(true))
  }, [refresh])
  if (error) return <p role="alert" className="p-4 text-[length:var(--text-12)] text-[var(--danger)]">{t('project.common.load_failed')}</p>
  if (!bundle) return <LoadingBlock />
  if (!bundle.views.some((view) => view.id === viewId)) return <p className="p-4 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.board.not_found')}</p>
  return (
    <div className="h-screen w-full bg-[var(--bg-base)]" data-project-board-embed={boardId}>
      <BoardViews
        bundle={bundle}
        canEdit={false}
        publicView
        embedded
        forcedViewId={viewId}
        onDeleteCard={() => {}}
        onCreateView={() => {}}
        onOpenCard={(cardId) => window.open(`/project/boards/${encodeURIComponent(boardId)}?card=${encodeURIComponent(cardId)}`, '_blank', 'noopener')}
        onPatchView={async () => {}}
        onDeleteView={() => {}}
        onDuplicateView={() => {}}
        onActiveViewChange={() => {}}
        onPatchCard={async () => {}}
        onAddGroupOption={async () => {}}
        onRenameGroupOption={async () => {}}
        onSetGroupOptionColor={async () => {}}
        onCardCreated={() => {}}
        onRefresh={async () => {}}
      />
    </div>
  )
}
