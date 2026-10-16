// @vitest-environment jsdom
/**
 * The rows a message's menu offers.
 *
 * A menu is a promise about what can be done with a turn, so what is pinned is which rows appear for
 * which role and which of them are left out when they have nothing to do. A row that cannot act — a
 * "delete" on a turn the server has not stored, a "regenerate" on an older answer — is worse than a
 * missing one, because the reader presses it and nothing happens.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { messageMenuItems, quoteOf } from './MessageMenu'

const ids = (target: Parameters<typeof messageMenuItems>[0]) => messageMenuItems(target).map((item) => item.id)

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
})

describe('what a reply offers', () => {
  it('offers the ways to keep and reuse it, and asking again only where that means something', () => {
    expect(ids({ role: 'assistant', text: 'answer' })).toEqual(['copy-md', 'copy-text', 'quote', 'save', 'download'])
    // Read-aloud is offered where the browser has a voice; jsdom has none, which is the same code path
    // as a browser without the API, so the row's absence here is the guard working rather than a gap.
    expect(ids({ role: 'assistant', text: 'answer', onRetry: () => {} })).toContain('retry')
  })

  it('never offers to edit or delete the assistant', () => {
    const rows = ids({ role: 'assistant', text: 'answer', onRetry: () => {} })
    expect(rows).not.toContain('edit')
    expect(rows).not.toContain('delete')
  })

  it('offers the two verdicts only where a verdict can be stored', () => {
    const rated = ids({ role: 'assistant', text: 'answer', onRate: () => {} })
    expect(rated).toContain('rate-up')
    expect(rated).toContain('rate-down')
    // A turn still streaming has no row to record a verdict on, so the caller passes no handler and the
    // rows stay out rather than being drawn and doing nothing.
    expect(ids({ role: 'assistant', text: 'answer' })).not.toContain('rate-up')
  })

  it('offers a branch only where there is a stored turn to branch from', () => {
    expect(ids({ role: 'user', text: 'question', onFork: () => {} })).toContain('fork')
    expect(ids({ role: 'user', text: 'question' })).not.toContain('fork')
    expect(ids({ role: 'assistant', text: 'answer', onFork: () => {} })).toContain('fork')
  })

  it('marks the verdict already recorded', () => {
    const rows = messageMenuItems({ role: 'assistant', text: 'answer', onRate: () => {}, feedback: 'down' })
    expect(rows.find((row) => row.id === 'rate-down')?.checked).toBe(true)
    expect(rows.find((row) => row.id === 'rate-up')?.checked).toBeUndefined()
  })
})

describe('what the reader\'s own message offers', () => {
  it('offers the two copy forms and a quote, and nothing that belongs to a reply', () => {
    expect(ids({ role: 'user', text: 'question' })).toEqual(['copy-md', 'copy-text', 'quote'])
  })

  it('offers edit and delete only when the turn is actually stored', () => {
    const stored = ids({ role: 'user', text: 'question', onEdit: () => {}, onDelete: () => {} })
    expect(stored).toContain('edit')
    expect(stored).toContain('delete')
    // The live turn has no id yet, so it has neither: the row would act on a message that does not exist.
    expect(ids({ role: 'user', text: 'question' })).not.toContain('edit')
  })
})

describe('quoting a turn back', () => {
  it('marks every line and names who said it', () => {
    const quote = quoteOf({ role: 'user', text: 'first\nsecond' }, new Date('2026-10-16T09:05:00'))
    expect(quote).toBe(`> ${t('assistant.chat.you')} · 09:05\n> first\n> second`)
  })

  it('keeps an empty line inside the quote as a quoted empty line', () => {
    // A blank line between two paragraphs ends a blockquote in Markdown, so the lines below it would
    // silently stop being part of the quote the reader asked for.
    expect(quoteOf({ role: 'assistant', text: 'para\n\nsecond' })).toContain('>\n> second')
  })
})
