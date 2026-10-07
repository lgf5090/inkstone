import { useState } from 'react'
import { FileText, List } from 'lucide-react'
import type { ProseFont } from '@shared/types'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { PresenterSlidePreview } from './presenter-slide-preview'
import type { SlidePlan } from '../slide-pagination'
import type { SlideLayout } from '../slides'

export function PresenterNextSlidePane({
  nextSource,
  nextLayout,
  nextPlan,
  nextSubPage,
  nextStep,
  font,
}: {
  nextSource: string | null
  nextLayout?: SlideLayout
  nextPlan?: SlidePlan
  nextSubPage?: number
  /** Which reveal the next press lands on, so the preview is that state and not the finished page. */
  nextStep: number
  font?: ProseFont
}) {
  return (
    <div data-presenter-next-pane className='flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-[var(--shadow-sm)]'>
      <div className='border-b border-[var(--border-subtle)] px-[var(--sp-3)] py-[var(--sp-2)] text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]'>
        {t('workspace.presentation_next_slide')}
      </div>
      <div className='flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[var(--bg-editor)] p-[var(--sp-2)]'>
        {nextSource ? (
          <PresenterSlidePreview
            source={nextSource}
            layout={nextLayout}
            plan={nextPlan}
            sub={nextSubPage}
            step={nextStep}
            font={font}
          />
        ) : (
          <div className='text-[length:var(--text-14)] italic text-[var(--text-tertiary)]'>
            {t('workspace.presentation_end_of_deck')}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The speaker's own page of the console: read-only when nothing can be written, and a box to type in
 * when the window holding the document is on the other end of the channel (PR-M8).
 *
 * The edit is handed over when the box loses focus rather than on every keystroke: the note is a line of
 * the document, so a save per character would be an undo history per character, and a talk is typed in
 * the middle of talking.
 */
export function PresenterSpeakerNotesPane({ notes, slideIndex, onEdit }: {
  notes: string
  slideIndex?: number
  onEdit?: (slide: number, text: string) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [held, setHeld] = useState(slideIndex)
  if (held !== slideIndex) {
    // The page moved under the box: whatever was being typed belongs to the slide it was typed on.
    setHeld(slideIndex)
    setDraft(null)
  }
  const editable = onEdit !== undefined && slideIndex !== undefined
  const text = draft ?? notes
  return (
    <div className='flex min-h-0 flex-[1.2] flex-col overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-[var(--shadow-sm)]'>
      <div className='flex items-center gap-[var(--sp-1)] border-b border-[var(--border-subtle)] px-[var(--sp-3)] py-[var(--sp-2)] text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]'>
        <FileText size={13} />
        <span>{t('workspace.presentation_speaker_notes')}</span>
      </div>
      {editable && (
        <div className='border-b border-[var(--border-subtle)] px-[var(--sp-3)] py-[var(--sp-1)] text-[length:var(--text-12)] text-[var(--text-tertiary)]'>
          {t('workspace.presentation_notes_edit_hint')}
        </div>
      )}
      {editable ? (
        <textarea
          data-speaker-notes
          data-speaker-notes-editable='true'
          aria-label={t('workspace.presentation_speaker_notes')}
          placeholder={t('workspace.presentation_no_notes')}
          value={text}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (draft !== null && slideIndex !== undefined && onEdit && draft !== notes) onEdit(slideIndex, draft)
            setDraft(null)
          }}
          className='min-h-0 flex-1 resize-none bg-transparent p-[var(--sp-4)] text-[length:var(--text-16)] leading-relaxed text-[var(--text-primary)] outline-none'
        />
      ) : (
      <div
        data-speaker-notes
        tabIndex={0}
        className='flex-1 overflow-y-auto p-[var(--sp-4)] text-[length:var(--text-16)] leading-relaxed text-[var(--text-primary)] outline-none'
      >
        {notes ? (
          <div className='whitespace-pre-wrap font-sans'>{notes}</div>
        ) : (
          <p className='text-[length:var(--text-14)] italic text-[var(--text-tertiary)]'>
            {t('workspace.presentation_no_notes')}
          </p>
        )}
      </div>
      )}
    </div>
  )
}

/**
 * The deck as one line per slide, with the row the projector is standing on marked (PR-M14).
 *
 * Labels rather than thumbnails: the console is where a presenter looks for "which one was the numbers
 * one", a wall of pictures costs a scroll to read and a render per turn to draw, and the labels are the
 * same ones the slide list and the overview print. A slide with no heading in it contributes its number
 * alone, which is what the rail does with the same case.
 */
export function PresenterOutlinePane({ titles, slideIndex, onJump }: {
  titles: string[]
  slideIndex: number
  onJump: (index: number) => void
}) {
  return (
    <div data-presenter-outline className='flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-[var(--shadow-sm)]'>
      <div className='flex items-center gap-[var(--sp-1)] border-b border-[var(--border-subtle)] px-[var(--sp-3)] py-[var(--sp-2)] text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]'>
        <List size={13} />
        <span>{t('workspace.presentation_outline')}</span>
      </div>
      <ol tabIndex={0} className='min-h-0 flex-1 overflow-y-auto p-[var(--sp-2)] outline-none'>
        {titles.map((title, index) => (
          <li key={index}>
            <button
              type='button'
              data-presenter-outline-row={index}
              aria-current={index === slideIndex ? 'true' : undefined}
              onClick={() => onJump(index)}
              className={cn('flex w-full items-baseline gap-[var(--sp-2)] rounded-[var(--r-sm)] px-[var(--sp-2)] py-[var(--sp-1)] text-left text-[length:var(--text-14)]', index === slideIndex ? 'bg-[var(--bg-active)] font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]')}
            >
              <span className='tabular shrink-0 text-[var(--text-tertiary)]'>{index + 1}</span>
              <span className='truncate'>{title}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}
