import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, LIMITS, SETTINGS_REQUEST_BUDGET_BYTES, mergeSettings, mergeSettingsPatch } from './constants'
import { utf8ByteLength } from './text-utils'
import type { UserSettings } from './types'

/**
 * The templater section of a stored profile.
 *
 * Every list here is a set of references — a folder, a template, a chord — so the cases that matter are the
 * ones where a row cannot be used as written. Dropping it is the chosen answer, and each of these tests says
 * which half had to be wrong for the row to go: the guard tests for the ceilings themselves live beside the
 * ceilings in `./constants.ts`.
 */
const templater = (settings: Record<string, unknown>) => mergeSettings(settings).templater

describe('the templater section of a stored profile', () => {
  it('starts with the dangerous answers set to off', () => {
    expect(DEFAULT_SETTINGS.templater.webRequestsEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.templater.communityScriptPolicy).toBe('readonly')
    expect(DEFAULT_SETTINGS.templater.fileCreationMode).toBe('none')
    expect(DEFAULT_SETTINGS.templater.syntaxHighlightingMobile).toBe(false)
  })

  it('carries no trigger, no startup row and no chord until the reader adds one', () => {
    expect(DEFAULT_SETTINGS.templater.folderTemplates).toEqual([])
    expect(DEFAULT_SETTINGS.templater.fileTemplates).toEqual([])
    expect(DEFAULT_SETTINGS.templater.startupTemplates).toEqual([])
    expect(DEFAULT_SETTINGS.templater.templateHotkeys).toEqual([])
    expect(DEFAULT_SETTINGS.templater.userScriptsFolderId).toBeNull()
  })

  it('lets a trigger list survive a settings patch, not just a whole-profile merge', () => {
    const rows = [{ folderId: 'f-1', templateId: 'tpl-1' }]
    const patched = mergeSettingsPatch(DEFAULT_SETTINGS, { templater: { folderTemplates: rows } })
    expect(patched.templater.folderTemplates).toEqual(rows)
  })

  it('keeps a folder rule that names the tree root', () => {
    const kept = templater({ templater: { folderTemplates: [{ folderId: null, templateId: 'tpl-1' }] } })
    expect(kept.folderTemplates).toEqual([{ folderId: null, templateId: 'tpl-1' }])
  })

  it('drops a rule with no template to apply, and one with no pattern to match', () => {
    expect(templater({ templater: { folderTemplates: [{ folderId: 'f-1' }] } }).folderTemplates).toEqual([])
    expect(templater({ templater: { fileTemplates: [{ regex: '^D', templateId: ' ' }] } }).fileTemplates).toEqual([])
    expect(templater({ templater: { fileTemplates: [{ regex: '   ', templateId: 'tpl-1' }] } }).fileTemplates).toEqual([])
  })

  it('keeps the first of two rules that name one template', () => {
    const kept = templater({
      templater: {
        folderTemplates: [
          { folderId: 'f-1', templateId: 'tpl-1' },
          { folderId: 'f-2', templateId: 'tpl-1' },
        ],
      },
    })
    expect(kept.folderTemplates).toEqual([{ folderId: 'f-1', templateId: 'tpl-1' }])
  })

  it('keeps the rows that fit and stops at the ceiling', () => {
    const rows = Array.from({ length: LIMITS.templaterFolderTriggersMax + 5 }, (_unused, index) => ({
      folderId: `f-${index}`,
      templateId: `tpl-${index}`,
    }))
    const kept = templater({ templater: { folderTemplates: rows } })
    expect(kept.folderTemplates).toHaveLength(LIMITS.templaterFolderTriggersMax)
    expect(kept.folderTemplates[0]).toEqual(rows[0])
  })

  it('refuses a pattern too long to store rather than cutting it into a different rule', () => {
    const long = 'a'.repeat(LIMITS.templaterRegexMaxLength + 1)
    expect(templater({ templater: { fileTemplates: [{ regex: long, templateId: 'tpl-1' }] } }).fileTemplates).toEqual([])
  })

  it('refuses a folder id too long to be one instead of filing the rule at the root', () => {
    const long = 'f'.repeat(LIMITS.templaterIdMaxLength + 1)
    const kept = templater({ templater: { folderTemplates: [{ folderId: long, templateId: 'tpl-1' }] } })
    expect(kept.folderTemplates).toEqual([])
  })

  it('answers "no chord" for a chord no key-catcher could have produced', () => {
    const long = 'Ctrl+'.repeat(20)
    const kept = templater({
      templater: { templateHotkeys: [{ templateId: 'tpl-1', combo: long, insert: true, create: false }] },
    })
    expect(kept.templateHotkeys).toEqual([{ templateId: 'tpl-1', combo: null, insert: true, create: false }])
  })

  it('keeps a half-filled chord row as the two-off row the reader is still writing', () => {
    const kept = templater({ templater: { templateHotkeys: [{ templateId: 'tpl-1', combo: 'Ctrl+Alt+D' }] } })
    expect(kept.templateHotkeys).toEqual([{ templateId: 'tpl-1', combo: 'Ctrl+Alt+D', insert: false, create: false }])
  })

  it('normalises the empty scripts folder to the one empty answer this app uses', () => {
    expect(templater({ templater: { userScriptsFolderId: '' } }).userScriptsFolderId).toBeNull()
    expect(templater({ templater: { userScriptsFolderId: '  ' } }).userScriptsFolderId).toBeNull()
    expect(templater({ templater: { userScriptsFolderId: 'f-scripts' } }).userScriptsFolderId).toBe('f-scripts')
  })

  it('refuses an unknown choice instead of storing it', () => {
    const kept = templater({
      templater: {
        fileCreationMode: 'everything',
        intellisenseRender: '9',
        communityScriptPolicy: 'yolo',
      },
    })
    expect(kept.fileCreationMode).toBe(DEFAULT_SETTINGS.templater.fileCreationMode)
    expect(kept.intellisenseRender).toBe(DEFAULT_SETTINGS.templater.intellisenseRender)
    expect(kept.communityScriptPolicy).toBe('readonly')
  })

  it('reads a non-list as an empty list, so a hand-edited blob cannot crash the panel', () => {
    const kept = templater({ templater: { startupTemplates: 'tpl-1', templateHotkeys: { templateId: 'tpl-1' } } })
    expect(kept.startupTemplates).toEqual([])
    expect(kept.templateHotkeys).toEqual([])
  })

  it('drops a repeated or blank id from a list of ids', () => {
    const kept = templater({ templater: { startupTemplates: ['a', ' a ', 'b', '', null, 'c'] } })
    expect(kept.startupTemplates).toEqual(['a', 'b', 'c'])
  })

  it('starts a fresh profile with no reference to another reader\'s rows', () => {
    const settings = mergeSettings({}) as UserSettings
    expect(settings.templater.folderTemplates).toEqual([])
    expect(settings.templater.webRequestsEnabled).toBe(false)
  })

  it('fits the whole group, filled to every ceiling, inside the settings request budget', () => {
    // The ceilings above are a claim about bytes, so this is the test that keeps them honest: every list at
    // full count, every id at full width, every pattern written in characters that cost three bytes each in
    // UTF-8. A reader must be able to save the group they were allowed to build.
    const wide = 'x'.repeat(LIMITS.templaterIdMaxLength)
    // A path pattern written in Chinese: the widest thing a reader would plausibly type here.
    const pattern = '档'.repeat(LIMITS.templaterRegexMaxLength)
    const group = {
      syntaxHighlighting: true,
      syntaxHighlightingMobile: true,
      autoJumpToCursor: true,
      jumpToContentAfterCreate: true,
      intellisenseRender: '4',
      fileCreationMode: 'regex',
      folderTemplates: Array.from({ length: LIMITS.templaterFolderTriggersMax }, (_unused, index) => ({
        folderId: `${wide}-${index}`.slice(0, LIMITS.templaterIdMaxLength),
        templateId: `tpl-${index}`,
      })),
      fileTemplates: Array.from({ length: LIMITS.templaterFileTriggersMax }, (_unused, index) => ({
        regex: pattern,
        templateId: `pat-${index}`,
      })),
      ignoreFoldersOnCreation: Array.from({ length: LIMITS.templaterIgnoredFoldersMax }, (_unused, index) => `ig-${index}`),
      startupTemplates: Array.from({ length: LIMITS.templaterStartupMax }, (_unused, index) => `su-${index}`),
      templateHotkeys: Array.from({ length: LIMITS.templaterHotkeysMax }, (_unused, index) => ({
        templateId: `hk-${index}`,
        combo: 'Ctrl+Shift+Alt+KeyZ',
        insert: true,
        create: true,
      })),
      userScriptsFolderId: wide,
      communityScriptPolicy: 'trusted',
      webRequestsEnabled: true,
    }
    const kept = mergeSettings({ templater: group }).templater
    // Nothing was dropped on the way in, so the size below really is the worst case this group can hold.
    expect(kept.folderTemplates).toHaveLength(LIMITS.templaterFolderTriggersMax)
    expect(kept.fileTemplates).toHaveLength(LIMITS.templaterFileTriggersMax)
    expect(kept.templateHotkeys).toHaveLength(LIMITS.templaterHotkeysMax)
    expect(kept.fileTemplates[0]!.regex).toBe(pattern)
    const bytes = utf8ByteLength(JSON.stringify({ templater: kept }))
    expect(bytes).toBeLessThan(SETTINGS_REQUEST_BUDGET_BYTES)
  })
})
