// @vitest-environment jsdom
/**
 * The diary's two AI entries.
 *
 * What is worth pinning is where the answer lands: in today's diary, under a heading of its own, and
 * replacing the previous entry under that heading rather than stacking a second one. The reader's own
 * words in the same note have to survive both the write and the replacement, which is why the section
 * ends at the next heading of the same level and not at the next `#`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { dateKey } from '../../lib/time'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { summarizeToday, upsertSection } from './diary-ai'

const { ask, answer } = vi.hoisted(() => ({
  // The real channel answers with trimmed text or nothing, which is what the caller checks.
  ask: vi.fn(async (_noteId: string, _prompt: string) => answer.current.trim() || null),
  answer: { current: '' },
}))

vi.mock('../chat/note-ai', () => ({ askAboutNote: (noteId: string, prompt: string) => ask(noteId, prompt) }))

const notesOriginal = useNotes.getState()
const uiOriginal = useUi.getState()
const editContent = vi.fn()
const openNote = vi.fn(async () => undefined)

beforeEach(async () => {
  await initI18n()
  editContent.mockReset()
  ask.mockClear()
  answer.current = '- shipped the plan'
  useNotes.setState({ notes: {}, contents: {}, editContent, openNote })
})

afterEach(() => {
  useNotes.setState(notesOriginal, true)
  useUi.setState(uiOriginal, true)
})

describe('upsertSection', () => {
  it('appends the heading when the note does not have it', () => {
    expect(upsertSection('my own words\n', '## Today', '- a')).toBe('my own words\n\n## Today\n\n- a\n')
  })

  it('replaces the body under the heading and leaves the rest of the note alone', () => {
    const content = 'intro\n\n## Today\n\nold body\n\n### still mine\n\ndetail\n\n## Later\n\nkeep\n'
    expect(upsertSection(content, '## Today', '- new')).toBe('intro\n\n## Today\n\n- new\n\n## Later\n\nkeep\n')
  })

  it('replaces an entry at the end of the note', () => {
    expect(upsertSection('## Today\n\nold\n', '## Today', '- new')).toBe('## Today\n\n- new\n')
  })
})

describe('summarizing today', () => {
  it('writes the answer into the day\'s diary and names the day\'s notes in the prompt', async () => {
    const key = dateKey(new Date())
    const diaryId = '01hzzzzzzzzzzzzzzzzzzzzz03'
    useNotes.setState({
      notes: {
        [diaryId]: { id: diaryId, title: t('sidebar.diary_title_value0', { value0: key }), updatedAt: Date.now() } as never,
        n2: { id: 'n2', title: 'Hiring plan', updatedAt: Date.now() } as never,
      },
      contents: { [diaryId]: '## Today\n\nold\n' },
    })
    expect(await summarizeToday()).toBe(true)
    expect(openNote).toHaveBeenCalledWith(diaryId)
    expect(ask.mock.calls[0]![1]).toContain('[[Hiring plan]]')
    expect(editContent).toHaveBeenCalledWith(diaryId, '## Today\n\n- shipped the plan\n')
  })

  it('writes nothing when the answer is empty', async () => {
    const key = dateKey(new Date())
    const diaryId = '01hzzzzzzzzzzzzzzzzzzzzz04'
    useNotes.setState({
      notes: { [diaryId]: { id: diaryId, title: t('sidebar.diary_title_value0', { value0: key }), updatedAt: Date.now() } as never },
      contents: { [diaryId]: '' },
    })
    answer.current = '   '
    const toast = vi.spyOn(useUi.getState(), 'toast')
    expect(await summarizeToday()).toBe(false)
    expect(editContent).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalled()
  })
})
