/**
 * What a turn carries beyond the reader's standing scope.
 *
 * Two shapes are pinned here. The first is the list of notes a turn may reach past its folder scope, which
 * is the one promise a context chip makes: adding a note to the turn is the reader pointing at a page, so
 * it must not be silently dropped because the page sits in a folder the assistant was not given. The
 * second is the line the model is told about those chips — a chip the prompt never mentions is a chip that
 * costs a request and changes no answer.
 *
 * Neither half needs a database, which is why this file runs everywhere: the SQL that reads the notes back
 * is the note tools' own gate, exercised in `assistant-note-scope.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../src/shared/assistant-prompt'
import { turnNoteIds } from '../src/worker/assistant/note-scope'

const NOTE = '01hzzzzzzzzzzzzzzzzzzzzz11'
const OTHER = '01hzzzzzzzzzzzzzzzzzzzzz12'
const FOLDER = '01hzzzzzzzzzzzzzzzzzzzzz01'

describe('the notes a turn may reach past its scope', () => {
  it('is the note on screen, the chips, or both', () => {
    expect(turnNoteIds(NOTE, [])).toEqual([NOTE])
    expect(turnNoteIds(null, [{ kind: 'note', id: OTHER }])).toEqual([OTHER])
    expect(turnNoteIds(NOTE, [{ kind: 'note', id: OTHER }])).toEqual([NOTE, OTHER])
  })

  it('ignores the pins that are not notes', () => {
    expect(turnNoteIds(null, [{ kind: 'folder', id: FOLDER }, { kind: 'tag', id: FOLDER }])).toEqual([])
  })

  it('lists a note once even when it is both open and pinned', () => {
    expect(turnNoteIds(NOTE, [{ kind: 'note', id: NOTE }])).toEqual([NOTE])
  })

  it('drops anything that is not shaped like an id, because the list is bound into SQL', () => {
    expect(turnNoteIds(null, [{ kind: 'note', id: "x' OR 1=1 --" }])).toEqual([])
  })
})

describe('what the prompt says about them', () => {
  const base = {
    agentName: 'Inkstone',
    language: 'en-US' as const,
    timezone: 'Asia/Shanghai',
    localTime: '2026-10-17 09:00',
    autoMemory: false,
    memories: [],
    noteScope: [],
  }

  it('names each pinned note, so the model reads them instead of searching', () => {
    const prompt = buildSystemPrompt({ ...base, pinnedNotes: [{ id: NOTE, title: 'Quarterly plan' }] })
    expect(prompt).toContain('Quarterly plan')
    expect(prompt).toContain(NOTE)
  })

  it('says nothing about chips when there are none', () => {
    expect(buildSystemPrompt({ ...base, pinnedNotes: [] })).not.toContain('pinned these notes')
  })
})
