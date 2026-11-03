import { describe, expect, it } from 'vitest'
import { normalizeAskedQuestions, normalizeQuestionAnswers } from '../src/shared/assistant'

describe('ask_user_question shape', () => {
  it('accepts one to three well-formed questions', () => {
    const questions = normalizeAskedQuestions([
      { id: 'tone', title: 'Which tone?', type: 'single', options: ['Formal', 'Plain'], required: true },
      { id: 'topics', title: 'Which topics?', type: 'multi', options: ['A', 'B'] },
      { id: 'detail', title: 'Anything else?', type: 'text' },
    ])
    expect(questions).toHaveLength(3)
    expect(questions?.[0]).toEqual({ id: 'tone', title: 'Which tone?', type: 'single', options: ['Formal', 'Plain'], required: true })
    expect(questions?.[2]?.options).toBeUndefined()
  })

  it('refuses the shapes the panel cannot draw', () => {
    expect(normalizeAskedQuestions([])).toBeNull()
    expect(normalizeAskedQuestions([{ id: 'a', title: 'A', type: 'single', options: ['one'] }])).toBeNull()
    expect(normalizeAskedQuestions([{ id: 'a', title: 'A', type: 'text' }, { id: 'a', title: 'B', type: 'text' }])).toBeNull()
    expect(normalizeAskedQuestions([{ id: '', title: 'A', type: 'text' }])).toBeNull()
    expect(normalizeAskedQuestions([{ id: 'a', title: 'A', type: 'scale' }])).toBeNull()
  })

  it('drops answers to questions that were not asked and keeps a typed other', () => {
    const questions = normalizeAskedQuestions([
      { id: 'tone', title: 'Tone', type: 'single', options: ['Formal', 'Plain'] },
      { id: 'topics', title: 'Topics', type: 'multi', options: ['A', 'B'] },
    ])!
    expect(normalizeQuestionAnswers(questions, {
      tone: 'Dry',
      topics: ['A', 'invented', 'A'],
      extra: 'not a question',
    })).toEqual({ tone: 'Dry', topics: ['A'] })
  })
})
