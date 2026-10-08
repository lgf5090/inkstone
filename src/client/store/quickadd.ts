/**
 * The account's QuickAdd library: choices, their options, and the durability path that keeps a
 * local copy usable offline while one account record travels between devices.
 *
 * Every write goes through the shared normalizer rather than trusting the caller's patch, so a
 * field the editor should not have been able to set (an over-long format, a `../` folder path, a
 * hotkey without a modifier) arrives at the server already clamped.
 */
import { create, type StoreApi } from 'zustand'
import {
  QUICKADD_LIMITS,
  buildQuickAddPayload,
  defaultQuickAddSettings,
  descendantIds,
  newCaptureChoice,
  newGroupChoice,
  newMacroChoice,
  newTemplateChoice,
  normalizeQuickAddChoice,
  normalizeQuickAddSettings,
  parseQuickAddRecord,
  placeChoice,
  type QuickAddChoice,
  type QuickAddChoiceType,
  type QuickAddLibrary,
  type QuickAddSettings,
  type QuickAddStep,
} from '@shared/quickadd'
import { api, CLIENT_ID } from '../lib/api'
import { createBroadcast, localDb, publishBroadcast, type QuickAddData } from '../lib/db'
import { randomLocalId } from '../lib/random-id'

interface QuickAddState {
  settings: QuickAddSettings
  choices: QuickAddChoice[]
  hydrated: boolean
  /** Account the hydrated library belongs to; a change forces a re-read. */
  owner: string
  /** The list as it was before the last destructive action, kept in memory only. */
  undoable: QuickAddChoice[] | null
  hydrate: (owner: string) => Promise<void>
  /** Take the account's copy as it stands: what a backup restore just wrote. */
  reloadFromAccount: (owner: string) => Promise<void>
  saveSettings: (patch: Partial<QuickAddSettings>) => void
  createChoice: (type: QuickAddChoiceType, name: string, parentId?: string | null) => QuickAddChoice | null
  updateChoice: (id: string, patch: Record<string, unknown>) => QuickAddChoice | null
  removeChoices: (ids: readonly string[]) => number
  duplicateChoice: (id: string) => QuickAddChoice | null
  place: (id: string, parentId: string | null, index: number) => boolean
  toggleGroupCollapsed: (id: string) => boolean
  restoreUndoable: () => boolean
  recordRun: (id: string) => void
  /** `error` is a message id so the caller can translate it. */
  importLibrary: (text: string, mode: 'merge' | 'replace') => { added: number; skipped: number; error: string | null }
  exportText: () => string
}

const PUSH_DELAY_MS = 1200

let lastSyncedAt = 0
let mutations = 0
let pushTimer: ReturnType<typeof setTimeout> | null = null
let hydrateChain: Promise<void> = Promise.resolve()
let hydrateRequested: string | null = null
let tabWatcher: { close: () => void } | null = null

type SetQuickAddState = StoreApi<QuickAddState>['setState']

function newChoice(type: QuickAddChoiceType, id: string, name: string, position: number): QuickAddChoice {
  switch (type) {
    case 'capture':
      return newCaptureChoice(id, name, position)
    case 'macro':
      return newMacroChoice(id, name, position)
    case 'group':
      return newGroupChoice(id, name, position)
    default:
      return newTemplateChoice(id, name, position)
  }
}

function nextPosition(choices: QuickAddChoice[], parentId: string | null): number {
  const siblings = choices.filter((choice) => (choice.parentId ?? null) === parentId)
  return siblings.length
    ? siblings.reduce((max, choice) => Math.max(max, choice.position), -1) + 1
    : 0
}

/**
 * Re-read the library when another tab says it wrote one. The read replaces the in-memory copy:
 * the other tab wrote the whole record, so anything this tab still holds that is not in that
 * record was never written anywhere.
 */
function watchOtherTabs(): void {
  if (tabWatcher) return
  tabWatcher = createBroadcast((payload) => {
    if (payload.type !== 'quickadd-changed' || payload.clientId === CLIENT_ID) return
    const { owner } = useQuickAdd.getState()
    if (!owner) return
    useQuickAdd.setState({ hydrated: false })
    void useQuickAdd.getState().hydrate(owner)
  })
}

function schedulePush(): void {
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    pushTimer = null
    void pushLibrary()
  }, PUSH_DELAY_MS)
}

async function pushLibrary(): Promise<void> {
  const { owner, settings, choices } = useQuickAdd.getState()
  if (!owner) return
  const at = mutations
  try {
    const saved = await api.quickadd.save(JSON.stringify(buildQuickAddPayload(settings, choices)))
    lastSyncedAt = saved.savedAt
    const current = useQuickAdd.getState()
    await localDb.saveQuickAdd({
      settings: current.settings,
      choices: current.choices,
      syncedAt: saved.savedAt,
      pendingPush: mutations !== at,
    })
  } catch {
  }
}

async function readRemoteLibrary(): Promise<QuickAddData | null> {
  try {
    const remote = await api.quickadd.load()
    if (!remote.library || !(remote.savedAt > 0)) return null
    const parsed = parseQuickAddRecord(remote.library)
    if (!parsed.data) return null
    return {
      settings: parsed.data.settings,
      choices: parsed.data.choices,
      syncedAt: remote.savedAt,
      pendingPush: false,
    }
  } catch {
    return null
  }
}

function persist(set: SetQuickAddState, get: () => QuickAddState, next: {
  settings?: QuickAddSettings
  choices?: QuickAddChoice[]
}): void {
  const current = get()
  const settings = next.settings ?? current.settings
  const choices = next.choices ?? current.choices
  set({ settings, choices })
  void localDb.saveQuickAdd({ settings, choices, syncedAt: lastSyncedAt, pendingPush: true })
  // A whole-library write from this tab makes every other tab's copy stale, and each of them
  // writes its own copy back on its next mutation. Saying so is what keeps two tabs open in one
  // browser from erasing each other.
  publishBroadcast({ type: 'quickadd-changed', clientId: CLIENT_ID })
  mutations += 1
  schedulePush()
}

/**
 * A downloaded file may be the app's own export or a hand-written one that only carries
 * `choices`, so the payload header is filled in when absent. Anything else is not a library.
 */
function readLibraryText(text: string): QuickAddLibrary | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return parseQuickAddRecord(value).data
}

export const useQuickAdd = create<QuickAddState>((set, get) => ({
  settings: defaultQuickAddSettings(),
  choices: [],
  hydrated: false,
  owner: '',
  undoable: null,
  hydrate: (owner) => hydrateImpl(set, get, owner),
  reloadFromAccount: async (owner) => {
    if (!owner) return
    const stored = await localDb.loadQuickAdd()
    if (stored?.pendingPush) await localDb.saveQuickAdd({ ...stored, pendingPush: false })
    useQuickAdd.setState({ hydrated: false })
    await get().hydrate(owner)
  },
  saveSettings: (patch) => {
    // The id lists inside the settings are pruned against the library, so a write that forgot to pass
    // it would answer "no choice exists" and quietly empty the reader's run history.
    const ids = new Set(get().choices.map((choice) => choice.id))
    persist(set, get, { settings: normalizeQuickAddSettings({ ...get().settings, ...patch }, ids) })
  },
  createChoice: (type, name, parentId = null) => {
    const choices = get().choices
    if (choices.length >= QUICKADD_LIMITS.maxChoices) return null
    const trimmed = name.trim().slice(0, QUICKADD_LIMITS.maxNameLength)
    if (!trimmed) return null
    const parent = parentId ? choices.find((choice) => choice.id === parentId) : null
    if (parentId && (!parent || parent.type !== 'group')) return null
    const choice = normalizeQuickAddChoice(
      { ...newChoice(type, randomLocalId('qa'), trimmed, nextPosition(choices, parentId ?? null)), parentId: parentId ?? null },
    )
    if (!choice) return null
    persist(set, get, { choices: [...choices, choice] })
    return choice
  },
  updateChoice: (id, patch) => {
    const choices = get().choices
    const current = choices.find((choice) => choice.id === id)
    if (!current) return null
    const next = normalizeQuickAddChoice({ ...current, ...patch })
    if (!next) return null
    persist(set, get, { choices: choices.map((choice) => (choice.id === id ? next : choice)) })
    return next
  },
  removeChoices: (ids) => {
    const choices = get().choices
    const doomed = new Set<string>()
    for (const id of ids) {
      if (!choices.some((choice) => choice.id === id)) continue
      doomed.add(id)
      for (const child of descendantIds(choices, id)) doomed.add(child)
    }
    if (doomed.size === 0) return 0
    const settings = {
      ...get().settings,
      recent: get().settings.recent.filter((entry) => !doomed.has(entry.id)),
    }
    set({ undoable: choices.map((choice) => ({ ...choice })) })
    persist(set, get, { choices: choices.filter((choice) => !doomed.has(choice.id)), settings })
    return doomed.size
  },
  duplicateChoice: (id) => {
    const choices = get().choices
    const source = choices.find((choice) => choice.id === id)
    if (!source || choices.length >= QUICKADD_LIMITS.maxChoices) return null
    const taken = new Set(choices.map((choice) => choice.name.toLowerCase()))
    let name = `${source.name} (copy)`
    let attempt = 2
    while (taken.has(name.toLowerCase()) && attempt < 40) {
      name = `${source.name} (${attempt})`
      attempt += 1
    }
    const copy = normalizeQuickAddChoice({
      ...source,
      id: randomLocalId('qa'),
      name: name.slice(0, QUICKADD_LIMITS.maxNameLength),
      hotkey: null,
      position: nextPosition(choices, source.parentId),
    })
    if (!copy) return null
    const children = copy.type === 'group'
      ? choices
        .filter((choice) => choice.parentId === id)
        .map((child) => normalizeQuickAddChoice({
          ...child,
          id: randomLocalId('qa'),
          parentId: copy.id,
          hotkey: null,
          position: nextPosition(choices, null) + child.position + 1,
        }))
        .filter((child): child is QuickAddChoice => child !== null)
      : []
    persist(set, get, { choices: [...choices, copy, ...children] })
    return copy
  },
  toggleGroupCollapsed: (id) => {
    const choices = get().choices
    const group = choices.find((choice) => choice.id === id && choice.type === 'group')
    if (!group || group.type !== 'group') return false
    persist(set, get, {
      choices: choices.map((choice) => (choice.id === id && choice.type === 'group'
        ? { ...choice, collapsed: !choice.collapsed }
        : choice)),
    })
    return true
  },
  place: (id, parentId, index) => {
    const choices = get().choices
    const next = placeChoice(choices, id, parentId, index)
    if (!next) return false
    persist(set, get, { choices: next })
    return true
  },
  restoreUndoable: () => {
    const snapshot = get().undoable
    if (!snapshot) return false
    set({ undoable: null })
    persist(set, get, { choices: snapshot })
    return true
  },
  recordRun: (id) => {
    const { settings, choices } = get()
    if (!choices.some((choice) => choice.id === id)) return
    const recent = [
      { id, at: Date.now() },
      ...settings.recent.filter((entry) => entry.id !== id),
    ].slice(0, QUICKADD_LIMITS.maxRecent)
    persist(set, get, { settings: { ...settings, recent } })
  },
  importLibrary: (text, mode) => {
    const library = readLibraryText(text)
    if (!library) return { added: 0, skipped: 0, error: 'quickadd.import_unreadable' }
    if (mode === 'replace') {
      persist(set, get, { choices: library.choices, settings: library.settings })
      return { added: library.choices.length, skipped: 0, error: null }
    }
    const choices = [...get().choices]
    const taken = new Set(choices.map((choice) => choice.name.toLowerCase()))
    const idMap = new Map<string, string>()
    let added = 0
    let skipped = 0
    for (const choice of library.choices) {
      const id = randomLocalId('qa')
      idMap.set(choice.id, id)
      let name = choice.name
      if (taken.has(name.toLowerCase())) {
        let attempt = 2
        while (taken.has(`${name} (${attempt})`.toLowerCase()) && attempt < 40) attempt += 1
        name = `${name} (${attempt})`
      }
      taken.add(name.toLowerCase())
      const remapped = normalizeQuickAddChoice({
        ...choice,
        id,
        name: name.slice(0, QUICKADD_LIMITS.maxNameLength),
        parentId: choice.parentId ? (idMap.get(choice.parentId) ?? null) : null,
        hotkey: null,
        ...(choice.type === 'macro' ? { steps: remapMacroSteps(choice.steps, idMap) } : {}),
      })
      if (!remapped) {
        skipped += 1
        continue
      }
      choices.push(remapped)
      added += 1
    }
    if (added > 0) persist(set, get, { choices })
    return { added, skipped, error: null }
  },
  exportText: () => JSON.stringify(buildQuickAddPayload(get().settings, get().choices), null, 2),
}))

/** A merged import re-keys every choice, so a step that runs another choice has to follow. */
function remapMacroSteps(
  steps: readonly QuickAddStep[],
  idMap: ReadonlyMap<string, string>,
): QuickAddStep[] {
  return steps.map((step) => (step.kind === 'choice'
    ? { ...step, choiceId: idMap.get(step.choiceId) ?? '' }
    : step))
}

function hydrateImpl(
  set: SetQuickAddState,
  get: () => QuickAddState,
  owner: string,
): Promise<void> {
  if (!owner) return Promise.resolve()
  watchOtherTabs()
  if (get().hydrated && get().owner === owner) return Promise.resolve()
  const run = async (): Promise<void> => {
    if (get().hydrated && get().owner === owner) return
    const stored = await localDb.loadQuickAdd()
    const remote = await readRemoteLibrary()
    const takeRemote = remote !== null && !(stored?.pendingPush) && remote.syncedAt > (stored?.syncedAt ?? 0)
    const base = takeRemote ? remote : stored
    const next: QuickAddData = base ?? {
      settings: defaultQuickAddSettings(),
      choices: [],
      syncedAt: 0,
      pendingPush: false,
    }
    if (next !== stored) await localDb.saveQuickAdd(next)
    lastSyncedAt = next.syncedAt
    if (next.pendingPush) schedulePush()
    // The account moved on while this read was in flight, so its result belongs to nobody:
    // publishing it would show one account's library under another.
    if (hydrateRequested !== owner) return
    set({ settings: next.settings, choices: next.choices, hydrated: true, owner })
  }
  hydrateRequested = owner
  hydrateChain = hydrateChain.then(run, run)
  return hydrateChain
}
