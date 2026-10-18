/**
 * Deep research: one question, several turns, a note at the end.
 *
 * A single turn answers what one model call can hold: it can search, read a few notes, and write. What it
 * cannot do is decide what to look for first and then look for it properly — a plan made *before* the
 * searching is a different thing from a search improvised while writing. So a research run is several
 * turns in one thread: split the question, investigate each part with the note tools and the web, then
 * write the report from what was found. The thread is the evidence trail; the note is the deliverable.
 *
 * It is deliberately bounded. Each step is a paid model call and a wait, so the plan is capped at four
 * sub-questions and the whole run at six turns; a run the reader did not expect to be long is worse than
 * a shallow answer, because it cannot be interrupted half way without losing what it learned.
 *
 * The run lives in `localStorage` as well as in memory, which is the mechanism this app already uses for
 * a client-side working record that has to outlive the panel writing it (see `canvas-sync.ts`): a run is
 * up to six paid turns, and a reader who reloads the page in the middle of one is not asking to pay for
 * the finished ones again. What is stored is the plan, what each step found, and where it stopped — the
 * whole of what continuing needs. It stays the browser's record because the work is the browser's: a
 * Workers request cannot run for minutes and there is no queue to hand a half-finished run to, so this is
 * a resumable client-driven job rather than a server job. Closing the tab still stops the run; reloading
 * no longer loses it.
 */
import { create } from 'zustand'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { useNotes } from '../../store/notes'
import { useAssistant } from './assistant-store'
import { sendForAnswerDetailed } from './editor-ai'
import type { AnswerResult } from './editor-ai'
import { rememberNoteOrigin, withConversationSource } from './save-to-note'

/** How many sub-questions a run will investigate. Past four it is a book, not a research note. */
const MAX_QUESTIONS = 4

/** A note title is a line, not a paragraph. */
const MAX_TITLE = 80

/** The run's own record: one at a time, the newest one wins, and a dismissed run is gone. */
const STORAGE_KEY = 'inkstone:deep-research-run:v1'

/**
 * The sub-questions out of the plan turn.
 *
 * A numbered list is asked for and a numbered list is read, but models answer in bullets and with
 * emphasis often enough that both are accepted. Anything shorter than a few characters is a heading or a
 * stray marker rather than a question, so it is dropped.
 */
export function parseResearchPlan(text: string): string[] {
  const questions: string[] = []
  const seen = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:\d+[.)\u3001]|[-*+•])\s*(.+)$/.exec(line)
    if (!match) continue
    const question = match[1]!
      .replace(/\*\*|__|`/g, '')
      .replace(/^\s*\[[ xX]\]\s*/, '')
      .trim()
    if (question.length < 4) continue
    const key = question.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    questions.push(question)
    if (questions.length >= MAX_QUESTIONS) break
  }
  return questions
}

/**
 * Where a run got to, in the shape a reload can pick up.
 *
 * Every field is something the next step needs and nothing else: the topic rebuilds the prompts, the
 * questions say what is left, the findings are the part that already cost money.
 */
export interface ResearchRun {
  id: string
  topic: string
  /** The thread the run's turns went into — the evidence, and where a resumed step is asked. */
  conversationId: string | null
  questions: string[]
  /** Index-aligned with `questions`; an empty entry is a sub-question that has not been answered. */
  findings: string[]
  /** The report out of the write-up step; empty until that step has answered. */
  report: string
  /** The note the report was filed as, once it was. */
  noteId: string | null
  /** The step that stopped, in {@link researchSteps} numbering; null while nothing has failed. */
  failedStep: number | null
  /** Why it stopped, as the turn put it; null when the step simply came back with no words. */
  error: string | null
  updatedAt: number
}

export type ResearchStepState = 'done' | 'running' | 'failed' | 'pending'

export interface ResearchStep {
  /** 0 is the plan, then one per sub-question, then the write-up, then filing the note. */
  index: number
  label: string
  state: ResearchStepState
  /** What the step answered with, kept so a run that stopped still shows what it found before that. */
  output: string
}

interface ResearchState {
  run: ResearchRun | null
  /**
   * Whether this tab is driving the run right now.
   *
   * A record read back after a reload is not running by itself, and saying otherwise would put a spinner
   * on a job nothing is doing — the outcome this module exists to stop.
   */
  driving: boolean
}

function storage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

/**
 * A stored run, or nothing at all when the record is not the shape it was written in.
 *
 * A browser's storage is shared and hand-editable, so a half-right record is dropped rather than trusted:
 * resuming from a `questions` that is not a list of strings would send a prompt built out of whatever the
 * reader typed into devtools.
 */
function readStored(): ResearchRun | null {
  const source = storage()
  if (!source) return null
  try {
    const parsed: unknown = JSON.parse(source.getItem(STORAGE_KEY) ?? 'null')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const row = parsed as Record<string, unknown>
    if (typeof row.id !== 'string' || typeof row.topic !== 'string' || !row.topic.trim()) return null
    if (typeof row.report !== 'string' || typeof row.updatedAt !== 'number') return null
    const questions = listOfStrings(row.questions)
    const findings = listOfStrings(row.findings)
    if (!questions || !findings) return null
    // A finding without a question to hang it on is not a run; the two are read as one list.
    if (findings.length > questions.length) return null
    return {
      id: row.id,
      topic: row.topic,
      conversationId: typeof row.conversationId === 'string' ? row.conversationId : null,
      questions,
      findings: questions.map((_, index) => findings[index] ?? ''),
      report: row.report,
      noteId: typeof row.noteId === 'string' ? row.noteId : null,
      failedStep: typeof row.failedStep === 'number' ? row.failedStep : null,
      error: typeof row.error === 'string' ? row.error : null,
      updatedAt: row.updatedAt,
    }
  } catch (error) {
    console.warn('[inkstone] could not read the deep research run', error)
    return null
  }
}

/** A list of strings, or null — which is how a field hand-edited into something else is refused. */
function listOfStrings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value as string[] : null
}

export const useResearchRun = create<ResearchState>(() => ({ run: readStored(), driving: false }))

/** Keep the record and the screen in step, which is what a reload then reads back. */
function commit(run: ResearchRun | null): ResearchRun | null {
  useResearchRun.setState({ run })
  const source = storage()
  if (!source) return run
  try {
    // Best-effort: what a browser that could not keep this record costs the reader is the progress they
    // had — the run carries on in this tab exactly as far as it did before this existed.
    if (run === null) source.removeItem(STORAGE_KEY)
    else source.setItem(STORAGE_KEY, JSON.stringify(run))
  } catch (error) {
    console.warn('[inkstone] could not store the deep research run', error)
  }
  return run
}

/** A run id of its own, so a dismissal mid-turn cannot be mistaken for the record still being ours. */
function newRunId(): string {
  return `research-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** The run only while this call is still the one driving it — a dismissed run stops the loop. */
function runById(id: string): ResearchRun | null {
  const run = useResearchRun.getState().run
  return run && run.id === id ? run : null
}

/** The steps as the reader is told them: the plan, each sub-question, the write-up, then filing it. */
export function researchSteps(run: ResearchRun, driving: boolean): ResearchStep[] {
  const stateOf = (index: number, finished: boolean): ResearchStepState =>
    finished ? 'done' : run.failedStep === index ? 'failed' : 'pending'
  const steps: ResearchStep[] = [
    { index: 0, label: t('assistant.research.step_plan'), state: stateOf(0, run.questions.length > 0), output: '' },
  ]
  run.questions.forEach((question, index) => {
    const finding = run.findings[index] ?? ''
    steps.push({ index: index + 1, label: question, state: stateOf(index + 1, finding !== ''), output: finding })
  })
  const reportStep = run.questions.length + 1
  steps.push({ index: reportStep, label: t('assistant.research.step_report'), state: stateOf(reportStep, run.report !== ''), output: run.report })
  const fileStep = run.questions.length + 2
  steps.push({ index: fileStep, label: t('assistant.research.step_file'), state: stateOf(fileStep, run.noteId !== null), output: '' })
  if (driving) {
    // The step it is about to ask for. A failed step stays failed: the reader has to see where it stopped.
    const next = steps.find((step) => step.state === 'pending')
    if (next) next.state = 'running'
  }
  return steps
}

/** The question a step was asked to settle, in the same words the first pass would have used. */
function gatherPrompt(run: ResearchRun, index: number): string {
  return t('assistant.research.gather_prompt', {
    topic: run.topic,
    index: index + 1,
    total: run.questions.length,
    question: run.questions[index] ?? '',
  })
}

/**
 * One turn, waited out, with the reason it did not come back kept rather than flattened to null.
 *
 * A run is several of these in one thread, so the answer has to be the one this step asked for: reading
 * the newest row on the screen would let a refused step hand the previous step's findings to the report.
 */
async function ask(prompt: string): Promise<AnswerResult> {
  return await sendForAnswerDetailed(prompt)
}

/** What a step that did not answer says about itself: what the turn reported, or that it said nothing. */
function refusal(result: AnswerResult): string | null {
  if (result.status === 'busy') return t('assistant.edit.busy')
  return result.status === 'failed' ? result.error : null
}

/**
 * Mark where the run stopped and say so, keeping what came before.
 *
 * The record holds the earlier findings and the banner still lists them: a run that died on the third
 * sub-question has been paid for twice, and the reader needs both the number of the step that stopped and
 * the text the other ones produced — the thread has the turns, but it is not where they left off.
 */
function stop(run: ResearchRun, stepIndex: number, error: string | null): void {
  commit({ ...run, failedStep: stepIndex, error, updatedAt: Date.now() })
  useUi.getState().toast({
    title: t('assistant.research.failed', { step: stepIndex + 1 }),
    description: error ?? undefined,
    tone: 'warning',
  })
}

/** A turn already in flight is the one thing a run cannot share with anything else. */
function busy(): boolean {
  const assistant = useAssistant.getState()
  if (!assistant.turn || assistant.turn.done) return false
  useUi.getState().toast({ title: t('assistant.edit.busy'), tone: 'warning' })
  return true
}

/**
 * Ask every step the run has not got an answer for, then file what they found.
 *
 * Every step reads its own state off the persisted record, which is what makes this safe to enter twice:
 * a resumed run asks the questions that are still empty and writes the note from the report it already
 * has, so "continue" is never "start again".
 */
async function drive(id: string): Promise<string | null> {
  const toast = useUi.getState().toast
  useResearchRun.setState({ driving: true })
  try {
    let run = runById(id)
    if (!run) return null

    if (run.questions.length === 0) {
      const plan = await ask(t('assistant.research.plan_prompt', { topic: run.topic }))
      run = runById(id)
      if (!run) return null
      const questions = plan.status === 'ok' ? parseResearchPlan(plan.text) : []
      if (questions.length === 0) {
        // Nothing was investigated, so there is nothing to resume: the plan turn is in the thread, and
        // the reader starts again knowing the question did not split.
        commit(null)
        toast({ title: t('assistant.research.no_plan'), description: refusal(plan) ?? undefined, tone: 'warning' })
        return null
      }
      run = commit({ ...run, questions, findings: questions.map(() => ''), failedStep: null, error: null })
      if (!run) return null
      toast({ title: t('assistant.research.started', { topic: run.topic, count: run.questions.length + 2 }), tone: 'success' })
    }

    for (const [index, question] of run.questions.entries()) {
      // A step that answered already has its finding in the record; asking it again would charge twice.
      if (run.findings[index]) continue
      toast({
        title: t('assistant.research.step', { index: index + 2, total: run.questions.length + 2 }),
        description: question,
        tone: 'default',
      })
      const found = await ask(gatherPrompt(run, index))
      run = runById(id)
      if (!run) return null
      if (found.status !== 'ok') {
        stop(run, index + 1, refusal(found))
        return null
      }
      const findings = [...run.findings]
      findings[index] = found.text
      run = commit({ ...run, findings, failedStep: null, error: null, updatedAt: Date.now() })
      if (!run) return null
    }

    const reportStep = run.questions.length + 1
    if (!run.report) {
      toast({ title: t('assistant.research.step', { index: reportStep + 1, total: run.questions.length + 2 }), tone: 'default' })
      const report = await ask(t('assistant.research.synthesis_prompt', { topic: run.topic }))
      run = runById(id)
      if (!run) return null
      if (report.status !== 'ok') {
        stop(run, reportStep, refusal(report))
        return null
      }
      run = commit({ ...run, report: report.text, failedStep: null, error: null, updatedAt: Date.now() })
      if (!run) return null
    }

    // The note is the deliverable, but the thread is the evidence: the embed is what lets a reader go from
    // a claim in the note to the turns it was assembled from, and it costs the note one line.
    const fileStep = run.questions.length + 2
    const conversationId = useAssistant.getState().activeId ?? run.conversationId
    const title = run.topic.slice(0, MAX_TITLE)
    let noteId: string | null = null
    let reason: string | null = null
    try {
      noteId = await useNotes.getState().createNote({
        title,
        content: withConversationSource(run.report, conversationId),
        open: true,
      })
    } catch (error) {
      // A write that threw is the same outcome as one the store refused, with one more thing to say.
      reason = error instanceof Error ? error.message : String(error)
    }
    run = runById(id)
    if (!run) return null
    if (!noteId) {
      // The turns are all paid for and the report is in hand, so this step says what it actually is: a
      // note write that did not happen, with the text still there to file again.
      commit({ ...run, failedStep: fileStep, error: reason, updatedAt: Date.now() })
      toast({ title: t('assistant.research.file_failed'), description: reason ?? undefined, tone: 'danger' })
      return null
    }
    // The deliverable exists, so the working record has said everything it had to say: the note names the
    // thread it came from, and the thread holds every turn.
    commit(null)
    // Best-effort, like every note saved from the chat: the backlink is what puts the note in the thread.
    void rememberNoteOrigin(noteId, conversationId)
    toast({ title: t('assistant.research.saved', { title }), tone: 'success' })
    return noteId
  } finally {
    useResearchRun.setState({ driving: false })
  }
}

/**
 * Run a research pass on a topic and file the report as a note.
 *
 * Returns the new note's id, or null when the run could not finish — in which case the run's record stays
 * where the reader can see it, with what each finished step found, and the thread it ran in is still
 * there, because that is the part that cost the reader money.
 */
export async function startDeepResearch(topic: string): Promise<string | null> {
  const trimmed = topic.trim()
  if (!trimmed) return null
  if (busy()) return null
  const assistant = useAssistant.getState()
  assistant.setView('chat')
  await assistant.newConversation()
  // Research is expected to look things up on the web; the chip shows it is on for the thread, which is
  // the honest place for a setting that changes what the answers are made of.
  assistant.setWebSearch(true)
  const run = commit({
    id: newRunId(),
    topic: trimmed,
    conversationId: useAssistant.getState().activeId,
    questions: [],
    findings: [],
    report: '',
    noteId: null,
    failedStep: null,
    error: null,
    updatedAt: Date.now(),
  })
  if (!run) return null
  return await drive(run.id)
}

/**
 * Carry on with the run the reader last had open, from the steps it did not get an answer for.
 *
 * This is what a reload is for: the record names the thread its turns went into, and those turns are the
 * context the next step is written from, so the thread is opened again before anything is asked. There is
 * no way to resume a run whose thread the reader deleted — the steps would then be asked into an empty
 * context — which is why the record carries the id rather than reusing whatever is on screen.
 */
export async function resumeDeepResearch(): Promise<string | null> {
  const stored = useResearchRun.getState().run
  if (!stored || stored.noteId) return null
  if (busy()) return null
  const assistant = useAssistant.getState()
  assistant.setView('chat')
  if (stored.conversationId && assistant.activeId !== stored.conversationId) {
    await assistant.openConversation(stored.conversationId)
  }
  // A resumed run is still the same research, so it still expects to look things up.
  if (!useAssistant.getState().webSearch) useAssistant.getState().setWebSearch(true)
  const run = commit({ ...stored, failedStep: null, error: null, conversationId: useAssistant.getState().activeId ?? stored.conversationId })
  if (!run) return null
  // The turn the reader is about to be charged for, named in the numbering the rest of the run uses.
  const next = researchSteps(run, false).find((step) => step.state !== 'done')
  useUi.getState().toast({ title: t('assistant.research.resumed', { topic: run.topic, step: (next?.index ?? 0) + 1 }), tone: 'default' })
  return await drive(run.id)
}

/** Put the run's record away: the reader chose to stop looking at it, so nothing is resumed silently. */
export function dismissDeepResearch(): void {
  commit(null)
}
