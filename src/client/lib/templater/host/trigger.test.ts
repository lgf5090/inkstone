import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from '@shared/constants'
import type { TemplaterSettings } from '@shared/types'
import { decideTemplateForCreatedNote, type TemplateTriggerNote } from './trigger'

/**
 * The trigger answers one question — which template, or why not — so every case here is a pair: the state
 * that should produce a match, and the state that outranks it.
 *
 * Settings are built through `mergeSettings` rather than as literals, because that is the block the caller
 * actually holds: the ceilings and the row-dropping are then the real ones instead of a fixture that flatters
 * the module. The one exception is the last case, which hands over a row the sanitizer would have deleted,
 * since the type allows it and a second reader of this module may not run the sanitizer first.
 */

const ON = true

/** A reader's block, cleaned the way a stored profile is cleaned. */
const settings = (templater: Record<string, unknown>): TemplaterSettings =>
  mergeSettings({ templater }).templater

const note = (over: Partial<TemplateTriggerNote> = {}): TemplateTriggerNote => ({
  path: 'Daily/2026-10-21.md',
  folderId: 'f-daily',
  ancestorFolderIds: ['f-archive'],
  fromTemplateRun: false,
  ...over,
})

const FOLDER_RULES = settings({
  fileCreationMode: 'folder',
  folderTemplates: [{ folderId: 'f-daily', templateId: 'tpl-daily' }],
})

/** The settings the switch outranks: a pattern that cannot compile, and an exclusion that covers the note. */
const OTHERWISE_FATAL = settings({
  fileCreationMode: 'regex',
  fileTemplates: [{ regex: '(', templateId: 'tpl-broken' }],
  ignoreFoldersOnCreation: ['f-daily'],
})

/** A note the exclusion above does not cover, so the pattern is what gets reached. */
const UNEXCLUDED_NOTE = note({ path: 'Work/Standup.md', folderId: 'f-work', ancestorFolderIds: [] })

describe('the device switch, which decides before anything else is read', () => {
  it('refuses with device-off whatever the rules would have answered', () => {
    // Two notes, each of which would produce a different tag if the switch were not first: this one is
    // excluded by folder, the other would reach the pattern that cannot compile.
    expect(decideTemplateForCreatedNote(note(), OTHERWISE_FATAL, false)).toEqual({
      kind: 'refuse',
      reason: 'device-off',
    })
    expect(decideTemplateForCreatedNote(UNEXCLUDED_NOTE, OTHERWISE_FATAL, false)).toEqual({
      kind: 'refuse',
      reason: 'device-off',
    })
  })

  it('answers with the exclusion as soon as the device says yes', () => {
    expect(decideTemplateForCreatedNote(note(), OTHERWISE_FATAL, ON)).toEqual({
      kind: 'refuse',
      reason: 'ignored-folder',
    })
  })

  it('answers with the broken pattern when nothing excludes the note', () => {
    expect(decideTemplateForCreatedNote(UNEXCLUDED_NOTE, OTHERWISE_FATAL, ON)).toEqual({
      kind: 'refuse',
      reason: 'invalid-pattern',
      ruleIndex: 0,
      pattern: '(',
    })
  })

  it('applies the folder rule once the device says yes', () => {
    expect(decideTemplateForCreatedNote(note(), FOLDER_RULES, ON)).toEqual({
      kind: 'apply',
      templateId: 'tpl-daily',
      ruleIndex: 0,
    })
  })
})

describe('the matching mode', () => {
  it('refuses with mode-none even when a rule matches', () => {
    const decision = decideTemplateForCreatedNote(
      note(),
      settings({ fileCreationMode: 'none', folderTemplates: [{ folderId: 'f-daily', templateId: 'tpl-daily' }] }),
      ON,
    )
    expect(decision).toEqual({ kind: 'refuse', reason: 'mode-none' })
  })

  it('refuses an untouched settings block, whose mode is none and whose lists are empty', () => {
    expect(decideTemplateForCreatedNote(note(), DEFAULT_SETTINGS.templater, ON)).toEqual({
      kind: 'refuse',
      reason: 'mode-none',
    })
  })

  it('matches nothing when a mode is chosen but its list is empty', () => {
    for (const fileCreationMode of ['folder', 'regex'] as const) {
      expect(decideTemplateForCreatedNote(note(), settings({ fileCreationMode }), ON)).toEqual({
        kind: 'refuse',
        reason: 'no-rule-matched',
      })
    }
  })

  it('reads only its own list, so a mode never consults the other rules', () => {
    // The pattern would throw. Folder mode never compiles it, which is what makes the two lists
    // independent rather than one list of hazards.
    const decision = decideTemplateForCreatedNote(
      note(),
      settings({
        fileCreationMode: 'folder',
        folderTemplates: [{ folderId: 'f-daily', templateId: 'tpl-daily' }],
        fileTemplates: [{ regex: '((', templateId: 'tpl-broken' }],
      }),
      ON,
    )
    expect(decision).toEqual({ kind: 'apply', templateId: 'tpl-daily', ruleIndex: 0 })
  })
})

describe('folder rules, where the nearest folder wins', () => {
  it('applies the rule for the folder the note itself is in', () => {
    expect(decideTemplateForCreatedNote(note(), FOLDER_RULES, ON)).toEqual({
      kind: 'apply',
      templateId: 'tpl-daily',
      ruleIndex: 0,
    })
  })

  it('inherits a rule from an ancestor folder, which is the walk up the tree', () => {
    const decision = decideTemplateForCreatedNote(
      note({ folderId: 'f-daily', ancestorFolderIds: ['f-inbox'] }),
      settings({
        fileCreationMode: 'folder',
        folderTemplates: [{ folderId: 'f-inbox', templateId: 'tpl-inbox' }],
      }),
      ON,
    )
    expect(decision).toEqual({ kind: 'apply', templateId: 'tpl-inbox', ruleIndex: 0 })
  })

  it('prefers the deepest folder when both a parent and a child have a rule', () => {
    const decision = decideTemplateForCreatedNote(
      note({ folderId: 'f-child', ancestorFolderIds: ['f-parent'] }),
      settings({
        fileCreationMode: 'folder',
        folderTemplates: [
          // The parent's row comes first on purpose: depth, not list order, is what decides.
          { folderId: 'f-parent', templateId: 'tpl-parent' },
          { folderId: 'f-child', templateId: 'tpl-child' },
        ],
      }),
      ON,
    )
    expect(decision).toEqual({ kind: 'apply', templateId: 'tpl-child', ruleIndex: 1 })
  })

  it('takes the first of two rules for the same folder, in the order they were written', () => {
    const decision = decideTemplateForCreatedNote(
      note({ folderId: 'f-twice', ancestorFolderIds: [] }),
      settings({
        fileCreationMode: 'folder',
        folderTemplates: [
          { folderId: 'f-twice', templateId: 'tpl-first' },
          { folderId: 'f-twice', templateId: 'tpl-second' },
        ],
      }),
      ON,
    )
    expect(decision).toEqual({ kind: 'apply', templateId: 'tpl-first', ruleIndex: 0 })
  })

  it('applies a root rule to a note filed at the tree root', () => {
    const decision = decideTemplateForCreatedNote(
      note({ path: 'Loose.md', folderId: null, ancestorFolderIds: [] }),
      settings({ fileCreationMode: 'folder', folderTemplates: [{ folderId: null, templateId: 'tpl-root' }] }),
      ON,
    )
    expect(decision).toEqual({ kind: 'apply', templateId: 'tpl-root', ruleIndex: 0 })
  })

  it('treats a root rule as the catch-all only for notes with no folder of their own', () => {
    const decision = decideTemplateForCreatedNote(
      note({ folderId: 'f-deep', ancestorFolderIds: ['f-parent'] }),
      settings({
        fileCreationMode: 'folder',
        folderTemplates: [
          { folderId: null, templateId: 'tpl-root' },
          { folderId: 'f-deep', templateId: 'tpl-deep' },
        ],
      }),
      ON,
    )
    expect(decision).toEqual({ kind: 'apply', templateId: 'tpl-deep', ruleIndex: 1 })
  })

  it('does not match a rule whose folder has been deleted, since the chain has no such id', () => {
    // The module sees no tree, so a stale row cannot fire anywhere: the note lives in `f-daily`, the rule
    // names `f-gone`, and the only honest answer is that nothing matched.
    const decision = decideTemplateForCreatedNote(
      note(),
      settings({
        fileCreationMode: 'folder',
        folderTemplates: [{ folderId: 'f-gone', templateId: 'tpl-gone' }],
      }),
      ON,
    )
    expect(decision).toEqual({ kind: 'refuse', reason: 'no-rule-matched' })
  })

  it('does not fall through to the root when the note has a folder and no ancestor rule', () => {
    const decision = decideTemplateForCreatedNote(
      note(),
      settings({ fileCreationMode: 'folder', folderTemplates: [{ folderId: 'f-somewhere-else', templateId: 'tpl-x' }] }),
      ON,
    )
    expect(decision).toEqual({ kind: 'refuse', reason: 'no-rule-matched' })
  })
})

describe('pattern rules, which run in the order the reader wrote them', () => {
  it('applies the first pattern that matches when two of them do', () => {
    const decision = decideTemplateForCreatedNote(
      note({ path: 'Daily/2026-10-21.md' }),
      settings({
        fileCreationMode: 'regex',
        fileTemplates: [
          { regex: '2026', templateId: 'tpl-year' },
          { regex: '^Daily/', templateId: 'tpl-folder' },
        ],
      }),
      ON,
    )
    expect(decision).toEqual({ kind: 'apply', templateId: 'tpl-year', ruleIndex: 0 })
  })

  it('tests the whole virtual path, unanchored, so a bare word matches a folder segment', () => {
    const decision = decideTemplateForCreatedNote(
      note({ path: 'Notes/Daily/Today.md', folderId: 'f-today', ancestorFolderIds: [] }),
      settings({ fileCreationMode: 'regex', fileTemplates: [{ regex: 'Daily', templateId: 'tpl-daily' }] }),
      ON,
    )
    expect(decision).toEqual({ kind: 'apply', templateId: 'tpl-daily', ruleIndex: 0 })
  })

  it('applies a catch-all pattern the way upstream tells readers to write one', () => {
    const decision = decideTemplateForCreatedNote(
      note({ path: 'nowhere.md', folderId: null, ancestorFolderIds: [] }),
      settings({ fileCreationMode: 'regex', fileTemplates: [{ regex: '.*', templateId: 'tpl-all' }] }),
      ON,
    )
    expect(decision).toEqual({ kind: 'apply', templateId: 'tpl-all', ruleIndex: 0 })
  })

  it('runs a slow pattern to exhaustion, because nothing here bounds one', () => {
    // The honest record of a gap rather than a claim of protection: `^(a+)+$` over a string written to make
    // it backtrack is the catastrophic case, and this module neither rejects it nor times it out — it hands
    // the pattern to `RegExp` and waits, exactly as upstream does. The only ceilings on it are the settings
    // ones (rows and characters), which were sized for the request body and say nothing about running time.
    // Eighteen characters keeps the exhaust question cheap here; the assertion is the answer, not a clock.
    const decision = decideTemplateForCreatedNote(
      note({ path: 'aaaaaaaaaaaaaaaaab', folderId: 'f-a', ancestorFolderIds: [] }),
      settings({ fileCreationMode: 'regex', fileTemplates: [{ regex: '^(a+)+$', templateId: 'tpl-slow' }] }),
      ON,
    )
    expect(decision).toEqual({ kind: 'refuse', reason: 'no-rule-matched' })
  })

  it('refuses by naming the rule whose pattern will not compile', () => {
    const decision = decideTemplateForCreatedNote(
      note(),
      settings({ fileCreationMode: 'regex', fileTemplates: [{ regex: '^(unclosed', templateId: 'tpl-broken' }] }),
      ON,
    )
    expect(decision).toEqual({
      kind: 'refuse',
      reason: 'invalid-pattern',
      ruleIndex: 0,
      pattern: '^(unclosed',
    })
  })

  it('refuses when the broken row is the one it reaches, after testing the rows above it', () => {
    const decision = decideTemplateForCreatedNote(
      note(),
      settings({
        fileCreationMode: 'regex',
        fileTemplates: [
          { regex: '^Weekly/', templateId: 'tpl-weekly' },
          { regex: '[a-', templateId: 'tpl-broken' },
        ],
      }),
      ON,
    )
    expect(decision).toEqual({ kind: 'refuse', reason: 'invalid-pattern', ruleIndex: 1, pattern: '[a-' })
  })

  it('applies the row above a broken one, which upstream already had', () => {
    const decision = decideTemplateForCreatedNote(
      note(),
      settings({
        fileCreationMode: 'regex',
        fileTemplates: [
          { regex: '^Daily/', templateId: 'tpl-daily' },
          { regex: '[a-', templateId: 'tpl-broken' },
        ],
      }),
      ON,
    )
    expect(decision).toEqual({ kind: 'apply', templateId: 'tpl-daily', ruleIndex: 0 })
  })

  it('refuses a pattern that matches nothing rather than guessing at a near miss', () => {
    const decision = decideTemplateForCreatedNote(
      note({ path: 'Daily/2026-10-21.md' }),
      settings({ fileCreationMode: 'regex', fileTemplates: [{ regex: '^Journal/', templateId: 'tpl-journal' }] }),
      ON,
    )
    expect(decision).toEqual({ kind: 'refuse', reason: 'no-rule-matched' })
  })
})

describe('excluded folders, which outrank a matching rule', () => {
  it('refuses a note in an excluded folder even though its rule matches', () => {
    const decision = decideTemplateForCreatedNote(
      note(),
      settings({
        fileCreationMode: 'folder',
        folderTemplates: [{ folderId: 'f-daily', templateId: 'tpl-daily' }],
        ignoreFoldersOnCreation: ['f-daily'],
      }),
      ON,
    )
    expect(decision).toEqual({ kind: 'refuse', reason: 'ignored-folder' })
  })

  it('excludes the whole subtree, so an ancestor on the list is enough', () => {
    const decision = decideTemplateForCreatedNote(
      note({ folderId: 'f-child', ancestorFolderIds: ['f-parent', 'f-top'] }),
      settings({
        fileCreationMode: 'folder',
        folderTemplates: [{ folderId: 'f-child', templateId: 'tpl-child' }],
        ignoreFoldersOnCreation: ['f-parent'],
      }),
      ON,
    )
    expect(decision).toEqual({ kind: 'refuse', reason: 'ignored-folder' })
  })

  it('excludes in pattern mode too, whatever the mode that would have matched', () => {
    const decision = decideTemplateForCreatedNote(
      note(),
      settings({
        fileCreationMode: 'regex',
        fileTemplates: [{ regex: '^Daily/', templateId: 'tpl-daily' }],
        ignoreFoldersOnCreation: ['f-daily'],
      }),
      ON,
    )
    expect(decision).toEqual({ kind: 'refuse', reason: 'ignored-folder' })
  })

  it('compares ids exactly, so a sibling with a similar name is not excluded', () => {
    // Upstream asked whether the note's path started with the excluded path, which made `/notes` exclude
    // `/notes-archive/x.md` as well. Ids are whole values, so the boundary mistake cannot be repeated.
    const decision = decideTemplateForCreatedNote(
      note({ folderId: 'notes-archive', ancestorFolderIds: [] }),
      settings({
        fileCreationMode: 'folder',
        folderTemplates: [{ folderId: 'notes-archive', templateId: 'tpl-archive' }],
        ignoreFoldersOnCreation: ['notes'],
      }),
      ON,
    )
    expect(decision).toEqual({ kind: 'apply', templateId: 'tpl-archive', ruleIndex: 0 })
  })

  it('answers mode-none before an exclusion, because the mode is the earlier no', () => {
    const decision = decideTemplateForCreatedNote(
      note(),
      settings({ fileCreationMode: 'none', ignoreFoldersOnCreation: ['f-daily'] }),
      ON,
    )
    expect(decision).toEqual({ kind: 'refuse', reason: 'mode-none' })
  })
})

describe('recursion, which is not the reader asking for a note', () => {
  it('refuses a creation that came out of a template run even when its rule matches', () => {
    const decision = decideTemplateForCreatedNote(
      note({ fromTemplateRun: true }),
      settings({
        fileCreationMode: 'regex',
        fileTemplates: [{ regex: '.*', templateId: 'tpl-all' }],
      }),
      ON,
    )
    expect(decision).toEqual({ kind: 'refuse', reason: 'template-run-creation' })
  })

  it('names the recursion before the exclusion, because the flag is the earlier fact', () => {
    const decision = decideTemplateForCreatedNote(
      note({ fromTemplateRun: true }),
      settings({
        fileCreationMode: 'folder',
        folderTemplates: [{ folderId: 'f-daily', templateId: 'tpl-daily' }],
        ignoreFoldersOnCreation: ['f-daily'],
      }),
      ON,
    )
    expect(decision).toEqual({ kind: 'refuse', reason: 'template-run-creation' })
  })

  it('lets an ordinary creation through the same settings', () => {
    expect(decideTemplateForCreatedNote(note(), FOLDER_RULES, ON).kind).toBe('apply')
  })
})

describe('a row that has no template to apply', () => {
  it('is not a rule, so an empty id is never handed back', () => {
    // `mergeSettings` drops such a row; the type still allows it, and the answer this module must never give
    // is `apply` with nothing to apply.
    const raw: TemplaterSettings = {
      ...DEFAULT_SETTINGS.templater,
      fileCreationMode: 'folder',
      folderTemplates: [{ folderId: 'f-daily', templateId: '' }],
      fileTemplates: [{ regex: '^Daily/', templateId: '' }],
    }
    expect(decideTemplateForCreatedNote(note(), raw, ON)).toEqual({ kind: 'refuse', reason: 'no-rule-matched' })
    expect(decideTemplateForCreatedNote(note(), { ...raw, fileCreationMode: 'regex' }, ON)).toEqual({
      kind: 'refuse',
      reason: 'no-rule-matched',
    })
  })
})
