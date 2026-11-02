import { useEffect, useState, type KeyboardEvent } from 'react'
import { HelpCircle } from 'lucide-react'
import type { AssistantQuestion, AssistantQuestionAnswers, AssistantQuestionRow } from '@shared/assistant'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { Button } from '../../components/primitives'
import { Input, Textarea } from '../../components/form'
import { useAssistant } from './assistant-store'

const POLL_MS = 2_000

/**
 * The questions a running turn stopped on.
 *
 * The row is read from the server rather than held in a frame: the turn is parked in the worker, and a
 * refresh or a second tab has to find the same question. The poll only runs while a turn is streaming,
 * because that is the only time a question can appear.
 */
export function AskUserQuestionPanel({ conversationId, streaming }: { conversationId: string | null, streaming: boolean }) {
  const questions = useAssistant((state) => state.questions)
  const loadQuestions = useAssistant((state) => state.loadQuestions)
  useEffect(() => {
    if (!conversationId) return
    void loadQuestions(conversationId)
    if (!streaming) return
    const timer = window.setInterval(() => { void loadQuestions(conversationId) }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [conversationId, streaming, loadQuestions])

  if (!questions.length) return null
  return (
    <div className="mx-auto w-full max-w-[720px] px-4 pb-2 md:px-6">
      {questions.map((question) => <AskQuestionCard key={question.id} row={question} />)}
    </div>
  )
}

function AskQuestionCard({ row }: { row: AssistantQuestionRow }) {
  const answerQuestion = useAssistant((state) => state.answerQuestion)
  const cancelQuestion = useAssistant((state) => state.cancelQuestion)
  const [values, setValues] = useState<Record<string, string | string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setValues({})
    setOther({})
  }, [row.id])

  const valueOf = (question: AssistantQuestion): string | string[] | undefined => {
    const typed = (other[question.id] ?? '').trim()
    if (question.type === 'multi') {
      const picked = Array.isArray(values[question.id]) ? [...(values[question.id] as string[])] : []
      if (typed) picked.push(typed)
      return picked.length ? picked : undefined
    }
    if (typed) return typed
    const value = values[question.id]
    return typeof value === 'string' && value ? value : undefined
  }

  const missing = (question: AssistantQuestion) => question.required && valueOf(question) === undefined

  const submit = () => {
    if (busy || row.questions.some(missing)) return
    const answers: AssistantQuestionAnswers = {}
    for (const question of row.questions) {
      const value = valueOf(question)
      if (value !== undefined) answers[question.id] = value
    }
    setBusy(true)
    void answerQuestion(row.id, answers).finally(() => setBusy(false))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <form
      className="mb-2 rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-3 shadow-[var(--shadow-pop)]"
      onKeyDown={onKeyDown}
      onSubmit={(event) => { event.preventDefault(); submit() }}
      aria-label={t('assistant.questions.title')}
    >
      <div className="mb-2 flex items-center gap-1.5">
        <HelpCircle size={14} className="shrink-0 text-[var(--accent)]" aria-hidden />
        <p className="min-w-0 flex-1 text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('assistant.questions.title')}</p>
      </div>
      <div className="space-y-3">
        {row.questions.map((question) => {
          const label = question.required ? `${question.title} *` : question.title
          return (
            <fieldset key={question.id} className="min-w-0 space-y-1.5">
              <legend className="mb-1 text-[length:var(--text-12-5)] text-[var(--text-secondary)]">{label}</legend>
              {question.type === 'text' && (
                <Textarea
                  rows={2}
                  aria-label={question.title}
                  value={typeof values[question.id] === 'string' ? values[question.id] as string : ''}
                  onChange={(event) => setValues((current) => ({ ...current, [question.id]: event.target.value }))}
                />
              )}
              {question.type === 'single' && (
                <div role="radiogroup" aria-label={question.title} className="flex flex-wrap gap-1.5">
                  {(question.options ?? []).map((option) => {
                    const picked = values[question.id] === option
                    return (
                      <button
                        key={option}
                        type="button"
                        role="radio"
                        aria-checked={picked}
                        onClick={() => setValues((current) => ({ ...current, [question.id]: option }))}
                        className={cn(
                          'rounded-[var(--r-full)] border px-2.5 py-1 text-[length:var(--text-11-5)] transition-colors',
                          picked
                            ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
                            : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--accent)]',
                        )}
                      >
                        {option}
                      </button>
                    )
                  })}
                </div>
              )}
              {question.type === 'multi' && (
                <div role="group" aria-label={question.title} className="flex flex-wrap gap-1.5">
                  {(question.options ?? []).map((option) => {
                    const list = Array.isArray(values[question.id]) ? values[question.id] as string[] : []
                    const picked = list.includes(option)
                    return (
                      <button
                        key={option}
                        type="button"
                        aria-pressed={picked}
                        onClick={() => setValues((current) => {
                          const now = Array.isArray(current[question.id]) ? [...(current[question.id] as string[])] : []
                          return {
                            ...current,
                            [question.id]: picked ? now.filter((entry) => entry !== option) : [...now, option],
                          }
                        })}
                        className={cn(
                          'rounded-[var(--r-full)] border px-2.5 py-1 text-[length:var(--text-11-5)] transition-colors',
                          picked
                            ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
                            : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--accent)]',
                        )}
                      >
                        {option}
                      </button>
                    )
                  })}
                </div>
              )}
              {question.type !== 'text' && (
                <Input
                  value={other[question.id] ?? ''}
                  aria-label={t('assistant.questions.other_for', { title: question.title })}
                  placeholder={t('assistant.questions.other')}
                  onChange={(event) => setOther((current) => ({ ...current, [question.id]: event.target.value }))}
                />
              )}
            </fieldset>
          )
        })}
      </div>
      <div className="mt-3 flex items-center justify-end gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void cancelQuestion(row.id).finally(() => setBusy(false))
          }}
        >
          {t('assistant.questions.cancel')}
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={busy || row.questions.some(missing)}>
          {t('assistant.questions.submit')}
        </Button>
      </div>
      <p className="mt-1.5 text-right text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('assistant.questions.shortcut')}</p>
    </form>
  )
}
