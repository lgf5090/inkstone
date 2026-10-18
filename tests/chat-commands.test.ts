import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantModel, AssistantSettings } from '@shared/assistant'
import { DEFAULT_ASSISTANT_SETTINGS } from '@shared/assistant'
import { initI18n, t } from '../src/client/lib/i18n'
import { installTestGlobals } from '../src/client/lib/test-render'
import { prettyCombo } from '../src/client/lib/hotkeys'
import { useAssistant } from '../src/client/features/chat/assistant-store'
import { CHAT_SHORTCUT_PANEL, CHAT_SHORTCUTS, isChatShortcut } from '../src/client/features/chat/chat-shortcuts'
import { useChatIntent } from '../src/client/features/chat/chat-intents'
import { appCommands, findAppCommand } from '../src/client/features/command/registry'
import { ShortcutsPanel } from '../src/client/features/command/ShortcutsPanel'
import { useUi } from '../src/client/store/ui'
import { appTab } from '../src/client/features/shell/app-tabs'
import { navigateToPath } from '../src/client/lib/app-history'

/** Where the palette hands the reader off to, so a case can name it without repeating the address. */
vi.mock('../src/client/lib/app-history', () => ({
  navigateToPath: vi.fn(),
  currentPathname: () => '/notes',
  tabIdForPath: () => 'notes',
}))

const CHAT_COMMAND_IDS = [
  'assistant-new',
  'assistant-settings',
  'chat-find-conversation',
  'chat-find-in-thread',
  'chat-stop-answer',
  'chat-toggle-web-search',
  'chat-open-model',
]

const CHAT_VIEW = readFileSync(resolve(__dirname, '../src/client/features/chat/ChatView.tsx'), 'utf8')

function model(over: Partial<AssistantModel> = {}): AssistantModel {
  return {
    id: 'model-1',
    providerId: 'p-1',
    model: 'some-chat-model',
    label: 'Some chat model',
    purpose: 'chat',
    kind: 'text',
    enabled: true,
    ...over,
  } as AssistantModel
}

function settings(over: Partial<AssistantSettings> = {}): AssistantSettings {
  return { ...DEFAULT_ASSISTANT_SETTINGS, activeModelId: 'model-1', ...over } as AssistantSettings
}

let root: ReturnType<typeof createRoot>
let host: HTMLDivElement
const originalAssistant = useAssistant.getState()
const originalUi = useUi.getState()
const navigate = vi.mocked(navigateToPath)

function runCommand(id: string): void {
  const command = findAppCommand(id)
  expect(command, `${id} is not registered`).not.toBeNull()
  act(() => command!.run())
}

function toasts(): { title: string, tone?: string }[] {
  return vi.mocked(useUi.getState().toast).mock.calls.map(([options]) => ({ title: options.title, tone: options.tone }))
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  installTestGlobals()
  await initI18n()
  vi.clearAllMocks()
  useAssistant.setState({
    ...originalAssistant,
    view: 'chat',
    activeId: 'c-1',
    conversations: [],
    models: [model()],
    providers: [],
    settings: settings(),
    webSearch: false,
    turn: null,
    remoteStreaming: false,
    loadSettings: vi.fn(async () => undefined),
  } as Partial<ReturnType<typeof useAssistant.getState>>)
  useUi.setState({ ...originalUi, toast: vi.fn() })
  useChatIntent.setState({ intent: null })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(originalAssistant, true)
  useUi.setState(originalUi, true)
  useChatIntent.setState({ intent: null })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the chat actions in the command registry', () => {
  it('registers every one of them with what the palette renders', () => {
    const commands = appCommands()
    for (const id of CHAT_COMMAND_IDS) {
      const command = commands.find((entry) => entry.id === id)
      expect(command, `${id} is missing from the registry`).toBeTruthy()
      expect(command!.label.trim()).not.toBe('')
      expect(command!.group.trim()).not.toBe('')
      expect(typeof command!.run).toBe('function')
    }
    // One implementation per id: a second entry with the same name is a second palette, not a palette.
    expect(new Set(commands.map((entry) => entry.id)).size).toBe(commands.length)
  })

  it('starts a new conversation and puts the chat app in front of the reader', () => {
    const started = vi.fn()
    useAssistant.setState({ newConversation: started } as Partial<ReturnType<typeof useAssistant.getState>>)
    runCommand('assistant-new')
    expect(navigate).toHaveBeenCalledWith(appTab('chat').path)
    expect(useAssistant.getState().view).toBe('chat')
    expect(started).toHaveBeenCalled()
  })

  it("hands the thread's own find panel over to the mounted view", () => {
    runCommand('chat-find-in-thread')
    expect(useAssistant.getState().view).toBe('chat')
    expect(useChatIntent.getState().intent).toBe('find')
  })

  it('refuses to search a thread that is not open, and says so', () => {
    useAssistant.setState({ activeId: null } as Partial<ReturnType<typeof useAssistant.getState>>)
    runCommand('chat-find-in-thread')
    expect(useChatIntent.getState().intent).toBeNull()
    expect(toasts()).toEqual([expect.objectContaining({ title: t('command.chat_no_thread'), tone: 'warning' })])
  })

  it("opens the conversation list for a search of the reader's own threads", () => {
    runCommand('chat-find-conversation')
    expect(navigate).toHaveBeenCalledWith(appTab('chat').path)
    expect(useChatIntent.getState().intent).toBe('conversation-search')
  })

  it('stops the answer that is arriving, and refuses when nothing is', () => {
    const stopped = vi.fn()
    useAssistant.setState({
      stop: stopped,
      // A whole turn record rather than a cast: the command reads several fields off it, and an object
      // that only pretends to be one would stop telling us when the shape changes.
      turn: { conversationId: 'c-1', userText: '', attachments: [], assistantId: null, text: '', reasoning: '', tools: [], stage: undefined, error: null, done: false },
    } as Partial<ReturnType<typeof useAssistant.getState>>)
    runCommand('chat-stop-answer')
    expect(stopped).toHaveBeenCalled()
    useAssistant.setState({ turn: null, remoteStreaming: false } as Partial<ReturnType<typeof useAssistant.getState>>)
    stopped.mockClear()
    runCommand('chat-stop-answer')
    expect(stopped).not.toHaveBeenCalled()
    expect(toasts()).toEqual([expect.objectContaining({ title: t('command.chat_nothing_to_stop'), tone: 'warning' })])
  })

  it('flips the web-search switch the composer also reads', () => {
    runCommand('chat-toggle-web-search')
    expect(useAssistant.getState().webSearch).toBe(true)
    runCommand('chat-toggle-web-search')
    expect(useAssistant.getState().webSearch).toBe(false)
  })

  it('opens the model picker when there is a model to pick, and settings when there is not', () => {
    runCommand('chat-open-model')
    expect(useAssistant.getState().view).toBe('chat')
    expect(useChatIntent.getState().intent).toBe('model')
    useChatIntent.setState({ intent: null })
    useAssistant.setState({ models: [] } as Partial<ReturnType<typeof useAssistant.getState>>)
    runCommand('chat-open-model')
    expect(useChatIntent.getState().intent).toBeNull()
    expect(useAssistant.getState().view).toBe('settings')
    expect(useAssistant.getState().loadSettings).toHaveBeenCalled()
  })

  it("opens the assistant settings the composer's manage entry opens", () => {
    runCommand('assistant-settings')
    expect(useAssistant.getState().view).toBe('settings')
    expect(useAssistant.getState().loadSettings).toHaveBeenCalled()
  })
})

describe("the chat's chords stay in one table", () => {
  it('answers the keys the table names, and no others', () => {
    expect(isChatShortcut(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true }), 'find')).toBe(true)
    expect(isChatShortcut(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF' }), 'find')).toBe(false)
    expect(isChatShortcut(new KeyboardEvent('keydown', { key: 'Escape' }), 'stop')).toBe(true)
    expect(isChatShortcut(new KeyboardEvent('keydown', { key: 'Enter' }), 'send')).toBe(true)
    expect(isChatShortcut(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }), 'send')).toBe(false)
    expect(isChatShortcut(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }), 'newLine')).toBe(true)
  })

  it("is what the view's own handlers read, rather than a copy of the same literals", () => {
    expect(CHAT_VIEW).toContain("isChatShortcut(event.nativeEvent, 'find')")
    expect(CHAT_VIEW).toContain("isChatShortcut(event.nativeEvent, 'stop')")
    expect(CHAT_VIEW).toContain('sendOnEnter ? CHAT_SHORTCUTS.send : CHAT_SHORTCUTS.newLine')
    // The chord used to be spelled out where it was answered; a second place to change is a second
    // place that can disagree with the panel.
    expect(CHAT_VIEW).not.toContain("event.key.toLowerCase() === 'f'")
  })

  it('names the picker chords the composer answers, which its own handler keeps', () => {
    expect(CHAT_SHORTCUTS.pickerNext).toBe('arrowdown')
    expect(CHAT_SHORTCUTS.pickerPrevious).toBe('arrowup')
    expect(CHAT_SHORTCUTS.pickerPick).toBe('enter')
    expect(CHAT_SHORTCUTS.pickerPickAlternate).toBe('tab')
    expect(CHAT_SHORTCUTS.closePanel).toBe('escape')
    const panel = CHAT_VIEW.slice(CHAT_VIEW.indexOf('const onTriggerKey'))
    for (const key of ['ArrowDown', 'ArrowUp', 'Escape', 'Enter', 'Tab']) {
      expect(panel.slice(0, 2000), `the trigger panel no longer answers ${key}`).toContain(`event.key === '${key}'`)
    }
  })
})

describe("the shortcut overview", () => {
  it('lists the chat group with the bindings of the table, in order', async () => {
    await act(async () => {
      root.render(createElement(ShortcutsPanel, { onClose: () => undefined }))
    })
    const heading = Array.from(document.body.querySelectorAll('h3')).find((node) => node.textContent === t('assistant.view.chat'))
    expect(heading, 'the overview has no chat group').toBeTruthy()
    const rows = Array.from(heading!.closest('section')!.querySelectorAll('li'))
    expect(rows).toHaveLength(CHAT_SHORTCUT_PANEL.length)
    rows.forEach((row, index) => {
      const entry = CHAT_SHORTCUT_PANEL[index]!
      expect(row.textContent).toContain(entry.description())
      expect(Array.from(row.querySelectorAll('kbd')).map((key) => key.textContent)).toEqual(prettyCombo(entry.combo))
    })
  })
})
