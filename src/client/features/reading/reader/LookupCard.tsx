/**
 * The word card.
 *
 * It opens where the selection was, because a reader who is mid-sentence does not want to look for the
 * answer somewhere else, and it closes on the next tap rather than owning a dismiss button. The engine it
 * used is shown: an AI answer and a plain translation are different kinds of confident, and the reader
 * deserves to know which one they are copying.
 */
import { useEffect, useRef } from 'react'
import { BookMarked, Sparkles, X } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { Spinner } from '../../../components/primitives'
import type { LookupOutcome } from '../lookup'

export interface LookupCardProps {
  rect: DOMRect
  pending: boolean
  outcome: LookupOutcome | null
  error: string | null
  onClose: () => void
  onCollect: (outcome: LookupOutcome) => void
  collected: boolean
}

export function LookupCard({ rect, pending, outcome, error, onClose, onCollect, collected }: LookupCardProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const width = 300
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left))
  const top = Math.max(8, Math.min(window.innerHeight - 180, rect.bottom + 8))

  return (
    <div
      ref={ref}
      role="status"
      aria-live="polite"
      className="app-viewport-fixed fixed z-[8] flex flex-col gap-1.5 rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-2.5 shadow-[var(--shadow-pop)]"
      style={{ left, top, width }}
    >
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-[length:var(--text-12-5)] font-semibold leading-snug text-[var(--text-primary)]">
          {outcome?.source ?? t('reading.translating')}
        </p>
        <button type="button" aria-label={t('reading.close_lookup')} onClick={onClose} className="shrink-0 text-[var(--text-tertiary)]">
          <X size={14} />
        </button>
      </div>
      {pending ? <Spinner size={14} className="text-[var(--text-tertiary)]" /> : null}
      {error ? <p className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p> : null}
      {outcome ? (
        <>
          <p className="whitespace-pre-wrap text-[length:var(--text-13)] leading-relaxed text-[var(--text-primary)]">{outcome.target}</p>
          {outcome.notes ? (
            <p className="whitespace-pre-wrap text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">{outcome.notes}</p>
          ) : null}
          <div className="mt-0.5 flex items-center gap-2">
            <span className="inline-flex items-center gap-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
              {outcome.engine === 'ai' ? <Sparkles size={11} /> : null}
              {outcome.engine === 'ai' ? t('reading.engine_ai') : t('reading.engine_free')}
            </span>
            {outcome.kind === 'word' && !collected ? (
              <button
                type="button"
                onClick={() => onCollect(outcome)}
                className="ml-auto inline-flex h-7 items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-default)] px-2 text-[length:var(--text-11-5)] hover:bg-[var(--bg-hover)]"
              >
                <BookMarked size={12} />
                {t('reading.collect_word')}
              </button>
            ) : collected ? (
              <span className="ml-auto text-[length:var(--text-11)] text-[var(--success)]">{t('reading.word_collected')}</span>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  )
}
