/**
 * The deep research run, where the reader can see how far it got.
 *
 * A run is up to six paid turns driven by this tab, so it needs what any long job needs: how many steps
 * there are, which one is going on, and — when one stopped — a way to carry on that does not pay for the
 * finished ones again. The findings sit on the rows themselves, because a run that died on the fourth
 * question still has the first three, and after a reload the thread they were asked in is not where a
 * reader looks to find out what is still missing.
 */
import { CheckCircle2, Circle, Loader2, TriangleAlert, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import {
  dismissDeepResearch,
  researchSteps,
  resumeDeepResearch,
  useResearchRun,
  type ResearchStepState,
} from './deep-research'

const STATE_LABELS: Record<ResearchStepState, () => string> = {
  done: () => t('assistant.research.state_done'),
  running: () => t('assistant.research.state_running'),
  failed: () => t('assistant.research.state_failed'),
  pending: () => t('assistant.research.state_pending'),
}

/** The icon beside a step's own words — decoration, since the state is also said in text. */
function StepMark({ state }: { state: ResearchStepState }) {
  if (state === 'done') return <CheckCircle2 size={13} className="text-[var(--accent)]" aria-hidden="true" />
  if (state === 'running') return <Loader2 size={13} className="animate-spin text-[var(--accent)]" aria-hidden="true" />
  if (state === 'failed') return <TriangleAlert size={13} className="text-[var(--danger)]" aria-hidden="true" />
  return <Circle size={13} className="text-[var(--text-quaternary)]" aria-hidden="true" />
}

export function DeepResearchProgress() {
  const run = useResearchRun((state) => state.run)
  const driving = useResearchRun((state) => state.driving)
  if (!run) return null
  const steps = researchSteps(run, driving)
  const done = steps.filter((step) => step.state === 'done').length
  const failed = steps.find((step) => step.state === 'failed')

  return (
    <section
      role="status"
      aria-live="polite"
      aria-label={t('assistant.research.progress_label', { topic: run.topic })}
      className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-2"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">{run.topic}</span>
        <span className="ml-auto shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          {t('assistant.research.progress_count', { done, total: steps.length })}
        </span>
        <IconButton label={t('assistant.research.dismiss')} size="sm" onClick={() => dismissDeepResearch()}>
          <X size={13} />
        </IconButton>
      </div>

      <ol className="mt-1.5 flex flex-col gap-1">
        {steps.map((step) => (
          <li key={step.index} aria-current={step.state === 'running' ? 'step' : undefined} className="min-w-0">
            <span className="flex items-start gap-1.5 text-[length:var(--text-11)]">
              <StepMark state={step.state} />
              <span className={cn('min-w-0 break-words', step.state === 'done' ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]')}>
                {step.label}
              </span>
              <span className="sr-only shrink-0">{STATE_LABELS[step.state]()}</span>
            </span>
            {step.output && (
              // Collapsed on purpose: what a step found is reachable from the banner without the banner
              // turning into the report it has not written yet.
              <details className="mt-0.5 ml-5">
                <summary className="cursor-pointer text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                  {t('assistant.research.step_output')}
                </summary>
                <p className="mt-0.5 whitespace-pre-wrap break-words text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                  {step.output}
                </p>
              </details>
            )}
          </li>
        ))}
      </ol>

      {failed && (
        <p role="alert" className="mt-1.5 text-[length:var(--text-11)] text-[var(--danger)]">
          {run.error || t('assistant.research.stopped', { step: failed.index + 1 })}
        </p>
      )}

      {/* A run this tab is not driving is never left as a spinner: the way on is the button, and the line
          says what pressing it does not repeat. */}
      {!driving && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" onClick={() => { void resumeDeepResearch() }}>
            {t('assistant.research.resume')}
          </Button>
          <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('assistant.research.resume_hint')}</span>
        </div>
      )}
    </section>
  )
}
