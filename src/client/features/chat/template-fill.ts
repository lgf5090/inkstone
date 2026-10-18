/**
 * Filling the places a template asked the assistant to write.
 *
 * `{{ai: …}}` is a template's own request, so it is answered when the note is made rather than offered
 * as a button: a template with a slot in it is a template that is not finished until the slot is filled.
 * Each slot is one turn, and a template normally asks for more than one, so the run is a job the reader
 * watches — how many passages there are, which one is being written, what it is waiting on. The state all
 * of that is read from lives in `template-slot-job.ts`; this module is the asking and the writing.
 *
 * Nothing reaches the note until every passage has come back. A run that stopped half way used to leave
 * the passages it had already paid for sitting in the note beside the hole the rest left behind, which is
 * the worst of both outcomes: the reader is left a document that looks finished in places and is not, and
 * the answers they would have needed to finish it were thrown away anyway. So the answers are held in
 * memory, written in one edit when the last one lands — and a stopped run keeps them, so retrying the
 * passage that failed costs that passage and nothing else.
 */
import type { NewNoteAiSlot } from '@shared/note-template-render'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { useNotes } from '../../store/notes'
import { insertBlockAt } from './editor-ai'
import { askAboutNote } from './note-ai'
import {
  canRetryTemplateSlot,
  nextSlotGeneration,
  patchSlotJob,
  readSlotJob,
  restartSlotJob,
  stopSlotJob,
  writeSlotJob,
} from './template-slot-job'

/**
 * Ask for the passages that are still missing, from `from` on, and write when none are.
 *
 * The loop is told which run it belongs to and re-reads the job before every step, because a turn can
 * outlive the run that opened it: the reader lets go of a stuck passage and starts another template, and
 * the answer that was already on its way must not be written into the new job. Nothing else serialises it
 * — `startTemplateSlotFill` and `retryTemplateSlot` refuse a job that is already `running`, so one
 * generation has exactly one loop.
 */
async function drive(generation: number, from: number): Promise<void> {
  for (let index = from; ; index += 1) {
    const job = readSlotJob()
    if (!job || job.generation !== generation) return
    const slot = job.slots[index]
    if (!slot) break
    // The note may have been deleted or closed out from under the run while an answer was being written;
    // asking about a note that is not there only produces an answer with nowhere to go.
    if (useNotes.getState().contents[job.noteId] === undefined) {
      stopSlotJob(index, 'gone', null)
      return
    }
    patchSlotJob(index, { state: 'running' })
    const answer = await askAboutNote(job.noteId, slot.instruction)
    if (readSlotJob()?.generation !== generation) return
    if (answer.status === 'ok') {
      patchSlotJob(index, { state: 'filled', answer: answer.text, failure: null, error: null })
      continue
    }
    stopSlotJob(
      index,
      answer.status === 'busy' ? 'busy' : answer.status === 'failed' ? 'failed' : 'empty',
      answer.status === 'failed' ? answer.error : null,
    )
    return
  }
  commitSlotJob(generation)
}

/**
 * Write the whole set, once, in one edit.
 *
 * The passages are laid down from the end of the document backwards: each one grows the note, and the
 * offsets recorded at render time are only true of the text ahead of them. A note the reader kept typing
 * in moves those offsets, so each is clamped rather than trusted — a passage that would land past the end
 * lands at the end instead of nowhere.
 *
 * The note going missing between the last answer and this write is the one failure that names no passage,
 * because none of them caused it: the run is stopped, the answers stay unsaid, and the card's only offer
 * is to let go.
 */
function commitSlotJob(generation: number): void {
  const job = readSlotJob()
  if (!job || job.generation !== generation) return
  const content = useNotes.getState().contents[job.noteId]
  if (content === undefined) {
    writeSlotJob({ ...job, status: 'stopped', stoppedAt: null })
    useUi.getState().toast({ title: t('assistant.template.note_gone'), tone: 'danger' })
    return
  }
  let next = content
  for (const slot of [...job.slots].sort((left, right) => right.at - left.at)) {
    next = insertBlockAt(next, Math.min(slot.at, next.length), slot.answer ?? '')
  }
  useNotes.getState().editContent(job.noteId, next)
  writeSlotJob(null)
  useUi.getState().toast({ title: t('assistant.template.all_written', { count: job.slots.length }), tone: 'success' })
}

/**
 * Begin a template's passages.
 *
 * Called the moment the note exists: the turns are asked *about* that note, which is what lets an
 * instruction like "summarise the section above" mean something. A run that is already going is refused
 * rather than queued behind the reader's back, because two jobs in one card would be one card lying about
 * which note it is writing — and the first can be finished or dropped in the card itself.
 */
export function startTemplateSlotFill(noteId: string, slots: readonly NewNoteAiSlot[]): void {
  if (slots.length === 0) return
  if (readSlotJob()?.status === 'running') {
    useUi.getState().toast({ title: t('assistant.template.in_flight'), tone: 'warning' })
    return
  }
  const generation = nextSlotGeneration()
  writeSlotJob({
    noteId,
    generation,
    // Document order, not the order they are written in: the reader counts passages the way the template
    // lists them, and the backwards write is the run's own business.
    slots: slots.map((slot) => ({ ...slot, state: 'pending' as const, answer: null, failure: null, error: null })),
    stoppedAt: null,
    status: 'running',
  })
  void drive(generation, 0)
}

/**
 * Ask one passage again, then carry on with whatever was never started.
 *
 * The finished passages keep their answers, so a retry spends the one turn it names and nothing else.
 */
export function retryTemplateSlot(index: number): void {
  const job = readSlotJob()
  if (!job || job.status === 'running' || !canRetryTemplateSlot(index)) return
  patchSlotJob(index, { state: 'pending', failure: null, error: null, answer: null })
  const generation = restartSlotJob()
  if (generation === null) return
  void drive(generation, index)
}

/**
 * Let go of a run, leaving the note exactly as the template wrote it.
 *
 * The passages held in memory go with the job. Nothing was ever written, so there is nothing to undo —
 * which is what the card is able to promise, and one of the reasons the answers were not written one at a
 * time. An answer still on its way finds no job to land in.
 */
export function discardTemplateSlotFill(): void {
  const job = readSlotJob()
  writeSlotJob(null)
  if (job) useUi.getState().toast({ title: t('assistant.template.discarded'), tone: 'default' })
}

