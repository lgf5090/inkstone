/**
 * The state of a template's AI passages, kept apart from the run that fills them.
 *
 * The shell has to know whether a run exists before it is willing to load the card that shows it, and the
 * run's own module carries the assistant's whole transport — a boot that subscribed to it would pay for
 * the chat chunk for every reader, including the ones who never use a template. So the reading side of
 * the job lives here, with nothing but the store and the toast it has to report, and the turns are asked
 * by `template-fill.ts`.
 */
import { create } from 'zustand'
import type { NewNoteAiSlot } from '@shared/note-template-render'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'

/** How far one passage got. `failed` always carries why, in {@link TemplateSlot.failure}. */
export type TemplateSlotState = 'pending' | 'running' | 'filled' | 'failed'

/**
 * The four ways a passage does not arrive, kept apart because they are four different sentences.
 *
 * A turn already in flight, a run the worker refused, an answer with no words in it and a note that is no
 * longer there are not one failure to a reader: the first says wait, the second and third say the
 * template's own instruction is the thing to look at, and the last says there is nothing left to write.
 */
export type TemplateSlotFailure = 'busy' | 'failed' | 'empty' | 'gone'

export interface TemplateSlot extends NewNoteAiSlot {
  state: TemplateSlotState
  /** What the assistant answered, held in memory until the whole set is written. */
  answer: string | null
  failure: TemplateSlotFailure | null
  /** Whatever the turn reported, when it reported anything. */
  error: string | null
}

export interface TemplateSlotJob {
  noteId: string
  /**
   * Which run this job belongs to, handed to the loop that asks the turns.
   *
   * A turn can outlive the job that opened it: the reader lets go of a run while an answer is on its way,
   * starts another template, and the old answer lands against the new job. The loop compares this against
   * the job it is holding before it writes anything, so a stale turn finds nothing to write into instead of
   * filling a passage of a run it has nothing to do with.
   */
  generation: number
  slots: TemplateSlot[]
  /** The passage the run stopped on, or `null` while it is going or when the note itself went. */
  stoppedAt: number | null
  status: 'running' | 'stopped'
}

interface SlotJobState {
  job: TemplateSlotJob | null
}

const useSlotJob = create<SlotJobState>(() => ({ job: null }))

/** The job the shell reads to decide whether the progress card has anything to show. */
export function peekTemplateSlotJob(): TemplateSlotJob | null {
  return useSlotJob.getState().job
}

/**
 * Subscribed by the shell so the card's chunk loads only once a template asks for passages.
 *
 * The listener is called on a change of job identity, not on every passage's state: all this caller wants
 * to know is whether there is a job to show at all, and it must not re-render on each one.
 */
export function subscribeTemplateSlotJob(listener: (job: TemplateSlotJob | null) => void): () => void {
  let previous = useSlotJob.getState().job
  return useSlotJob.subscribe((state) => {
    if (state.job === previous) return
    previous = state.job
    listener(state.job)
  })
}

export function useTemplateSlotJob<T>(selector: (state: SlotJobState) => T): T {
  return useSlotJob(selector)
}

/**
 * Whether one passage can be asked again.
 *
 * A note that is gone has nothing to write into, so the only way out of that run is to let go of it;
 * every other reason is worth a second try, including a turn refused because the assistant was already
 * writing.
 */
export function canRetryTemplateSlot(index: number): boolean {
  const slot = useSlotJob.getState().job?.slots[index]
  return Boolean(slot && slot.state === 'failed' && slot.failure !== 'gone')
}

/** Why one passage stopped, in the reader's language rather than the upstream's. */
export function templateSlotReason(slot: TemplateSlot): string {
  if (slot.failure === 'busy') return t('assistant.edit.busy')
  if (slot.failure === 'empty') return t('assistant.note.answer_empty')
  if (slot.failure === 'gone') return t('assistant.template.note_gone')
  return slot.error ?? t('assistant.note.answer_failed')
}

/** The headline for a stopped run: which passage of how many, since that is what the reader acts on. */
export function templateSlotStoppedTitle(job: TemplateSlotJob): string {
  return t('assistant.template.stopped', { current: (job.stoppedAt ?? 0) + 1, total: job.slots.length })
}

/** The job's own state, for the run module — nothing outside it writes the store. */
export function readSlotJob(): TemplateSlotJob | null {
  return useSlotJob.getState().job
}

/**
 * The next run's number.
 *
 * Taken before the job is written rather than from it, so the loop and the job it belongs to are stamped
 * with the same value at the one moment the run starts.
 */
let generation = 0

export function nextSlotGeneration(): number {
  generation += 1
  return generation
}

/**
 * Put a stopped run back on its feet, and return the number its loop is to carry.
 *
 * A retry is a new run of the same job: the passages already answered are kept, and everything still
 * missing is asked under a fresh number so an answer from the run that stopped cannot land in it. Returns
 * `null` when there is no job, which is the reader having let go of it in the moment before the click.
 */
export function restartSlotJob(): number | null {
  const job = useSlotJob.getState().job
  if (!job) return null
  const next = nextSlotGeneration()
  useSlotJob.setState({ job: { ...job, generation: next, status: 'running', stoppedAt: null } })
  return next
}

export function writeSlotJob(job: TemplateSlotJob | null): void {
  useSlotJob.setState({ job })
}

export function patchSlotJob(index: number, patch: Partial<TemplateSlot>): void {
  useSlotJob.setState((state) => {
    const job = state.job
    if (!job) return state
    return { job: { ...job, slots: job.slots.map((slot, at) => (at === index ? { ...slot, ...patch } : slot)) } }
  })
}

/**
 * Stop the run on one passage, and say which.
 *
 * The toast is fired from the state transition rather than from the caller, so there is no way to stop a
 * run quietly — a stopped passage the reader never heard about is how a template ends up half written.
 */
export function stopSlotJob(index: number, failure: TemplateSlotFailure, error: string | null): void {
  patchSlotJob(index, { state: 'failed', failure, error, answer: null })
  const current = useSlotJob.getState().job
  if (!current) return
  const job: TemplateSlotJob = { ...current, status: 'stopped', stoppedAt: index }
  useSlotJob.setState({ job })
  const slot = job.slots[index]
  // The reason rides in the description so it can still be read after the card is dismissed; the card
  // keeps saying it for as long as the run stands.
  if (slot) useUi.getState().toast({ title: templateSlotStoppedTitle(job), description: templateSlotReason(slot), tone: 'danger' })
}
