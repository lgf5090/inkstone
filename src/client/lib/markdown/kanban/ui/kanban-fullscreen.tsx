import { memo, useEffect, useRef } from 'react'
import { Modal } from '../../../../components/overlay'
import { t, useLocaleRepaint } from '../../../i18n'
import type { KanbanSession } from '../session'

interface KanbanFullscreenProps {
  session: KanbanSession
  onClose: () => void
}

/**
 * Full screen view of one block. The overlay hosts the live instance the
 * preview mounted — the element is moved, never copied — so edits, history and
 * write-back stay with the single root that the inline block keeps using.
 */
export const KanbanFullscreen = memo(function KanbanFullscreen({
  session,
  onClose,
}: KanbanFullscreenProps) {
  useLocaleRepaint()
  const stageRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const stage = stageRef.current
    if (stage) session.moveInto(stage)
    return () => {
      session.moveBack()
      session.flush()
    }
  }, [session])

  return (
    <Modal
      open
      onClose={onClose}
      variant='fullscreen'
      ariaLabel={session.title() || t('preview.kanban_fullscreen')}
      className='kanban-fullscreen'
      bodyClassName='kanban-fullscreen-body flex flex-1 flex-col overflow-hidden p-0'
    >
      <div ref={stageRef} className='kanban-fullscreen-stage flex min-h-0 flex-1 flex-col overflow-hidden' />
    </Modal>
  )
})
