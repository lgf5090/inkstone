import { describe, expect, it } from 'vitest'
import type { Folder, Note, NoteTemplate } from '@shared/types'
import type { Capabilities, CapabilityProfile, RunMode } from '../protocol'
import {
  CAPABILITY_PROFILES,
  RUN_MODE_NUMBERS,
  capabilitiesFor,
  frozenTitleFor,
  resolveRunRules,
  runModeNumber,
} from './run-context'
import { buildNoteIndex } from './note-index'
import { buildRunSnapshot } from './snapshot'
import { noteIndexEntry } from './file-wrapper'

const PROFILE_KEYS: CapabilityProfile[] = ['local', 'community', 'preview', 'dynamic', 'startup']
const MODES: RunMode[] = ['create-new', 'append-active', 'overwrite-file', 'overwrite-active', 'dynamic-processor', 'startup']
const CAPABILITY_KEYS = Object.keys(CAPABILITY_PROFILES.local)

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

describe('capability profiles', () => {
  it('answers every profile with every capability', () => {
    for (const profile of PROFILE_KEYS) {
      expect(Object.keys(CAPABILITY_PROFILES[profile]).sort()).toEqual([...CAPABILITY_KEYS].sort())
    }
  })

  /**
   * The approved matrix, plan §D15, one row per profile.
   *
   * Stated as a table rather than a list of `expect(...)` calls because the row is the decision: when
   * someone widens a profile, the diff shows which column of which surface moved, and a reviewer can
   * check that against the plan without re-deriving the policy from the source.
   */
  const MATRIX: Record<CapabilityProfile, Capabilities> = {
    local: { writeActiveNote: true, createNotes: true, moveNotes: true, readOtherNotes: true, prompt: true, web: true, userScripts: true, clipboard: true },
    community: { writeActiveNote: false, createNotes: false, moveNotes: false, readOtherNotes: false, prompt: true, web: false, userScripts: false, clipboard: false },
    preview: { writeActiveNote: false, createNotes: false, moveNotes: false, readOtherNotes: false, prompt: true, web: false, userScripts: false, clipboard: false },
    dynamic: { writeActiveNote: false, createNotes: false, moveNotes: false, readOtherNotes: false, prompt: true, web: false, userScripts: false, clipboard: false },
    startup: { writeActiveNote: true, createNotes: true, moveNotes: true, readOtherNotes: true, prompt: false, web: false, userScripts: true, clipboard: false },
  }

  it('matches the approved capability matrix cell for cell', () => {
    for (const profile of PROFILE_KEYS) {
      expect(CAPABILITY_PROFILES[profile], profile).toEqual(MATRIX[profile])
    }
  })

  it('lets the reader own everything and a stranger nothing that leaves the note', () => {
    expect(Object.values(CAPABILITY_PROFILES.local).every(Boolean)).toBe(true)
    // A gallery template used without importing it: it may ask, and it may produce text. Nothing else.
    const granted = Object.entries(CAPABILITY_PROFILES.community).filter(([, on]) => on).map(([name]) => name)
    expect(granted).toEqual(['prompt'])
  })

  it('keeps an unattended run from asking, reaching out or reading the clipboard', () => {
    // Startup templates run with nobody at the keyboard, so a prompt would hang the launch and a network
    // call would be the reader's data leaving on a schedule they did not just press.
    const capabilities = CAPABILITY_PROFILES.startup
    expect(capabilities.prompt).toBe(false)
    expect(capabilities.web).toBe(false)
    expect(capabilities.clipboard).toBe(false)
    expect(capabilities.writeActiveNote).toBe(true)
    expect(capabilities.userScripts).toBe(true)
  })

  it('keeps preview and dynamic passes from writing, going online or reading the rest of the vault', () => {
    for (const profile of ['preview', 'dynamic'] as CapabilityProfile[]) {
      const capabilities = CAPABILITY_PROFILES[profile]
      expect(capabilities.writeActiveNote, profile).toBe(false)
      expect(capabilities.createNotes, profile).toBe(false)
      expect(capabilities.moveNotes, profile).toBe(false)
      expect(capabilities.web, profile).toBe(false)
      expect(capabilities.clipboard, profile).toBe(false)
      expect(capabilities.userScripts, profile).toBe(false)
      expect(capabilities.readOtherNotes, profile).toBe(false)
      // …while still allowing the one visible interaction an author needs when testing their own template.
      expect(capabilities.prompt, profile).toBe(true)
    }
  })

  it('hands out a copy, so a host cannot edit the table', () => {
    const capabilities = capabilitiesFor('preview')
    capabilities.writeActiveNote = true
    expect(CAPABILITY_PROFILES.preview.writeActiveNote).toBe(false)
  })
})

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
