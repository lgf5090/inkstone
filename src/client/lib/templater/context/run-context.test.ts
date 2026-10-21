import { describe, expect, it } from 'vitest'
import type { Folder, Note, NoteTemplate } from '@shared/types'
import type { RunMode } from '../protocol'
import {
  RUN_MODE_NUMBERS,
  frozenTitleFor,
  resolveRunRules,
  runModeNumber,
} from './run-context'
import { buildNoteIndex } from './note-index'
import { buildRunSnapshot } from './snapshot'
import { noteIndexEntry } from './file-wrapper'

const MODES: RunMode[] = ['create-new', 'append-active', 'overwrite-file', 'overwrite-active', 'dynamic-processor', 'startup']

function note(overrides: Partial<Note> & { id: string }): Note {
  return {
    title: 'note',
    excerpt: '',
    folderId: null,
    tags: [],
    isPinned: false,
    isStarred: false,
    isArchived: false,
    wordCount: 0,
    charCount: 0,
    rev: 1,
    position: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    deletedAt: null,
    content: '',
    ...overrides,
  }
}

function template(overrides: Partial<NoteTemplate> & { id: string; name: string }): NoteTemplate {
  return {
    categoryId: null,
    description: '',
    content: '',
    builtin: false,
    isPinned: false,
    isStarred: false,
    tags: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

const folder: Folder = {
  id: 'f-notes',
  parentId: null,
  name: 'notes',
  icon: null,
  color: null,
  position: 0,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
}

const emptyIndex = buildNoteIndex({ notes: [], folders: [] })

describe('run mode', () => {
  it('numbers the six modes the way upstream enumerates them', () => {
    // `src/core/Templater.ts:32`: CreateNewFromTemplate, AppendActiveFile, OverwriteFile,
    // OverwriteActiveFile, DynamicProcessor, StartupTemplate.
    expect(MODES.map(runModeNumber)).toEqual([0, 1, 2, 3, 4, 5])
    expect(RUN_MODE_NUMBERS['create-new']).toBe(0)
  })
})

describe('frozen title', () => {
  it('prefers the name the page says the note is about to get', () => {
    expect(frozenTitleFor({ target: note({ id: 'n1', title: 'old' }), template: null, frozenTitle: '  Daily  ' })).toBe('Daily')
  })

  it('falls back to the target, then the template, then nothing', () => {
    expect(frozenTitleFor({ target: note({ id: 'n1', title: 'Meeting' }), template: template({ id: 't1', name: 'Daily' }) })).toBe('Meeting')
    expect(frozenTitleFor({ target: null, template: template({ id: 't1', name: 'Daily' }) })).toBe('Daily')
    expect(frozenTitleFor({ target: null, template: null })).toBe('')
    // A blank title is no title, so a template run is not named after the empty string.
    expect(frozenTitleFor({ target: note({ id: 'n1', title: '  ' }), template: template({ id: 't1', name: 'Daily' }) })).toBe('Daily')
  })

  it('survives a rename inside the run, which is what upstream pins', () => {
    // `file.e2e.ts:27`: `<% tp.file.title %><%* await tp.file.rename("new name") %><% tp.file.title %>`
    // renders `old name` twice. The row the store holds afterwards is the new name; the run must not see it.
    const target = note({ id: 'n1', title: 'old name', folderId: 'f-notes', content: '\n' })
    const context = buildRunSnapshot({
      runId: 'run-1',
      notes: [target],
      folders: [folder],
      templates: [],
      target,
      active: target,
      template: null,
      mode: 'overwrite-active',
      capabilities: 'local',
      locale: 'en-US',
      startedAt: 1_700_000_000_000,
    })
    expect(context.frozenTitle).toBe('old name')

    target.title = 'new name'
    target.updatedAt = 1_800_000_000_000

    expect(context.frozenTitle).toBe('old name')
    expect(context.target?.title).toBe('old name')
    expect(context.target?.updatedAt).toBe(1_700_000_000_000)
    expect(context.index.find((item) => item.id === 'n1')?.path).toBe('notes/old name.md')
  })
})

describe('run rules', () => {
  it('resolves the target and active refs and their paths from the index', () => {
    const target = note({ id: 'n1', title: 'Meeting', folderId: 'f-notes', content: '# Agenda\n' })
    const index = buildNoteIndex({
      notes: [noteIndexEntry(target, 'notes/Meeting.md')],
      folders: [{ id: 'f-notes', name: 'notes', parentId: null, path: 'notes' }],
    })
    const rules = resolveRunRules({
      mode: 'append-active',
      capabilities: 'community',
      locale: 'zh-CN',
      startedAt: 1_700_000_000_000,
      target,
      active: target,
      template: template({ id: 't1', name: 'Daily', content: '<% tp.file.title %>' }),
      index,
    })
    expect(rules.mode).toBe('append-active')
    expect(rules.runMode).toBe(1)
    expect(rules.profile).toBe('community')
    expect(rules.capabilities.writeActiveNote).toBe(false)
    expect(rules.frozenTitle).toBe('Meeting')
    expect(rules.target?.content).toBe('# Agenda\n')
    expect(rules.targetPath).toBe('notes/Meeting.md')
    expect(rules.activePath).toBe('notes/Meeting.md')
    expect(rules.templateFile?.title).toBe('Daily')
  })

  it('leaves a run with no rows without refs', () => {
    const rules = resolveRunRules({
      mode: 'dynamic-processor',
      capabilities: 'dynamic',
      locale: 'en-US',
      startedAt: 1_700_000_000_000,
      target: null,
      active: null,
      template: null,
      index: emptyIndex,
    })
    expect(rules.target).toBeNull()
    expect(rules.active).toBeNull()
    expect(rules.templateFile).toBeNull()
    expect(rules.targetPath).toBeNull()
    expect(rules.frozenTitle).toBe('')
  })

  it('reports no path when the index does not hold the row', () => {
    // Only reachable if a caller builds rules over an index the target was never added to, which
    // `buildRunSnapshot` prevents; the answer is still "unknown", not a guessed path.
    const rules = resolveRunRules({
      mode: 'overwrite-file',
      capabilities: 'local',
      locale: 'en-US',
      startedAt: 1_700_000_000_000,
      target: note({ id: 'ghost' }),
      active: null,
      template: null,
      index: emptyIndex,
    })
    expect(rules.targetPath).toBeNull()
    expect(rules.target?.id).toBe('ghost')
  })
})
