import { useEffect, type ReactElement } from 'react'
import { SquareKanban } from 'lucide-react'
import type { MessageKey } from '@shared/locales/en-US'
import type { ProjectRole } from '@shared/project/model'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Empty, LoadingBlock } from '../../components/feedback'
import { useProjectStore } from './store'

const ROLE_LABEL_KEYS: Record<ProjectRole, MessageKey> = {
  viewer: 'project.role.viewer',
  commenter: 'project.role.commenter',
  editor: 'project.role.editor',
  admin: 'project.role.admin',
}

export function ProjectApp(): ReactElement {
  const boards = useProjectStore((state) => state.boards)
  const status = useProjectStore((state) => state.boardsStatus)
  const error = useProjectStore((state) => state.boardsError)
  const ensureBoards = useProjectStore((state) => state.ensureBoards)
  const loadBoards = useProjectStore((state) => state.loadBoards)

  useEffect(() => {
    ensureBoards()
  }, [ensureBoards])

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]" data-project-app="">
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <span aria-hidden="true" className="flex size-7 items-center justify-center rounded-[var(--r-md)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]">
          <SquareKanban size={16} />
        </span>
        <h1 className="min-w-0 truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('project.title')}</h1>
        {status === 'ready' && (
          <span className="ml-auto shrink-0 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {t('project.boards.count', { count: boards.length })}
          </span>
        )}
      </header>
      {status === 'idle' || status === 'loading'
        ? <LoadingBlock />
        : status === 'error'
          ? (
              <Empty
                art="select"
                title={t('project.boards.load_failed')}
                description={error ?? undefined}
                action={<Button variant="primary" onClick={() => void loadBoards()}>{t('common.retry')}</Button>}
              />
            )
          : boards.length === 0
            ? <Empty art="folder" title={t('project.boards.empty_title')} description={t('project.boards.empty_description')} />
            : (
                <ul className="min-h-0 flex-1 overflow-y-auto">
                  {boards.map((board) => (
                    <li key={board.id} className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2" data-project-board={board.id}>
                      <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center text-[length:var(--text-14)]">
                        {board.icon || <SquareKanban size={15} className="text-[var(--text-quaternary)]" />}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)] text-[var(--text-primary)]">
                        {board.title || t('project.boards.untitled')}
                      </span>
                      <span className="shrink-0 rounded-[var(--r-sm)] bg-[var(--bg-hover)] px-1.5 py-0.5 text-[length:var(--text-11)] text-[var(--text-secondary)]">
                        {t(ROLE_LABEL_KEYS[board.role])}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
    </div>
  )
}
