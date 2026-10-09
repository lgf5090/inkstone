import { describe, expect, it } from 'vitest'
import {
  QUICKADD_APP,
  QUICKADD_KIND,
  QUICKADD_LIMITS,
  buildQuickAddPayload,
  childrenOf,
  defaultQuickAddSettings,
  descendantIds,
  flattenChoices,
  newCaptureChoice,
  newGroupChoice,
  newMacroChoice,
  newTemplateChoice,
  normalizeQuickAddChoice,
  normalizeQuickAddSettings,
  parseQuickAddLibrary,
  parseQuickAddText,
  placeChoice,
  type QuickAddCaptureChoice,
  type QuickAddChoice,
  type QuickAddMacroChoice,
  type QuickAddTemplateChoice,
} from './quickadd'

function templateChoice(id: string, name: string, parentId: string | null = null): QuickAddChoice {
  return { ...newTemplateChoice(id, name, 0), parentId }
}

function groupChoice(id: string, name: string, parentId: string | null = null): QuickAddChoice {
  return { ...newGroupChoice(id, name, 0), parentId }
}

function parse(choices: QuickAddChoice[], settings = defaultQuickAddSettings()) {
  return parseQuickAddLibrary({ app: QUICKADD_APP, kind: QUICKADD_KIND, version: 1, settings, choices })
}

function idsOf(choices: QuickAddChoice[]): string[] {
  return choices.map((choice) => choice.id)
}

describe('the quickadd record', () => {
  it('round-trips a library through the payload', () => {
    const settings = defaultQuickAddSettings()
    settings.globalVars = [{ name: 'author', value: 'Me' }]
    const daily: QuickAddTemplateChoice = {
      ...newTemplateChoice('qa-t', 'Daily', 0),
      parentId: 'qa-g',
      folderPath: 'Journal/2026',
      tags: ['daily', 'Daily'],
    }
    const text = JSON.stringify(buildQuickAddPayload(settings, [groupChoice('qa-g', 'Journal'), daily]))
    const parsed = parseQuickAddText(text)

    expect(idsOf(flattenChoices(parsed.data?.choices ?? []))).toEqual(['qa-g', 'qa-t'])
    expect(parsed.data?.settings.globalVars).toEqual([{ name: 'author', value: 'Me' }])
    expect(parsed.data?.choices[1]).toMatchObject({ parentId: 'qa-g' })
    expect((parsed.data?.choices[1] as QuickAddTemplateChoice).folderPath).toBe('Journal/2026')
    expect(parsed.dropped).toBe(0)
    expect(parsed.truncated).toBe(false)
  })

  it('refuses a payload that is not a quickadd library', () => {
    expect(parseQuickAddText('{"kind":"template-library","choices":[]}').data).toBeNull()
    expect(parseQuickAddText('{"app":"other","kind":"quickadd","choices":[]}').data).toBeNull()
    expect(parseQuickAddText('not json').data).toBeNull()
    expect(parseQuickAddText('[]').data).toBeNull()
    expect(parseQuickAddText('"a string"').data).toBeNull()
  })

  it('drops unusable entries and says how many went', () => {
    const parsed = parse([
      templateChoice('qa-ok', 'Kept'),
      templateChoice('', 'No id'),
      templateChoice('qa noname', 'Space in id'),
      { ...templateChoice('qa-x', ''), id: 'qa-blank' },
      { id: 'qa-typetype', type: 'screenshot' } as unknown as QuickAddChoice,
      { id: 'qa-dup', name: 'A' } as QuickAddChoice,
      { id: 'qa-dup', name: 'B' } as QuickAddChoice,
    ])

    expect(idsOf(parsed.data?.choices ?? [])).toEqual(['qa-ok'])
    expect(parsed.dropped).toBe(6)
  })

  it('clamps what an editor or a hand-written file tried to stretch', () => {
    const parsed = parse([{
      ...newCaptureChoice('qa-c', 'x'.repeat(400), 3),
      targetTitle: 'a\r\nb',
      after: '## Log\t',
      format: { enabled: true, format: 'y'.repeat(QUICKADD_LIMITS.maxFormatLength + 5000) },
      createAt: 'nowhere' as never,
      hotkey: 'Shift+',
      position: -4,
    }])
    const choice = parsed.data?.choices[0] as QuickAddCaptureChoice

    expect(choice.name.length).toBe(QUICKADD_LIMITS.maxNameLength)
    expect(choice.targetTitle).toBe('a b')
    expect(choice.after).toBe('## Log')
    expect(choice.format.format.length).toBe(QUICKADD_LIMITS.maxFormatLength)
    expect(choice.createAt).toBe('bottom')
    expect(choice.hotkey).toBeNull()
    expect(choice.position).toBe(0)
  })

  it('never lets a folder path name a folder the tree does not show', () => {
    const parsed = parse([{ ...templateChoice('qa-t', 'T'), folderPath: 'a/../../b/../c' } as QuickAddTemplateChoice])
    expect((parsed.data?.choices[0] as QuickAddTemplateChoice).folderPath).toBe('a/b/c')
    expect((parse([{ ...templateChoice('qa-t', 'T'), folderPath: 'a\\..\\b' } as QuickAddTemplateChoice])
      .data?.choices[0] as QuickAddTemplateChoice).folderPath).toBe('a/b')
    const long = parse([{ ...templateChoice('qa-t', 'T'), folderPath: 'x/y/'.repeat(40) }] as QuickAddTemplateChoice[]).data?.choices[0] as QuickAddTemplateChoice
    expect(long.type).toBe('template')
    expect(long.folderPath.split('/').length).toBeLessThanOrEqual(25)
  })

  it('keeps a command step and flattens the id it names', () => {
    const parsed = parse([{
      ...newMacroChoice('qa-m', 'Routine', 0),
      steps: [{ kind: 'command', commandId: 'cmd-new\n' }],
    } as QuickAddChoice])
    const steps = (parsed.data?.choices[0] as QuickAddMacroChoice).steps
    expect(steps).toEqual([{ kind: 'command', commandId: 'cmd-new' }])
  })

  it('keeps a template pick legal and defaults the libraries that predate it', () => {
    const asked = parse([{ ...templateChoice('qa-a', 'A'), templatePick: 'ask' } as QuickAddTemplateChoice])
      .data?.choices[0] as QuickAddTemplateChoice
    expect(asked.templatePick).toBe('ask')
    const junk = parse([{ ...templateChoice('qa-b', 'B'), templatePick: 'sometimes' } as unknown as QuickAddTemplateChoice])
      .data?.choices[0] as QuickAddTemplateChoice
    expect(junk.templatePick, 'an unknown answer falls back to the named template').toBe('fixed')
    const legacy = parse([{ ...templateChoice('qa-c', 'C'), templatePick: undefined } as unknown as QuickAddTemplateChoice])
      .data?.choices[0] as QuickAddTemplateChoice
    expect(legacy.templatePick, 'a library saved before the option existed keeps working').toBe('fixed')
  })

  it('requires a modifier before it will store a hotkey', () => {
    const parsed = parse([
      { ...templateChoice('qa-a', 'A'), hotkey: 'Ctrl+Alt+J' } as QuickAddTemplateChoice,
      { ...templateChoice('qa-b', 'B'), hotkey: 'ctrl+j' } as QuickAddTemplateChoice,
      { ...templateChoice('qa-c', 'C'), hotkey: 'j' } as QuickAddTemplateChoice,
      { ...templateChoice('qa-d', 'D'), hotkey: 'cmd+shift+' } as QuickAddTemplateChoice,
    ])
    expect(parsed.data?.choices.map((choice) => choice.hotkey)).toEqual(['ctrl+alt+j', 'ctrl+j', null, null])
  })

  it('keeps template references it cannot verify and drops choice references it can', () => {
    const parsed = parse([
      { ...templateChoice('qa-t', 'T'), templateId: 'tpl-gone' } as QuickAddTemplateChoice,
      {
        id: 'qa-m',
        name: 'M',
        type: 'macro',
        parentId: null,
        position: 1,
        icon: null,
        color: null,
        enabled: true,
        asCommand: false,
        hotkey: null,
        dateOrigin: 'run',
        steps: [
          { kind: 'choice', choiceId: 'qa-t' },
          { kind: 'choice', choiceId: 'qa-nope' },
          { kind: 'set', variable: 'v', value: '1' },
        ],
      } as QuickAddChoice,
    ])
    const template = parsed.data?.choices.find((choice) => choice.id === 'qa-t')
    const macro = parsed.data?.choices.find((choice) => choice.id === 'qa-m')

    expect(template).toMatchObject({ templateId: 'tpl-gone' })
    expect(macro?.type === 'macro' && macro.steps.map((step) => step.kind)).toEqual(['choice', 'set'])
  })

  it('repairs a tree that points nowhere, at itself, or around a cycle', () => {
    const parsed = parse([
      { ...templateChoice('qa-orphan', 'Orphan'), parentId: 'qa-missing' } as QuickAddTemplateChoice,
      { ...templateChoice('qa-self', 'Self'), parentId: 'qa-self' } as QuickAddTemplateChoice,
      { ...groupChoice('qa-g1', 'G1'), parentId: 'qa-g2' } as QuickAddChoice,
      { ...groupChoice('qa-g2', 'G2'), parentId: 'qa-g1' } as QuickAddChoice,
    ])
    expect(parsed.data?.choices.map((choice) => [choice.id, choice.parentId]))
      .toEqual(expect.arrayContaining([['qa-orphan', null], ['qa-self', null], ['qa-g1', null]]))
    expect(flattenChoices(parsed.data?.choices ?? []).length).toBe(4)
  })

  it('refuses a child that is not in a group', () => {
    const parsed = parse([templateChoice('qa-t', 'T'), { ...templateChoice('qa-c', 'C'), parentId: 'qa-t' } as QuickAddTemplateChoice])
    expect(parsed.data?.choices.map((choice) => choice.parentId)).toEqual([null, null])
  })

  it('cuts a chain deeper than the limit', () => {
    const chain: QuickAddChoice[] = []
    let previous: string | null = null
    for (let index = 0; index < QUICKADD_LIMITS.maxDepth + 3; index += 1) {
      const id = `qa-g${index}`
      chain.push(groupChoice(id, `G${index}`, previous))
      previous = id
    }
    const parsed = parse(chain)
    const byId = new Map(parsed.data?.choices.map((choice) => [choice.id, choice]))
    const depthOf = (id: string): number => {
      const choice = byId.get(id)
      if (!choice?.parentId) return 0
      return depthOf(choice.parentId) + 1
    }

    expect(byId.get('qa-g0')?.parentId).toBeNull()
    expect(byId.get(`qa-g${QUICKADD_LIMITS.maxDepth}`)?.parentId).toBeNull()
    expect(Math.max(...chain.map((choice) => depthOf(choice.id)))).toBeLessThan(QUICKADD_LIMITS.maxDepth)
    expect(flattenChoices(parsed.data?.choices ?? []).length).toBe(chain.length)
  })

  it('renumbers each parent’s children from zero, keeping the requested order', () => {
    const parsed = parse([
      { ...templateChoice('qa-c', 'C'), position: 5 },
      { ...templateChoice('qa-a', 'A'), position: 7 },
      { ...templateChoice('qa-b', 'B'), position: 1, parentId: 'qa-g' },
    ].concat([groupChoice('qa-g', 'G', null)]))

    const byId = new Map(parsed.data?.choices.map((choice) => [choice.id, choice]))
    expect(byId.get('qa-g')?.position).toBe(0)
    expect(byId.get('qa-c')?.position).toBe(1)
    expect(byId.get('qa-a')?.position).toBe(2)
    expect(byId.get('qa-b')?.position).toBe(0)
    expect(idsOf(parsed.data?.choices ?? [])).toEqual(['qa-g', 'qa-b', 'qa-c', 'qa-a'])
    expect(byId.get('qa-b')?.parentId).toBe('qa-g')
  })

  it('trims the run history down to ids that still exist', () => {
    const settings = defaultQuickAddSettings()
    settings.recent = [{ id: 'qa-t', at: 10 }, { id: 'qa-gone', at: 20 }]
    const parsed = parse([templateChoice('qa-t', 'T')], settings)
    expect(parsed.data?.settings.recent).toEqual([{ id: 'qa-t', at: 10 }])
  })

  it('keeps global variables as an ordered list with unique names', () => {
    const settings = defaultQuickAddSettings()
    settings.globalVars = [
      { name: 'author', value: 'One' },
      { name: 'Author', value: 'Two' },
      { name: 'has space', value: 'Three' },
      { name: '', value: 'Four' },
    ]
    const parsed = parse([templateChoice('qa-t', 'T')], settings)
    expect(parsed.data?.settings.globalVars).toEqual([
      { name: 'author', value: 'One' },
      { name: 'has space', value: 'Three' },
    ])
    expect(normalizeQuickAddSettings({ globalVars: [{ name: '-leading', value: 'x' }] }).globalVars).toEqual([])
  })

  it('does not let a hostile record reach Object.prototype', () => {
    const text = '{'
      + '"app":"inkstone","kind":"quickadd","version":1,'
      + '"choices":[{"id":"qa-p","name":"P","type":"template","__proto__":{"polluted":"yes"}}],'
      + '"settings":{"globalVars":[{"name":"__proto__","value":"x"}]}'
      + '}'
    const parsed = parseQuickAddText(text)

    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(parsed.data?.settings.globalVars).toEqual([])
  })

  it('falls back to the shipped defaults for a settings block it cannot read', () => {
    expect(normalizeQuickAddSettings('nope').dateFormat).toBe(defaultQuickAddSettings().dateFormat)
    expect(normalizeQuickAddSettings({ dateFormat: '   ' }).dateFormat).toBe('YYYY-MM-DD')
    expect(normalizeQuickAddSettings({ onePage: 'sometimes' }).onePage).toBe('auto')
    expect(normalizeQuickAddSettings({ periodic: { daily: { folder: '../x', format: '' } } }).periodic.daily)
      .toEqual({ folder: 'x', format: 'YYYY-MM-DD', templateId: null })
  })

  it('keeps the category a template pick is limited to', () => {
    const scoped = normalizeQuickAddChoice({
      ...newTemplateChoice('qa-t', 'Ritual', 0),
      templatePick: 'ask',
      templatePickCategory: 'cat-journal',
    })
    expect(scoped?.type === 'template' && scoped.templatePickCategory).toBe('cat-journal')
    const all = normalizeQuickAddChoice({ ...newTemplateChoice('qa-t', 'Ritual', 0), templatePickCategory: '   ' })
    expect(all?.type === 'template' && all.templatePickCategory, 'blank means every category').toBeNull()
    expect(newTemplateChoice('qa-t', 'R', 0).templatePickCategory).toBeNull()
  })

  it('keeps the two caret-relative write positions', () => {
    for (const position of ['lineAbove', 'lineBelow'] as const) {
      const kept = normalizeQuickAddChoice({ ...newCaptureChoice('qa-c', 'C', 0), writePosition: position })
      expect(kept?.type === 'capture' && kept.writePosition, position).toBe(position)
    }
    const broken = normalizeQuickAddChoice({ ...newCaptureChoice('qa-c', 'C', 0), writePosition: 'sideways' })
    expect(broken?.type === 'capture' && broken.writePosition, 'an unknown position falls back to the bottom').toBe('bottom')
  })

  it('keeps a macro’s startup flag and refuses a scope it does not know', () => {
    const flagged = normalizeQuickAddChoice({ ...newMacroChoice('qa-mac', 'Morning', 0), runOnStartup: true })
    expect(flagged?.type === 'macro' && flagged.runOnStartup).toBe(true)
    const plain = normalizeQuickAddChoice(newMacroChoice('qa-mac', 'Morning', 0))
    expect(plain?.type === 'macro' && plain.runOnStartup, 'nothing runs by itself until the reader says so').toBe(false)
    expect(normalizeQuickAddChoice({ ...newMacroChoice('qa-mac', 'M', 0), runOnStartup: 'yes' })?.type).toBe('macro')
    expect(normalizeQuickAddSettings({ startupScope: 'session' }).startupScope).toBe('session')
    expect(normalizeQuickAddSettings({ startupScope: 'hourly' }).startupScope, 'the quiet default: a day, not every reload').toBe('day')
  })
})

describe('the quickadd tree helpers', () => {
  const tree: QuickAddChoice[] = [
    { ...groupChoice('qa-g', 'G'), position: 0 },
    { ...templateChoice('qa-a', 'A', 'qa-g'), position: 0 },
    { ...templateChoice('qa-b', 'B', 'qa-g'), position: 1 },
    { ...templateChoice('qa-c', 'C'), position: 1 },
  ]

  it('lists children and descendants', () => {
    expect(idsOf(childrenOf(tree, 'qa-g'))).toEqual(['qa-a', 'qa-b'])
    expect(idsOf(childrenOf(tree, null))).toEqual(['qa-g', 'qa-c'])
    expect(descendantIds(tree, 'qa-g')).toEqual(new Set(['qa-a', 'qa-b']))
  })

  it('walks roots before their contents', () => {
    expect(idsOf(flattenChoices(tree))).toEqual(['qa-g', 'qa-a', 'qa-b', 'qa-c'])
  })

  it('moves a choice and renumbers the siblings it passed', () => {
    const placed = placeChoice(tree, 'qa-c', null, 1)
    expect(placed).not.toBeNull()
    expect(idsOf(flattenChoices(placed ?? []))).toEqual(['qa-g', 'qa-a', 'qa-b', 'qa-c'])
    expect(placed?.find((choice) => choice.id === 'qa-c')?.position).toBe(1)
    expect(placed?.find((choice) => choice.id === 'qa-g')?.position).toBe(0)
  })

  it('refuses a move that would put a group inside one of its own children', () => {
    expect(placeChoice(tree, 'qa-g', 'qa-a', 0)).toBeNull()
    expect(placeChoice(tree, 'qa-g', 'qa-g', 0)).toBeNull()
    expect(placeChoice(tree, 'qa-missing', null, 0)).toBeNull()
  })

  it('clamps an index outside the sibling list instead of failing', () => {
    expect(placeChoice(tree, 'qa-c', null, 99)?.find((choice) => choice.id === 'qa-c')?.position).toBe(1)
    expect(placeChoice(tree, 'qa-c', null, -3)?.find((choice) => choice.id === 'qa-c')?.position).toBe(0)
    expect(idsOf(flattenChoices(placeChoice(tree, 'qa-a', null, 1) ?? [])))
      .toEqual(['qa-g', 'qa-b', 'qa-a', 'qa-c'])
  })
})

describe('patching a choice the way the editor does', () => {
  it('keeps the type and refuses a patch that would make the choice unreadable', () => {
    const base = newTemplateChoice('qa-t', 'T', 0)
    expect(normalizeQuickAddChoice({ ...base, name: 'Renamed' })?.name).toBe('Renamed')
    expect(normalizeQuickAddChoice({ ...base, type: 'capture' })?.type).toBe('capture')
    expect(normalizeQuickAddChoice({ ...base, id: 'not an id' })).toBeNull()
    expect(normalizeQuickAddChoice({ ...base, name: '   ' })).toBeNull()
  })

  it('treats an absent boolean as its default rather than as false', () => {
    const capture = newCaptureChoice('qa-c', 'C', 0)
    const patched = normalizeQuickAddChoice({ ...capture, property: undefined })
    expect(patched?.type === 'capture' && patched.property.enabled).toBe(false)
    expect(patched?.type === 'capture' && patched.property.createIfMissing).toBe(true)
  })
})

describe('the ordering rule a capture record can carry', () => {
  const capture = (orderBy: Record<string, unknown>) => {
    const made = normalizeQuickAddChoice({
      ...newCaptureChoice('c1', 'Changelog', 0),
      writePosition: 'insertAfter',
      after: '## 1.0.0',
      createAt: 'ordered',
      orderBy,
    })
    return made?.type === 'capture' ? made : null
  }

  it('keeps a policy the reader chose and defaults the rest', () => {
    expect(capture({ by: 'semver', unparseable: 'top' })?.orderBy).toEqual({
      by: 'semver', direction: 'desc', dateFormat: 'YYYY-MM-DD', unparseable: 'top',
    })
  })

  it('falls back to the bottom policy for a record that predates it or names nonsense', () => {
    expect(capture({ by: 'date' })?.orderBy.unparseable).toBe('bottom')
    expect(capture({ by: 'date', unparseable: 'sideways' })?.orderBy.unparseable).toBe('bottom')
  })
})
describe('where a run opens the note', () => {
  const template = (over: Record<string, unknown>) => normalizeQuickAddChoice({
    ...newTemplateChoice('t1', 'T', 0),
    ...over,
  })

  it('keeps an opening the reader chose', () => {
    expect(template({ openPane: 'other', openLayout: 'preview', openFocus: false }))
      .toMatchObject({ openPane: 'other', openLayout: 'preview', openFocus: false })
  })

  it('leaves the fields absent when the record predates them', () => {
    const made = template({})
    expect(made && 'openPane' in made).toBe(false)
    expect(made && 'openLayout' in made).toBe(false)
    expect(made && 'openFocus' in made).toBe(false)
  })

  it('drops an opening the app does not have', () => {
    const made = template({ openPane: 'drawer', openLayout: 42, openFocus: 'yes' })
    expect(made && 'openPane' in made).toBe(false)
    expect(made && 'openLayout' in made).toBe(false)
    expect(made && 'openFocus' in made).toBe(false)
  })
})

describe('the link back to the note the run started from', () => {
  const template = (over: Record<string, unknown>) => normalizeQuickAddChoice({
    ...newTemplateChoice('t1', 'T', 0),
    ...over,
  })

  it('keeps a placement, a property name and an embed the reader chose', () => {
    expect(template({ linkPlacement: 'property', linkProperty: 'origin', linkEmbed: true }))
      .toMatchObject({ linkPlacement: 'property', linkProperty: 'origin', linkEmbed: true })
  })

  it('leaves the fields absent when the record predates them', () => {
    const made = template({})
    expect(made && 'linkPlacement' in made).toBe(false)
    expect(made && 'linkProperty' in made).toBe(false)
    expect(made && 'linkEmbed' in made).toBe(false)
  })

  it('trims a property name and drops one that cannot name a property', () => {
    expect(template({ linkProperty: '  origin  ' })).toMatchObject({ linkProperty: 'origin' })
    const made = template({ linkProperty: 'bad: name\nmore', linkPlacement: 'wherever' })
    expect(made && 'linkPlacement' in made).toBe(false)
    expect(made && 'linkProperty' in made).toBe(false)
  })
})
describe('where a template lands in a note', () => {
  const template = (over: Record<string, unknown>) => normalizeQuickAddChoice({
    ...newTemplateChoice('t1', 'T', 0),
    ...over,
  })

  it('keeps the drop and the append action the reader chose', () => {
    expect(template({ insertPosition: 'bottom', existing: 'appendBottom' }))
      .toMatchObject({ insertPosition: 'bottom', existing: 'appendBottom' })
    expect(template({ insertPosition: 'replace', existing: 'appendTop' }))
      .toMatchObject({ insertPosition: 'replace', existing: 'appendTop' })
  })

  it('leaves the drop absent when the record predates it', () => {
    const made = template({})
    expect(made && 'insertPosition' in made).toBe(false)
  })

  it('drops a drop nobody can perform and an append action spelled wrong', () => {
    const made = template({ insertPosition: 'sideways', existing: 'append sidewards' })
    expect(made && 'insertPosition' in made).toBe(false)
    expect(made?.type === 'template' && made.existing).toBe('ask')
  })

  it('keeps only a pick-a-day command that was really asked for', () => {
    expect(template({ pickDayCommand: true })?.pickDayCommand).toBe(true)
    expect(template({ pickDayCommand: 'yes' })?.pickDayCommand, 'a string is not a yes').toBeUndefined()
    expect(template({ pickDayCommand: false })?.pickDayCommand, 'off is what a record without the field means').toBeUndefined()
    expect(template({})?.type).toBe('template')
  })
})
