import { X } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { IconButton } from '../../../components/primitives'
import { Tooltip } from '../../../components/overlay'
import { PresenterNextSlidePane, PresenterSpeakerNotesPane } from './presenter-panes'
import { usePresenterTimer } from './use-presenter-timer'
import { formatElapsed, type PresenterSlideState } from './use-presenter-channel'

export const PRESENTER_PANEL_WIDTH = 380

export interface PresenterPanelProps {
  state: PresenterSlideState
  chromeHidden: boolean
  /** The grid, a cover or the context menu is on top of the slide surface, so this is out of reach. */
  occluded: boolean
  onClose: () => void
  /** The notes box writes back through the show, which is the only side holding the document (PR-M8). */
  onEditNotes: (slide: number, text: string) => void
}

// The console the speaker gets when the browser will not hand over a second window: the next page,
// the notes for the one on screen and this show's clock, in a column of the show itself. The current
// page is deliberately absent — the projector already fills the screen with it. Its own column rather
// than a panel hung off the control toolbar, because the toolbar it would hang from is the one this
// panel replaces, and a strip that grows the header pushes that button out from under the pointer —
// the shape the AGENTS.md toolbar-expansion rule rules out.
export function PresenterPanel({ state, chromeHidden, occluded, onClose, onEditNotes }: PresenterPanelProps) {
  const timer = usePresenterTimer(state.startedAt)

  return (
    <aside
      aria-label={t('workspace.presentation_presenter_panel')}
      data-presenter-panel
      inert={chromeHidden || occluded ? true : undefined}
      className={cn(
        'flex h-full shrink-0 flex-col gap-[var(--sp-3)] border-l border-[var(--border-subtle)] bg-[var(--bg-surface)] p-[var(--sp-3)]',
        'transition-opacity duration-[var(--dur-base)] ease-[var(--ease-out)]',
        chromeHidden && 'pointer-events-none opacity-0',
      )}
      style={{ width: PRESENTER_PANEL_WIDTH }}
    >
      <header className='flex shrink-0 items-center justify-between gap-[var(--sp-2)]'>
        <div className='flex min-w-0 items-baseline gap-[var(--sp-2)]'>
          <span className='truncate text-[length:var(--text-11)] font-medium tracking-[var(--tracking-label)] text-[var(--text-tertiary)] uppercase'>
            {t('workspace.presentation_presenter')}
          </span>
          <span data-presenter-clock className='tabular font-mono text-[length:var(--text-14)] font-semibold text-[var(--accent)]'>
            {formatElapsed(timer.elapsedSeconds)}
          </span>
        </div>
        <Tooltip label={t('common.close')} side='left'>
          <IconButton size='sm' label={t('common.close')} onClick={onClose}>
            <X size={14} />
          </IconButton>
        </Tooltip>
      </header>
      <PresenterNextSlidePane
        nextSource={state.nextSlideSource}
        nextLayout={state.nextLayout}
        nextPlan={state.nextPlan}
        nextSubPage={state.nextSubPage}
        nextStep={state.nextStep}
        font={state.proseFont}
      />
      <PresenterSpeakerNotesPane notes={state.notes} slideIndex={state.slideIndex} onEdit={onEditNotes} />
    </aside>
  )
}
