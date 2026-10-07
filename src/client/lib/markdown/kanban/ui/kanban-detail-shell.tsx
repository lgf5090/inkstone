import type { ReactNode } from 'react'
import { Drawer, Modal } from '../../../../components/overlay'
import { t } from '../../../i18n'
import { Z_INDEX } from '../../../../lib/z-index'

export interface DetailShellProps {
  onClose: () => void
  header: ReactNode
  content: ReactNode
  footer: ReactNode
}

/** Narrower than the dialog: the peek stands beside the board rather than in place of it. */
export const DETAIL_PEEK_WIDTH = 420
export const DETAIL_MODAL_WIDTH = 640

/**
 * The full screen board's shell: the card stands beside the board, so the columns a reader is
 * working through stay in view while the card is open, and the next one can be picked without
 * leaving them.
 *
 * It carries its own head and foot so the card's name stays editable at the top and the destructive
 * action stays reachable at the bottom while the middle scrolls, which a drawer's single scroll area
 * does not do on its own. `Z_INDEX.menu` is the tier an overlay takes above a full screen surface —
 * the same move the music hub's drawers make — and it is required rather than decorative here: the
 * board itself is a modal at `--z-modal`, so a drawer at the default `--z-drawer` would be painted
 * behind the very board it peeks from.
 */
export function KanbanCardPeek({ onClose, header, content, footer }: DetailShellProps) {
  return (
    <Drawer
      open
      onClose={onClose}
      side='right'
      width={DETAIL_PEEK_WIDTH}
      zIndex={Z_INDEX.menu}
      ariaLabel={t('preview.kanban_card_details')}
    >
      <div className='flex h-full flex-col'>
        <div className='shrink-0 border-b border-[var(--border-subtle)] px-[var(--sp-4)] py-[var(--sp-3)]'>{header}</div>
        <div className='min-h-0 flex-1 overflow-y-auto px-[var(--sp-4)] py-[var(--sp-3)]'>{content}</div>
        <div className='shrink-0 border-t border-[var(--border-subtle)] px-[var(--sp-4)] py-[var(--sp-3)]'>{footer}</div>
      </div>
    </Drawer>
  )
}

/** A note's shell: the centred dialog, which is the room a block inside the editor does not have. */
export function KanbanCardDialog({ onClose, header, content, footer }: DetailShellProps) {
  return (
    <Modal open onClose={onClose} width={DETAIL_MODAL_WIDTH} title={header} footer={footer}>
      {content}
    </Modal>
  )
}
