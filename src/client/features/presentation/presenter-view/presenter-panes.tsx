import { FileText } from 'lucide-react'
import type { ProseFont } from '@shared/types'
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

export function PresenterSpeakerNotesPane({ notes }: { notes: string }) {
  return (
    <div className='flex min-h-0 flex-[1.2] flex-col overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-[var(--shadow-sm)]'>
      <div className='flex items-center gap-[var(--sp-1)] border-b border-[var(--border-subtle)] px-[var(--sp-3)] py-[var(--sp-2)] text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]'>
        <FileText size={13} />
        <span>{t('workspace.presentation_speaker_notes')}</span>
      </div>
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
    </div>
  )
}
