// @vitest-environment jsdom
/**
 * Four surfaces that had their logic written and no way to be reached.
 *
 * Each case below is the seam, not the algorithm: the settings row that lets a reader point the built-in
 * search tool at their own engine, the composer chip that has to say whether that turn could search at
 * all, the note menu that turns a checkbox into a task, the scope chip and the answer provenance that make
 * a turn's limits readable without a mouse, and the delete toast that says how many turns the file it
 * removed was quoted by. The engines behind them are covered by their own files.
 *
 * jsdom lays nothing out, so every claim here is about structure, role and accessible name — never about
 * where a control would have been painted.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ASSISTANT_SETTINGS,
  type AssistantMcpCatalogEntry,
  type AssistantMcpServer,
  type AssistantModel,
  type AssistantProvider,
  type AssistantSettings,
  type AssistantTurnScope,
} from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import type { MenuCtx } from '../workspace/context-menu/types'
import { buildTaskItems } from '../workspace/context-menu/items-inline'
import { BehaviourTab } from './AssistantBehaviourTab'
import { ProviderKeys } from './ProviderKeys'
import { ChatComposer, UserBubble } from './ChatView'
import { TurnPinRow } from './ComposerTriggers'
import { useAssistant } from './assistant-store'

const harness = vi.hoisted(() => ({
  /** What `api.assistant.createTask` was pointed at, in order. */
  created: [] as { title: string, description: string, dueAt: number | null }[],
  /** The engine keys the fake route holds: the same shape the route answers with, and the same three fields. */
  keys: [] as { engine: string, hasKey: boolean, keyHint: string, updatedAt: number }[],
}))

const createTask = vi.fn(async (body: { title: string, description: string, dueAt: number | null }) => {
  harness.created.push(body)
  return { task: {} }
})

/**
 * The engine key routes, faked as the worker behaves: the key is accepted, and only its last four characters
 * are ever handed back. Nothing here keeps a key a test can print, because a test that asserts on the
 * credential would be the leak.
 */
const searchKeys = vi.fn(async () => ({ keys: harness.keys.map((entry) => ({ ...entry })) }))
const putSearchKey = vi.fn(async (engine: string, body: { apiKey: string }) => {
  const key = { engine, hasKey: true, keyHint: body.apiKey.slice(-4), updatedAt: 1 }
  harness.keys.splice(harness.keys.findIndex((entry) => entry.engine === engine), 1, key)
  return { key }
})
const deleteSearchKey = vi.fn(async (engine: string) => {
  const at = harness.keys.findIndex((entry) => entry.engine === engine)
  if (at >= 0) harness.keys.splice(at, 1)
  return { deleted: true }
})

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  CLIENT_ID: 'test-client',
  api: {
    search: async () => ({ results: [] }),
    tags: { list: async () => ({ tags: [] }) },
    folders: { list: async () => ({ folders: [] }) },
    notes: {},
    assistant: {
      skills: async () => ({ skills: [] }),
      conversationBranches: async () => ({ parent: null, siblings: [] }),
      conversationArtifacts: async () => ({ artifacts: [] }),
      createTask: (body: { title: string, description: string, dueAt: number | null }) => createTask(body),
      searchKeys: () => searchKeys(),
      putSearchKey: (engine: string, body: { apiKey: string }) => putSearchKey(engine, body),
      deleteSearchKey: (engine: string) => deleteSearchKey(engine),
      providerKeys: () => providerKeys(),
      providerBalance: () => providerBalance(),
    },
  },
}))

/** The ring as the route describes it: two rows, each with its own last four characters. */
const providerKeys = vi.fn(async () => ({
  keys: [
    { id: 'k1', providerId: 'p1', label: 'Work', hasKey: true, keyHint: 'wxyz', enabled: true, lastUsedAt: null, errorCount: 0, lastError: null, createdAt: 1, updatedAt: 1 },
    { id: 'k2', providerId: 'p1', label: 'Spare', hasKey: true, keyHint: 'beef', enabled: true, lastUsedAt: null, errorCount: 0, lastError: null, createdAt: 2, updatedAt: 2 },
  ],
}))

/** What each of those keys is owed. Swapped per case, because the screen says what the answer said. */
const providerBalance = vi.fn(async () => ({
  supported: true,
  readings: [
    { keyId: '', label: '', keyHint: 'abcd', ok: true, amount: 12.5, currency: 'CNY' },
    { keyId: 'k1', label: 'Work', keyHint: 'wxyz', ok: true, amount: 3, currency: 'CNY' },
    { keyId: 'k2', label: 'Spare', keyHint: 'beef', ok: false, reason: 'unauthorized' },
  ],
}))

const ENGINED = 'https://searx.example.org/search'

const folderScope: AssistantTurnScope = { kind: 'folder', id: 'f1', name: '工作' }
const tagScope: AssistantTurnScope = { kind: 'tag', id: 't1', name: 'reading' }

function settings(over: Partial<AssistantSettings> = {}): AssistantSettings {
  return { ...DEFAULT_ASSISTANT_SETTINGS, ...over }
}

function model(over: Partial<AssistantModel> = {}): AssistantModel {
  return {
    id: 'm1', providerId: 'p1', model: 'deepseek-chat', label: 'DeepSeek Chat', temperature: 0.4,
    maxOutputTokens: 8192, enabled: true, reasoning: 'auto', contextTokens: null, vision: true, purpose: 'chat',
    kind: 'text', supportsTools: true, maxInputTokens: null, modalities: [], topP: null, customParams: [],
    protocol: null, fallbackModelId: null, inputPrice: null, outputPrice: null, priceCurrency: '', ...over,
  }
}

function provider(protocol: AssistantProvider['protocol']): AssistantProvider {
  return {
    id: 'p1', label: 'Gateway', protocol, baseUrl: 'https://gateway.example.org/v1', endpoints: {},
    hasKey: true, keyHint: 'abcd', reasoningDialect: null, createdAt: 1, updatedAt: 1,
  }
}

function mcpServer(over: Partial<AssistantMcpServer> = {}): AssistantMcpServer {
  return {
    id: 's1', label: 'Search box', url: 'https://mcp.example.org/mcp', description: '', transport: 'streamableHttp',
    timeoutSeconds: 30, enabled: true, toolMode: 'auto', toolModes: {}, hasKey: false, authorization: null,
    createdAt: 1, updatedAt: 1, ...over,
  }
}

function catalog(over: Partial<AssistantMcpCatalogEntry> = {}): AssistantMcpCatalogEntry {
  return {
    serverId: 's1', serverLabel: 'Search box',
    tools: [{ name: 'mcp_1_search_web', remoteName: 'search_web', serverId: 's1', serverLabel: 'Search box', description: '' }],
    ...over,
  }
}

let root: Root
let host: HTMLElement

const nodes = () => [...document.body.querySelectorAll<HTMLElement>('button, input, select, textarea')]
const byAria = (name: string) => nodes().find((node) => (node.getAttribute('aria-label') ?? '') === name)
const alert = () => document.body.querySelector('[role="alert"]')

/** Type into the box the way a keyboard does, so React's own value tracking sees the change. */
async function type(node: HTMLInputElement | null, value: string): Promise<void> {
  expect(node, 'the box is not drawn').toBeTruthy()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(node, value)
    node!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(node: Element | null | undefined, where: string): Promise<void> {
  expect(node, `${where} is not drawn`).toBeTruthy()
  await act(async () => { node!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}

/** A control's accessible description: the visually-hidden node a disabled chip points at. */
function descriptionOf(node: Element | null | undefined): string {
  const ids = (node?.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
  return ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim()
}

const assistantOriginal = useAssistant.getState()
const notesOriginal = useNotes.getState()
const uiOriginal = useUi.getState()

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  harness.created.length = 0
  createTask.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAssistant.setState(assistantOriginal, true)
  useNotes.setState(notesOriginal, true)
  useUi.setState(uiOriginal, true)
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('the web-search engine setting', () => {
  const saveSettings = vi.fn(async (_patch: Record<string, unknown>) => undefined)

  beforeEach(() => {
    saveSettings.mockReset()
    saveSettings.mockResolvedValue(undefined)
    useAssistant.setState({ ...assistantOriginal, saveSettings })
  })

  const mount = async (over: Partial<AssistantSettings> = {}) => {
    await act(async () => { root.render(createElement(BehaviourTab, { settings: settings(over) })) })
  }

  /** The box a row's own title names, found through the `<label for>` the row writes. */
  function boxNamedByRow(title: string): HTMLInputElement | null {
    for (const label of [...document.querySelectorAll<HTMLLabelElement>('label[for]')]) {
      if (label.textContent?.trim() !== title) continue
      const target = document.getElementById(label.htmlFor)
      if (target?.tagName === 'INPUT') return target as HTMLInputElement
    }
    return null
  }

  /** The row's own two controls: the box its title names, and the submit beside it. */
  function row(): { box: HTMLInputElement | null, save: HTMLButtonElement | null } {
    const box = boxNamedByRow(t('assistant.settings.web_search'))
    return { box, save: box?.closest('form')?.querySelector('button[type="submit"]') ?? null }
  }

  it('gives the address box the row title as its name, and states the contract', async () => {
    await mount()
    expect(row().box, 'the search-engine row has no box answering to its title').toBeTruthy()
    // The hint is the only place the two parameters the tool sends are written down for the reader.
    const hint = document.body.textContent ?? ''
    expect(hint).toContain('?q=')
    expect(hint).toContain('format=json')
  })

  it('saves the address the reader wrote, trimmed', async () => {
    await mount()
    await type(row().box, `  ${ENGINED}  `)
    await click(row().save, 'the save button')
    expect(saveSettings).toHaveBeenCalledWith({ webSearchEndpoint: ENGINED })
    expect(alert()).toBeNull()
  })

  it('answers a private address beside the box, and never sends it', async () => {
    await mount()
    const box = row().box
    await type(box, 'http://127.0.0.1:8080/search')
    const message = t('assistant.settings.web_search_invalid')
    expect(alert()?.textContent).toContain(message)
    expect(box?.getAttribute('aria-invalid')).toBe('true')
    expect(descriptionOf(box)).toContain(message)
    await click(row().save, 'the save button')
    // The route would only 400 it, so the refusal is said here instead of arriving as a toast.
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('takes an empty box as the answer that switches search off', async () => {
    await mount({ webSearchEndpoint: ENGINED })
    expect(alert()).toBeNull()
    await type(row().box, '')
    await click(row().save, 'the save button')
    expect(saveSettings).toHaveBeenCalledWith({ webSearchEndpoint: '' })
  })

  /** Let the key listing the row asks for land, so its answer is what the row is read on. */
  const settle = async (): Promise<void> => {
    // A macrotask, not two microtasks: the listing is a promise the row chains on, and the answer has to
    // have been delivered and re-rendered before anything about it is asserted.
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) })
  }

  /** The `<select>` a row's own title names, through the `<label for>` the row writes. */
  function pickerNamedByRow(title: string): HTMLSelectElement | null {
    for (const label of [...document.querySelectorAll<HTMLLabelElement>('label[for]')]) {
      if (label.textContent?.trim() !== title) continue
      const target = document.getElementById(label.htmlFor)
      if (target?.tagName === 'SELECT') return target as HTMLSelectElement
    }
    return null
  }

  async function choose(select: HTMLSelectElement | null, value: string): Promise<void> {
    expect(select, 'the engine picker is not drawn').toBeTruthy()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value)
      select!.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }

  const keyBox = () => boxNamedByRow(t('assistant.settings.web_search_key'))

  describe('the engine the reader picks', () => {
    beforeEach(() => { harness.keys.length = 0; searchKeys.mockClear(); putSearchKey.mockClear(); deleteSearchKey.mockClear() })

    it('is a control the row title names, and its choice is the setting that goes out', async () => {
      await mount()
      const picker = pickerNamedByRow(t('assistant.settings.web_search_engine'))
      expect(picker, 'the engine row has no control answering to its title').toBeTruthy()
      await choose(picker, 'tavily')
      // The standing guard this file exists for: a picker whose change never reaches a PATCH is a control
      // that only moves on screen.
      expect(saveSettings).toHaveBeenCalledWith({ webSearchEngine: 'tavily' })
      expect(alert()).toBeNull()
    })

    it('says what each engine does, where the reader is choosing it', async () => {
      await mount()
      // The note the row speaks is the picked engine's own, so a reader chooses with the trade-off in front
      // of them rather than after the setting has already moved.
      expect(document.body.textContent).toContain(t('assistant.settings.web_search_note.self_hosted'))
      expect(t('assistant.settings.web_search_note.self_hosted')).toContain('your own server')
      await mount({ webSearchEngine: 'tavily' })
      await settle()
      const note = t('assistant.settings.web_search_note.tavily')
      // Which machine the query leaves for is the honest content of that note, and it is not invented here.
      expect(note).toContain('api.tavily.com')
      expect(document.body.textContent).toContain(note)
      expect(document.body.textContent).not.toContain(t('assistant.settings.web_search_note.self_hosted'))
    })

    it('draws the address box only for the engine that queries it', async () => {
      await mount()
      expect(row().box, 'the self-hosted engine should show its address box').toBeTruthy()
      await mount({ webSearchEngine: 'tavily' })
      await settle()
      expect(boxNamedByRow(t('assistant.settings.web_search'))).toBeNull()
      expect(keyBox(), 'a hosted engine has no row to store its key in').toBeTruthy()
    })

    it('never puts the key in the box again, and answers with only its last four characters', async () => {
      await mount({ webSearchEngine: 'tavily' })
      await settle()
      const box = keyBox()
      expect(box?.getAttribute('type'), 'a credential box that shows its value is not a credential box').toBe('password')
      // The listing answered "nothing stored", so the row says that instead of leaving a blank to be
      // misread as a key that was lost.
      expect(document.body.textContent).toContain(t('assistant.settings.web_search_key_required'))

      await type(box, 'sk-test-0000000000000000wxyz')
      await click(box?.closest('form')?.querySelector('button[type="submit"]') ?? null, 'the key save button')
      await settle()
      expect(putSearchKey).toHaveBeenCalledWith('tavily', { apiKey: 'sk-test-0000000000000000wxyz' })
      expect(document.body.textContent).not.toContain('sk-test-0000000000000000wxyz')
      expect(keyBox()?.value, 'the box still holds the key it was given').toBe('')
      expect(keyBox()?.getAttribute('placeholder')).toContain('wxyz')
    })

    it('forgets the stored key when the reader asks it to', async () => {
      harness.keys.push({ engine: 'tavily', hasKey: true, keyHint: 'wxyz', updatedAt: 1 })
      await mount({ webSearchEngine: 'tavily' })
      await settle()
      const forget = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === t('assistant.settings.web_search_key_forget'))
      expect(forget, 'a stored key has no way to be taken back out').toBeTruthy()
      await click(forget ?? null, 'the forget button')
      await settle()
      expect(deleteSearchKey).toHaveBeenCalledWith('tavily')
      expect(document.body.textContent).toContain(t('assistant.settings.web_search_key_required'))
    })
  })
})

describe('the composer chip’s three channels', () => {
  type ComposerState = Partial<ReturnType<typeof useAssistant.getState>>

  async function mountComposer(over: ComposerState): Promise<void> {
    useAssistant.setState({
      ...assistantOriginal,
      pending: [],
      skills: [],
      models: [model()],
      providers: [provider('openai')],
      settings: settings({ activeModelId: 'm1' }),
      turnTools: [],
      turnScopes: [],
      mcpServers: [],
      mcpCatalog: [],
      webSearch: false,
      loadSkills: vi.fn(async () => undefined),
      loadMcp: vi.fn(async () => undefined),
      activateModel: vi.fn(async () => undefined),
      updateModel: vi.fn(async () => undefined),
      saveSettings: vi.fn(async () => undefined),
      ...over,
    } as ComposerState)
    await act(async () => {
      root.render(createElement(ChatComposer, {
        streaming: false,
        sendOnEnter: true,
        onSend: async () => true,
        onStop: () => undefined,
        disabled: false,
      }))
    })
  }

  const chip = () => byAria(`${t('assistant.composer.search')}: ${t('assistant.search.off')}`)

  it('is pressable on an OpenAI-compatible provider once an engine is configured', async () => {
    await mountComposer({ settings: settings({ activeModelId: 'm1', webSearchEndpoint: ENGINED }) })
    expect(chip()?.hasAttribute('disabled'), 'a configured engine left the switch dead').toBe(false)
    await click(chip(), 'the search chip')
    expect(useAssistant.getState().webSearch).toBe(true)
  })

  it('keeps a protocol with a vendor-side search pressable with nothing configured', async () => {
    await mountComposer({ providers: [provider('anthropic')] })
    expect(chip()?.hasAttribute('disabled')).toBe(false)
  })

  it('counts a search-capable MCP tool on an enabled server as a channel', async () => {
    await mountComposer({ mcpServers: [mcpServer()], mcpCatalog: [catalog()] })
    expect(chip()?.hasAttribute('disabled'), 'the remote searcher was not counted').toBe(false)
  })

  it('refuses a searcher the reader switched off, and says the engine is missing', async () => {
    await mountComposer({
      mcpServers: [mcpServer({ toolMode: 'off' })],
      mcpCatalog: [catalog()],
    })
    const control = chip()
    expect(control?.hasAttribute('disabled')).toBe(true)
    expect(descriptionOf(control)).toContain(t('assistant.search.unavailable_engine'))
  })

  it('says the read class is what is holding a configured engine back', async () => {
    await mountComposer({
      settings: settings({
        activeModelId: 'm1',
        webSearchEndpoint: ENGINED,
        toolModes: { ...DEFAULT_ASSISTANT_SETTINGS.toolModes, read: 'off' },
      }),
    })
    const control = chip()
    expect(control?.hasAttribute('disabled')).toBe(true)
    expect(descriptionOf(control)).toContain(t('assistant.search.unavailable_read_off'))
  })

  /**
   * A hosted engine is a choice the reader can make without being able to carry it out, because the key is
   * what is missing — and the settings screen draws no address box for that engine at all. A reason that
   * pointed at the address would send the reader looking for a control that was never drawn, which is the
   * mistake this repo has now made four times; the server's own read-out is what tells the two apart.
   */
  it('says a hosted engine waits for a key, without naming an address box', async () => {
    await mountComposer({ settings: settings({ activeModelId: 'm1', webSearchEngine: 'tavily', webSearchKeyStored: false }) })
    const control = chip()
    expect(control?.hasAttribute('disabled'), 'a keyed engine with no key was counted as a channel').toBe(true)
    const said = descriptionOf(control) ?? ''
    expect(said).toContain(t('assistant.search.unavailable_no_key'))
    expect(said).not.toContain(t('assistant.search.unavailable_engine'))
  })

  it('lets the same engine through once its key is stored', async () => {
    await mountComposer({ settings: settings({ activeModelId: 'm1', webSearchEngine: 'tavily', webSearchKeyStored: true }) })
    expect(chip()?.hasAttribute('disabled'), 'a stored key still left the switch dead').toBe(false)
  })
})

describe('the composer’s scope chip', () => {
  it('is a control that says what it limits and reaches the picker', async () => {
    const onOpenScopes = vi.fn()
    const onDropScope = vi.fn()
    await act(async () => {
      root.render(createElement(TurnPinRow, {
        tools: ['search_notes'],
        scopes: [folderScope, tagScope],
        onDropTool: () => undefined,
        onDropScope,
        onOpenScopes,
      }))
    })
    // Not a label any more: the body names the kind and the limit, and pressing it opens the `#` picker.
    const body = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => (node.getAttribute('aria-label') ?? '').includes(t('assistant.scope.kind.folder')))
    expect(body, 'the composer still draws a plain scope label').toBeTruthy()
    expect(body!.getAttribute('aria-label')).toContain(folderScope.name)
    await click(body, 'the scope chip')
    expect(onOpenScopes).toHaveBeenCalledTimes(1)
    expect(onDropScope).not.toHaveBeenCalled()
    await click(byAria(t('assistant.trigger.drop_scope', { name: tagScope.name })), 'the second chip’s cross')
    expect(onDropScope).toHaveBeenCalledWith('t1')
  })
})

describe('a stored turn’s provenance', () => {
  it('names what the answer was allowed to read in text, not only in a tooltip', async () => {
    await act(async () => {
      root.render(createElement(UserBubble, { text: 'What did I ask?', scopes: [folderScope, tagScope] }))
    })
    const group = document.querySelector('[role="group"]')
    expect(group?.getAttribute('aria-label'), 'the turn says nothing about its scope').toBe(t('assistant.scope.answer_saw'))
    const text = group?.textContent ?? ''
    expect(text).toContain(folderScope.name)
    expect(text).toContain(t('assistant.scope.kind.folder'))
    expect(text).toContain(tagScope.name)
    expect(text).toContain(t('assistant.scope.kind.tag'))
    // The names used to live only in a `title`, which a keyboard and a thumb never fire.
    expect(group?.querySelector('[title]'), 'a name still hides behind a hover').toBeNull()
  })

  it('says nothing when the turn pinned nothing', async () => {
    await act(async () => { root.render(createElement(UserBubble, { text: 'What did I ask?' })) })
    expect(document.querySelector('[role="group"]')).toBeNull()
  })
})

describe('a checkbox’s way out to the task list', () => {
  const NOTE_ID = '01hzzzzzzzzzzzzzzzzzzzzz20'

  function ctx(over: Partial<MenuCtx> = {}): MenuCtx {
    return {
      editorView: null,
      editor: null,
      preview: null,
      content: '# A note\n- [ ] Buy more paper\n',
      noteId: NOTE_ID,
      ...over,
    } as unknown as MenuCtx
  }

  const sourceCtx = (): MenuCtx => ctx({
    editorView: {} as never,
    editor: { kind: 'task', pos: 12, line: 2, task: { checked: false, text: 'Buy more paper', from: 9, to: 27 } },
  })

  const previewCtx = (): MenuCtx => ctx({
    preview: {
      kind: 'task',
      // The preview's element is only read by the rows that need one; a task line does not.
      target: document.createElement('li'),
      line: 1,
      task: { checked: false },
    },
  })

  beforeEach(() => {
    useNotes.setState({
      ...notesOriginal,
      notes: { ...notesOriginal.notes, [NOTE_ID]: { ...notesOriginal.notes[NOTE_ID], id: NOTE_ID, title: 'Reading list' } } as never,
    })
    useAssistant.setState({ ...assistantOriginal, loadTasks: vi.fn(async () => undefined) })
    useUi.setState({ ...uiOriginal, toast: vi.fn(() => 'toast-id') })
  })

  it('offers the row on a task line, on both sides of the split view', () => {
    for (const [name, menu] of [['the note', sourceCtx()], ['the rendered document', previewCtx()]] as const) {
      const ids = (buildTaskItems(menu) ?? []).map((item) => item.id)
      expect(ids, `${name} has no way to the task list`).toContain('task-to-assistant')
    }
    // Its place is after the rows that edit the box itself, before the ones that take the line away.
    const source = (buildTaskItems(sourceCtx()) ?? []).map((item) => item.id)
    expect(source.indexOf('task-to-assistant')).toBeGreaterThan(source.indexOf('task-to-bullet'))
    expect(source.indexOf('task-to-assistant')).toBeLessThan(source.indexOf('delete-line'))
  })

  it('makes the task when pressed, with the note’s own words as the way back', async () => {
    const item = (buildTaskItems(sourceCtx()) ?? []).find((entry) => entry.id === 'task-to-assistant')
    expect(item, 'the row is missing').toBeTruthy()
    await act(async () => { item!.onSelect?.() })
    expect(createTask).toHaveBeenCalledTimes(1)
    expect(harness.created[0]?.title).toBe('Buy more paper')
    expect(harness.created[0]?.description).toContain(NOTE_ID)
  })

  it('reads the note title at press time, not when the menu was built', async () => {
    const item = (buildTaskItems(sourceCtx()) ?? []).find((entry) => entry.id === 'task-to-assistant')
    expect(item, 'the row is missing').toBeTruthy()
    // A rename while the menu sat open has to be the name the task carries.
    useNotes.setState({
      ...notesOriginal,
      notes: { ...notesOriginal.notes, [NOTE_ID]: { ...notesOriginal.notes[NOTE_ID], id: NOTE_ID, title: 'Renamed after the menu opened' } } as never,
    })
    await act(async () => { item!.onSelect?.() })
    expect(harness.created[0]?.description).toContain('Renamed after the menu opened')
  })

  it('stays away from a checkbox with nothing to make a task of', () => {
    const empty = ctx({
      editorView: {} as never,
      editor: { kind: 'task', pos: 9, line: 2, task: { checked: false, text: '', from: 0, to: 0 } },
      content: '# A note\n- [ ] \n',
    })
    expect((buildTaskItems(empty) ?? []).map((item) => item.id)).not.toContain('task-to-assistant')
    // A note without an id has nowhere to point the task back at.
    const idless = { ...sourceCtx(), noteId: null }
    expect((buildTaskItems(idless) ?? []).map((item) => item.id)).not.toContain('task-to-assistant')
  })
})

describe('what each key is owed', () => {
  const settle = async (): Promise<void> => {
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
  }

  /** Open the ring, which is where the balance is asked — not with the tab, and not never. */
  const openRing = async (): Promise<void> => {
    await act(async () => { root.render(createElement(ProviderKeys, { provider: provider('openai') })) })
    await settle()
    const toggle = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => (button.textContent ?? '').includes(t('assistant.keys.title')))
    await click(toggle, 'the key ring')
    await settle()
  }

  /** The app's own tooltip, which only exists while a pointer is on the thing it describes. */
  const toldTo = (node: HTMLElement | null | undefined): string | null => {
    expect(node, 'the chip the tooltip hangs from is not drawn').toBeTruthy()
    // `Tooltip` refuses to place a panel on an anchor it cannot measure, and jsdom measures nothing.
    node!.getBoundingClientRect = () => ({
      top: 10, left: 10, right: 90, bottom: 30, x: 10, y: 10, width: 80, height: 20, toJSON: () => ({}),
    }) as DOMRect
    vi.useFakeTimers()
    act(() => { node!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    act(() => { vi.advanceTimersByTime(600) })
    const told = document.body.querySelector('[role="tooltip"]')?.textContent ?? null
    act(() => { node!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
    vi.useRealTimers()
    return told
  }

  /**
   * The chip's own span, not the `Tooltip` wrapper around it.
   * 
   * The wrapper's text is its child's text, so a search over all spans finds the wrapper first — and the
   * component measures the child, so stubbing the wrapper's box would leave the panel unplaced and this
   * case would fail for a reason that has nothing to do with what it asks.
   */
  const chipSaying = (words: string): HTMLElement | undefined =>
    [...document.body.querySelectorAll<HTMLElement>('span.contents > span')].find((node) => (node.textContent ?? '') === words)

  const amount = (value: string, currency: string): string => t('assistant.balance.amount', { amount: value, currency })

  beforeEach(() => {
    providerBalance.mockImplementation(async () => ({
      supported: true,
      readings: [
        { keyId: '', label: '', keyHint: 'abcd', ok: true, amount: 12.5, currency: 'CNY' },
        { keyId: 'k1', label: 'Work', keyHint: 'wxyz', ok: true, amount: 3, currency: 'CNY' },
        { keyId: 'k2', label: 'Spare', keyHint: 'beef', ok: false, reason: 'unauthorized' as const },
      ],
    }))
  })

  it('gives every key its own number, and the failed one its own reason', async () => {
    await openRing()
    expect(providerBalance).toHaveBeenCalled()
    // Three rows, three answers: the provider's own key, and each of the two in the ring.
    expect(document.body.textContent).toContain(amount('12.5', 'CNY'))
    expect(document.body.textContent).toContain(amount('3', 'CNY'))
    // A refusal is shown beside the key it happened to, rather than hidden: an absent number would read as
    // a balance of nothing, which is a different claim about a different key.
    expect(document.body.textContent).toContain(t('assistant.balance.unauthorized'))
  })

  it('says which key a balance belongs to when the pointer asks', async () => {
    await openRing()
    const told = toldTo(chipSaying(amount('3', 'CNY')))
    expect(told, 'the chip answers no pointer').toBeTruthy()
    // The name the reader gave the row, and its last four: the only two things that can tell two keys apart.
    expect(told).toContain('Work')
    expect(told).toContain('wxyz')
  })

  it('says so when the provider reports nothing, instead of leaving the numbers off with no reason', async () => {
    providerBalance.mockImplementation(async () => ({ supported: false, readings: [] }))
    await openRing()
    expect(document.body.textContent).toContain(t('assistant.balance.unsupported_provider'))
    expect(document.body.textContent).not.toContain(amount('3', 'CNY'))
  })
})
