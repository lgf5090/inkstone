import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newCaptureChoice } from '@shared/quickadd'
import type { NoteTemplate, NoteTemplateCategory } from '@shared/types'
import { initI18n, t } from '../../lib/i18n'
import { useNoteTemplates } from '../../store/note-templates'
import { notePort, runNotice } from './runner'
import type { QuickAddRunStatus } from './context'

const choice = newCaptureChoice('qa-c', 'Inbox capture', 0)
const both = { notifications: true, cancelNotice: true }

beforeAll(async () => {
  await initI18n()
})

describe('what a finished run says about itself', () => {
  it('names the note a write landed in', () => {
    const written: QuickAddRunStatus = { kind: 'written', noteId: 'n1', created: false, summary: 'Inbox capture wrote into Inbox' }
    expect(runNotice(written, choice, both)?.title).toBe('Inbox capture wrote into Inbox')
    expect(runNotice(written, choice, { ...both, notifications: false })).toBeNull()
  })

  it('says the run had nothing to write only when notices are on', () => {
    const empty: QuickAddRunStatus = { kind: 'empty', noteId: 'n1' }
    expect(runNotice(empty, choice, both)?.title).toBe(t('quickadd.ran_empty', { name: choice.name }))
    expect(runNotice(empty, choice, { ...both, notifications: false })).toBeNull()
  })

  it('keeps a plain cancelled run silent unless the cancellation notice is on', () => {
    expect(runNotice({ kind: 'cancelled' }, choice, { notifications: true, cancelNotice: false })).toBeNull()
    expect(runNotice({ kind: 'cancelled' }, choice, both)?.title).toBe(t('quickadd.ran_cancelled', { name: choice.name }))
  })

  it('always reports a cancel the engine refused, and a failure, whatever the switches say', () => {
    const refused = runNotice({ kind: 'cancelled', reason: 'gone' }, choice, { notifications: false, cancelNotice: false })
    expect(refused).toEqual({ title: 'gone', tone: 'warning' })
    const failed = runNotice({ kind: 'failed', reason: 'no target' }, choice, { notifications: false, cancelNotice: false })
    expect(failed?.title).toBe('no target')
    expect(failed?.tone).toBe('danger')
    expect(failed?.description).toContain(choice.name)
  })
})

function category(id: string, name: string): NoteTemplateCategory {
  return { id, name, builtin: false, position: 0, createdAt: 1 }
}

function template(id: string, name: string, categoryId: string | null): NoteTemplate {
  return {
    id, categoryId, name, description: '', content: `${id} body`, builtin: false,
    isPinned: false, isStarred: false, tags: [], createdAt: 1, updatedAt: 1,
  }
}

const LIBRARY = {
  categories: [category('cat-j', 'Journal'), category('cat-w', 'Work')],
  templates: [
    template('t-beta', 'Beta', 'cat-j'),
    template('t-alpha', 'Alpha', 'cat-j'),
    template('t-loose', 'Loose', null),
    template('t-dead', 'Orphan', 'cat-gone'),
    template('t-blank', '   ', 'cat-w'),
  ],
}

describe('the template list the port offers a pick', () => {
  const original = useNoteTemplates.getState()

  // Seeded per test, not once: the teardown hands the store back, and a beforeAll seed would leave
  // every test after the first one choosing from an empty library.
  beforeEach(() => {
    useNoteTemplates.setState({ categories: LIBRARY.categories, templates: LIBRARY.templates })
  })

  afterEach(() => {
    useNoteTemplates.setState(original)
  })

  it('keeps every named template when no category is set, sorted by name', () => {
    expect(notePort.templatesForPick(null).map((entry) => entry.id)).toEqual(['t-alpha', 't-beta', 't-loose', 't-dead'])
  })

  it('filters by category and names each row’s own', () => {
    expect(notePort.templatesForPick('cat-j')).toEqual([
      { id: 't-alpha', name: 'Alpha', category: 'Journal' },
      { id: 't-beta', name: 'Beta', category: 'Journal' },
    ])
  })

  it('answers nothing for a category whose only template has no name', () => {
    expect(notePort.templatesForPick('cat-w')).toEqual([])
  })

  it('still offers the templates of a category that was deleted', () => {
    expect(notePort.templatesForPick('cat-gone'), 'the category is gone; what points at it is not')
      .toEqual([{ id: 't-dead', name: 'Orphan', category: null }])
  })

  it('keeps an orphaned template in the whole library without inventing a category', () => {
    const orphan = notePort.templatesForPick(null).find((entry) => entry.id === 't-dead')
    expect(orphan?.category, 'the category it points at is gone; the template is not').toBeNull()
  })
})
