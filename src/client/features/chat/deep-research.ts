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
 */
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { useNotes } from '../../store/notes'
import { useAssistant } from './assistant-store'
import { lastAnswerText } from './editor-ai'

/** How many sub-questions a run will investigate. Past four it is a book, not a research note. */
const MAX_QUESTIONS = 4

/** A note title is a line, not a paragraph. */
const MAX_TITLE = 80

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

/** One turn, waited out. `null` means the turn produced nothing to build on. */
async function ask(prompt: string): Promise<string | null> {
  await useAssistant.getState().send(prompt)
  return lastAnswerText().trim() || null
}

/**
 * Run a research pass on a topic and file the report as a note.
 *
 * Returns the new note's id, or null when the run could not finish — in which case the thread it ran in
 * is still there, with whatever each step found, because that is the part that cost the reader money.
 */
export async function startDeepResearch(topic: string): Promise<string | null> {
  const trimmed = topic.trim()
  if (!trimmed) return null
  const toast = useUi.getState().toast
  const assistant = useAssistant.getState()
  if (assistant.turn && !assistant.turn.done) {
    toast({ title: t('assistant.edit.busy'), tone: 'warning' })
    return null
  }
  assistant.setView('chat')
  await assistant.newConversation()
  // Research is expected to look things up on the web; the chip shows it is on for the thread, which is
  // the honest place for a setting that changes what the answers are made of.
  useAssistant.getState().setWebSearch(true)

  const plan = await ask(t('assistant.research.plan_prompt', { topic: trimmed }))
  const questions = plan ? parseResearchPlan(plan) : []
  if (questions.length === 0) {
    toast({ title: t('assistant.research.no_plan'), tone: 'warning' })
    return null
  }
  toast({ title: t('assistant.research.started', { topic: trimmed, count: questions.length + 2 }), tone: 'success' })

  for (const [index, question] of questions.entries()) {
    const found = await ask(t('assistant.research.gather_prompt', {
      topic: trimmed,
      index: index + 1,
      total: questions.length,
      question,
    }))
    if (!found) {
      toast({ title: t('assistant.research.failed', { step: index + 2 }), tone: 'warning' })
      return null
    }
  }

  const report = await ask(t('assistant.research.synthesis_prompt', { topic: trimmed }))
  if (!report) {
    toast({ title: t('assistant.research.failed', { step: questions.length + 2 }), tone: 'warning' })
    return null
  }
  const id = await useNotes.getState().createNote({ title: trimmed.slice(0, MAX_TITLE), content: report, open: true })
  if (!id) {
    toast({ title: t('assistant.research.failed', { step: questions.length + 2 }), tone: 'danger' })
    return null
  }
  toast({ title: t('assistant.research.saved', { title: trimmed.slice(0, MAX_TITLE) }), tone: 'success' })
  return id
}
