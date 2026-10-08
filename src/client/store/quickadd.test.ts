import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildQuickAddPayload,
  defaultQuickAddSettings,
  newGroupChoice,
  newMacroChoice,
  newTemplateChoice,
  parseQuickAddText,
  type QuickAddChoice,
  type QuickAddSettings,
} from '@shared/quickadd'
import type { QuickAddData } from '../lib/db'
import { useQuickAdd } from './quickadd'

const mocks = vi.hoisted(() => ({
  stored: null as QuickAddData | null,
  saves: [] as QuickAddData[],
  broadcasts: [] as unknown[],
  broadcastHandler: null as ((payload: { type: string; clientId: string }) => void) | null,
  remote: { savedAt: 0, library: null as unknown },
  saveCalls: [] as string[],
}))

vi.mock('../lib/db', () => ({
  CLIENT_ID: 'this-tab',
  createBroadcast: (handler: (payload: { type: string; clientId: string }) => void) => {
    mocks.broadcastHandler = handler
    return { close: () => { mocks.broadcastHandler = null } }
  },
  publishBroadcast: (payload: unknown) => { mocks.broadcasts.push(payload) },
  localDb: {
    loadQuickAdd: async () => mocks.stored,
    saveQuickAdd: async (data: QuickAddData) => {
      mocks.stored = data
      mocks.saves.push(data)
    },
  },
}))

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return {
    ...actual,
    api: {
      ...actual.api,
      quickadd: {
        load: async () => ({ savedAt: mocks.remote.savedAt, library: mocks.remote.library }),
        save: async (library: string) => {
          mocks.saveCalls.push(library)
          return { savedAt: 5_000 }
        },
      },
    },
  }
})

function storedRecord(overrides: Partial<QuickAddData> = {}): QuickAddData {
  return {
    settings: defaultQuickAddSettings(),
    choices: [],
    syncedAt: 1_000,
    pendingPush: false,
    ...overrides,
  }
}

function remoteRecord(choices: QuickAddChoice[], savedAt: number): void {
  mocks.remote = { savedAt, library: buildQuickAddPayload(defaultQuickAddSettings(), choices) }
}

function template(id: string, name: string, parentId: string | null = null): QuickAddChoice {
  return { ...newTemplateChoice(id, name, 0), parentId }
}

async function hydrateWith(record: QuickAddData | null): Promise<void> {
  mocks.stored = record
  await useQuickAdd.getState().hydrate('user-1')
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-08T10:00:00Z'))
  mocks.stored = null
  mocks.saves = []
  mocks.broadcasts = []
  mocks.broadcastHandler = null
  mocks.remote = { savedAt: 0, library: null }
  mocks.saveCalls = []
  useQuickAdd.setState({
    settings: defaultQuickAddSettings(),
    choices: [],
    hydrated: false,
    owner: '',
    undoable: null,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('hydrating the quickadd library', () => {
  it('starts from the shipped options when neither copy exists', async () => {
    await hydrateWith(null)
    expect(useQuickAdd.getState().hydrated).toBe(true)
    expect(useQuickAdd.getState().owner).toBe('user-1')
    expect(useQuickAdd.getState().choices).toEqual([])
    expect(useQuickAdd.getState().settings.dateFormat).toBe('YYYY-MM-DD')
  })

  it('takes the account copy when it is newer than the local one', async () => {
    await hydrateWith(storedRecord({ choices: [template('qa-local', 'Local')] }))
    remoteRecord([template('qa-remote', 'Remote')], 2_000)
    useQuickAdd.setState({ hydrated: false })
    await useQuickAdd.getState().hydrate('user-1')

    expect(useQuickAdd.getState().choices.map((choice) => choice.id)).toEqual(['qa-remote'])
    expect(mocks.stored?.syncedAt).toBe(2_000)
  })

  it('keeps an unsent local edit even when the account copy is newer', async () => {
    await hydrateWith(storedRecord({ choices: [template('qa-local', 'Local')], pendingPush: true }))
    remoteRecord([template('qa-remote', 'Remote')], 9_000)
    useQuickAdd.setState({ hydrated: false })
    await useQuickAdd.getState().hydrate('user-1')

    expect(useQuickAdd.getState().choices.map((choice) => choice.id)).toEqual(['qa-local'])
    expect(mocks.stored?.pendingPush).toBe(true)
  })

  it('reads again when a second account signs in in the same browser', async () => {
    await hydrateWith(storedRecord({ choices: [template('qa-a', 'A')] }))
    expect(useQuickAdd.getState().owner).toBe('user-1')

    mocks.stored = storedRecord({ choices: [template('qa-b', 'B')] })
    useQuickAdd.setState({ hydrated: false })
    await useQuickAdd.getState().hydrate('user-2')
    expect(useQuickAdd.getState().choices.map((choice) => choice.id)).toEqual(['qa-b'])

    await useQuickAdd.getState().hydrate('user-2')
    expect(useQuickAdd.getState().choices.map((choice) => choice.id)).toEqual(['qa-b'])
  })

  it('re-reads when another tab says it wrote the library', async () => {
    vi.resetModules()
    const module = await import('./quickadd')
    await module.useQuickAdd.getState().hydrate('user-1')
    expect(mocks.broadcastHandler).toBeTypeOf('function')

    mocks.stored = storedRecord({ choices: [template('qa-a', 'A'), template('qa-z', 'Z')] })
    mocks.broadcastHandler?.({ type: 'quickadd-changed', clientId: 'other-tab' })
    await vi.waitFor(() => expect(module.useQuickAdd.getState().choices.length).toBe(2))

    mocks.broadcastHandler?.({ type: 'quickadd-changed', clientId: 'this-tab' })
    await Promise.resolve()
    expect(module.useQuickAdd.getState().choices.length).toBe(2)
  })
})

describe('writing the quickadd library', () => {
  beforeEach(async () => {
    await hydrateWith(storedRecord())
  })

  it('creates a choice of the asked-for kind and normalizes its name', () => {
    const created = useQuickAdd.getState().createChoice('capture', '  Inbox capture  ')
    expect(created).not.toBeNull()
    expect(created?.type).toBe('capture')
    expect(created?.name).toBe('Inbox capture')
    expect(useQuickAdd.getState().choices.map((choice) => choice.id)).toEqual([created?.id])
    expect(mocks.broadcasts.map((payload) => (payload as { type: string }).type))
      .toContain('quickadd-changed')
  })

  it('refuses a blank name, an unknown parent and a list at its cap', () => {
    expect(useQuickAdd.getState().createChoice('template', '   ')).toBeNull()
    expect(useQuickAdd.getState().createChoice('template', 'Orphan', 'qa-missing')).toBeNull()

    const templateParent = useQuickAdd.getState().createChoice('template', 'Not a group')
    expect(useQuickAdd.getState().createChoice('template', 'Child', templateParent?.id ?? undefined)).toBeNull()

    const many: QuickAddChoice[] = []
    for (let index = 0; index < 400; index += 1) many.push(template(`qa-${index}`, `N${index}`))
    useQuickAdd.setState({ choices: many })
    expect(useQuickAdd.getState().createChoice('template', 'One too many')).toBeNull()
  })

  it('pushes the debounced write and remembers what the account said', async () => {
    useQuickAdd.getState().createChoice('template', 'Pushed')
    await vi.waitFor(() => expect(mocks.saveCalls.length).toBe(1), { timeout: 4_000 })

    const payload = parseQuickAddText(mocks.saveCalls[0]!)
    expect(payload.data?.choices.map((choice) => choice.name)).toEqual(['Pushed'])
    expect(mocks.stored?.syncedAt).toBe(5_000)
    expect(mocks.stored?.pendingPush).toBe(false)
  })

  it('leaves a pending push when a mutation landed during the write', async () => {
    useQuickAdd.getState().createChoice('template', 'First')
    await vi.advanceTimersByTimeAsync(1_200)
    const inflight = mocks.saveCalls.length
    expect(inflight).toBe(1)

    useQuickAdd.getState().saveSettings({ notifications: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.stored?.pendingPush).toBe(true)
  })

  it('sends settings through the same normalizer the editor trusts', () => {
    useQuickAdd.getState().saveSettings({
      dateFormat: '   ',
      defaultFolder: 'a/../b',
      globalVars: [{ name: '__proto__', value: 'x' }, { name: 'author', value: 'Me' }],
      recent: [{ id: 'qa-gone', at: 1 }],
    })
    const settings = useQuickAdd.getState().settings
    expect(settings.dateFormat).toBe('YYYY-MM-DD')
    expect(settings.defaultFolder).toBe('a/b')
    expect(settings.globalVars).toEqual([{ name: 'author', value: 'Me' }])
    expect(settings.recent).toEqual([])
  })

  it('patches a choice and clamps what the patch tried to set', () => {
    const created = useQuickAdd.getState().createChoice('template', 'T')
    const patched = useQuickAdd.getState().updateChoice(created!.id, {
      name: 'x'.repeat(400),
      folderPath: '../secrets',
      tags: ['a', 'A', '', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
    })

    expect(patched?.name.length).toBe(120)
    expect(patched).toMatchObject({ folderPath: 'secrets' })
    expect(patched?.type === 'template' && patched.tags).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(useQuickAdd.getState().updateChoice('qa-missing', { name: 'Nope' })).toBeNull()
  })

  it('keeps the type when a patch arrives for the wrong shape', () => {
    const capture = useQuickAdd.getState().createChoice('capture', 'C')
    const patched = useQuickAdd.getState().updateChoice(capture!.id, { templateId: 'tpl-1', mode: 'insert-here' })
    expect(patched?.type).toBe('capture')
    expect('templateId' in (patched as object)).toBe(false)
  })

  it('deletes a group with its children and gives it all back', () => {
    const group = useQuickAdd.getState().createChoice('group', 'G')
    const child = useQuickAdd.getState().createChoice('template', 'Child', group!.id)
    useQuickAdd.getState().saveSettings({ recent: [{ id: child!.id, at: 1 }, { id: group!.id, at: 2 }] })

    expect(useQuickAdd.getState().removeChoices([group!.id])).toBe(2)
    expect(useQuickAdd.getState().choices).toEqual([])
    expect(useQuickAdd.getState().settings.recent).toEqual([])
    expect(useQuickAdd.getState().undoable?.length).toBe(2)

    expect(useQuickAdd.getState().restoreUndoable()).toBe(true)
    expect(useQuickAdd.getState().choices.map((choice) => choice.id)).toEqual([group!.id, child!.id])
    expect(useQuickAdd.getState().undoable).toBeNull()
    expect(useQuickAdd.getState().restoreUndoable()).toBe(false)
  })

  it('reports nothing deleted for an id that is not there', () => {
    useQuickAdd.getState().createChoice('template', 'T')
    expect(useQuickAdd.getState().removeChoices(['qa-missing'])).toBe(0)
    expect(useQuickAdd.getState().undoable).toBeNull()
  })

  it('duplicates a group and its children under fresh ids', () => {
    const group = useQuickAdd.getState().createChoice('group', 'G')
    useQuickAdd.getState().createChoice('template', 'Child', group!.id)
    useQuickAdd.getState().updateChoice(group!.id, { hotkey: 'ctrl+alt+g' })

    const copy = useQuickAdd.getState().duplicateChoice(group!.id)
    expect(copy?.name).toBe('G (copy)')
    expect(copy?.hotkey).toBeNull()
    const choices = useQuickAdd.getState().choices
    expect(choices.length).toBe(4)
    expect(choices.filter((choice) => choice.parentId === copy!.id).length).toBe(1)
    expect(choices.filter((choice) => choice.type === 'group').map((choice) => choice.id))
      .toEqual(expect.arrayContaining([group!.id, copy!.id]))
  })

  it('names a duplicate past a collision instead of overwriting it', () => {
    useQuickAdd.getState().createChoice('template', 'Note')
    useQuickAdd.getState().createChoice('template', 'Note (copy)')
    const first = useQuickAdd.getState().choices[0]!
    const copy = useQuickAdd.getState().duplicateChoice(first.id)
    expect(copy?.name).toBe('Note (2)')
    expect(useQuickAdd.getState().duplicateChoice('qa-missing')).toBeNull()
  })

  it('moves a choice and refuses to bury a group in its own child', async () => {
    const group = useQuickAdd.getState().createChoice('group', 'G')
    const child = useQuickAdd.getState().createChoice('template', 'C', group!.id)
    const other = useQuickAdd.getState().createChoice('template', 'O')

    expect(useQuickAdd.getState().place(child!.id, null, 0)).toBe(true)
    expect(useQuickAdd.getState().choices.find((choice) => choice.id === child!.id))
      .toMatchObject({ parentId: null, position: 0 })
    expect(useQuickAdd.getState().place(group!.id, child!.id, 1)).toBe(false)
    expect(useQuickAdd.getState().place(group!.id, group!.id, 0)).toBe(false)
    expect(useQuickAdd.getState().place('qa-missing', null, 0)).toBe(false)
    expect(useQuickAdd.getState().place(other!.id, group!.id, 5)).toBe(true)
    expect(useQuickAdd.getState().choices.find((choice) => choice.id === other!.id)?.position).toBe(0)
  })

  it('records a run once and keeps the history short', () => {
    const created = useQuickAdd.getState().createChoice('template', 'T')
    const other = useQuickAdd.getState().createChoice('template', 'O')
    useQuickAdd.getState().recordRun(created!.id)
    useQuickAdd.getState().recordRun(created!.id)
    useQuickAdd.getState().recordRun(other!.id)
    useQuickAdd.getState().recordRun('qa-missing')

    const recent = useQuickAdd.getState().settings.recent
    expect(recent.map((entry) => entry.id)).toEqual([other!.id, created!.id])

    const many: QuickAddChoice[] = []
    for (let index = 0; index < 20; index += 1) many.push(template(`qa-${index}`, `N${index}`))
    useQuickAdd.setState({ choices: many })
    for (const choice of many) useQuickAdd.getState().recordRun(choice.id)
    expect(useQuickAdd.getState().settings.recent.length).toBe(12)
  })
})

describe('importing and exporting a quickadd library', () => {
  beforeEach(async () => {
    await hydrateWith(storedRecord())
  })

  function payloadOf(choices: QuickAddChoice[], settings: QuickAddSettings = defaultQuickAddSettings()): string {
    return JSON.stringify(buildQuickAddPayload(settings, choices))
  }

  it('merges by re-keying every choice and following a macro step to the new id', () => {
    const macro = {
      ...newMacroChoice('qa-src-m', 'M', 1),
      steps: [{ kind: 'choice' as const, choiceId: 'qa-src-t' }],
    }
    useQuickAdd.getState().createChoice('template', 'Kept')
    const result = useQuickAdd.getState().importLibrary(payloadOf([template('qa-src-t', 'T'), macro]), 'merge')

    expect(result).toEqual({ added: 2, skipped: 0, error: null })
    const choices = useQuickAdd.getState().choices
    expect(choices.length).toBe(3)
    const imported = choices.find((choice) => choice.name === 'T')!
    const importedMacro = choices.find((choice) => choice.name === 'M')!
    expect(imported.id).not.toBe('qa-src-t')
    expect(importedMacro.type === 'macro' && importedMacro.steps[0])
      .toEqual({ kind: 'choice', choiceId: imported.id })
  })

  it('renames a merged choice that would otherwise collide', () => {
    useQuickAdd.getState().createChoice('template', 'Daily')
    const result = useQuickAdd.getState().importLibrary(payloadOf([template('qa-x', 'Daily')]), 'merge')
    expect(result.added).toBe(1)
    expect(useQuickAdd.getState().choices.map((choice) => choice.name)).toEqual(['Daily', 'Daily (2)'])
  })

  it('replaces the whole library including its options', () => {
    useQuickAdd.getState().createChoice('template', 'Old')
    const settings = defaultQuickAddSettings()
    settings.onePage = 'always'
    const result = useQuickAdd.getState().importLibrary(
      payloadOf([newGroupChoice('qa-g', 'New', 0)], settings),
      'replace',
    )

    expect(result).toEqual({ added: 1, skipped: 0, error: null })
    expect(useQuickAdd.getState().choices.map((choice) => choice.name)).toEqual(['New'])
    expect(useQuickAdd.getState().settings.onePage).toBe('always')
  })

  it('says so when a file cannot be read', () => {
    expect(useQuickAdd.getState().importLibrary('nonsense', 'merge').error).toBe('quickadd.import_unreadable')
    expect(useQuickAdd.getState().importLibrary('{"kind":"other"}', 'merge').error).toBe('quickadd.import_unreadable')
    expect(useQuickAdd.getState().choices).toEqual([])
  })

  it('accepts a hand-written file that only carries a choices list', () => {
    const result = useQuickAdd.getState().importLibrary('{"choices":[{"id":"qa-t","name":"T","type":"template"}]}', 'merge')
    expect(result.added).toBe(1)
    expect(useQuickAdd.getState().choices.map((choice) => choice.name)).toEqual(['T'])
  })

  it('exports what it imports, byte-for-byte where it matters', () => {
    const created = useQuickAdd.getState().createChoice('capture', 'Inbox')
    useQuickAdd.getState().updateChoice(created!.id, { targetTitle: 'Inbox', writePosition: 'insertAfter' })
    useQuickAdd.getState().saveSettings({ notifications: false })

    const text = useQuickAdd.getState().exportText()
    const parsed = parseQuickAddText(text)
    expect(parsed.dropped).toBe(0)
    expect(parsed.data?.settings.notifications).toBe(false)
    expect(parsed.data?.choices[0]).toMatchObject({ name: 'Inbox', type: 'capture', writePosition: 'insertAfter' })
  })
})
