// @vitest-environment jsdom
/**
 * The file dialog offers a recording exactly when the model on screen would receive one.
 *
 * `CHAT_ATTACHMENT_ACCEPT` carries no audio, so a reader who presses "add file" cannot see `.mp3` in the
 * system picker at all: the only doors a recording came through were the drag, the paste and an address.
 * That is the wrong shape of answer — a model that genuinely takes `input_audio` was hiding the one file
 * type it can read — and the fix cannot be to widen the attribute for everybody, because an offer the
 * request builder cannot keep walks the reader into a refusal they just picked with their own hands.
 *
 * So the attribute is now asked of the same target the queue refuses on, and these cases follow the press
 * rather than the algorithm: the `accept` string is read off the `<input type="file">` the composer renders
 * — the one the button actually raises — and is checked in *both* directions. Tick a model on a wire that
 * carries audio and the audio types appear; move back to one that does not and they go away again. A list
 * that only ever grew would pass the first half and leave the reader offered a file the turn refuses.
 *
 * Three more things are pinned here because they are the ways this could quietly be wrong: no clip is ever
 * offered on any model, since no request builder on any protocol carries one; every audio entry that IS
 * offered is one `audioFormatFor` names a container for, so the dialog never offers a file the field would
 * reject; and the document types the turn always reads stay in the list whatever the model is.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ASSISTANT_SETTINGS,
  audioFormatFor,
  type AssistantModel,
  type AssistantProvider,
} from '@shared/assistant'
import { initI18n } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useAssistant } from './assistant-store'
import { ChatComposer } from './ChatView'

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
      uploadChatFile: vi.fn(async () => ({ id: 'a1' })),
      deleteChatFile: vi.fn(async () => ({ deleted: true })),
      chatFileUrl: (id: string) => `/api/assistant/files/${id}`,
    },
  },
}))

function model(over: Partial<AssistantModel> = {}): AssistantModel {
  return {
    id: 'm1', providerId: 'p1', model: 'deepseek-chat', label: 'DeepSeek Chat', temperature: 0.4,
    maxOutputTokens: 8192, enabled: true, reasoning: 'auto', contextTokens: null, vision: true, purpose: 'chat',
    kind: 'text', supportsTools: true, maxInputTokens: null, modalities: [], topP: null, customParams: [],
    protocol: null, fallbackModelId: null, inputPrice: null, outputPrice: null, priceCurrency: '', pricePeriods: [], ...over,
  }
}

function provider(protocol: AssistantProvider['protocol']): AssistantProvider {
  return {
    id: 'p1', label: 'Gateway', protocol, baseUrl: 'https://gateway.example.org/v1', endpoints: {},
    hasKey: true, keyHint: 'abcd', reasoningDialect: null, createdAt: 1, updatedAt: 1,
  }
}

/** One model the reader ticked for audio and one they did not, both on the wire that carries it. */
const TICKED = model({ id: 'm-ticked', label: 'Recorder', modalities: ['audio'] })
const UNTICKED = model({ id: 'm-unticked', label: 'Plain' })

const assistantOriginal = useAssistant.getState()

let root: Root
let host: HTMLElement

/**
 * The `accept` list of the `<input>` the "add file" button raises.
 *
 * Selected by what it *is* rather than by position: the composer renders a second file input for the folder
 * picker, and that one carries `webkitdirectory`. A case that read the wrong input would pass while the
 * button the reader presses still offered nothing.
 */
function pickedTypes(): string[] {
  const inputs = [...document.body.querySelectorAll<HTMLInputElement>('input[type="file"]')]
  const file = inputs.find((node) => !node.hasAttribute('webkitdirectory'))
  expect(file, 'the composer does not draw a file input at all').toBeTruthy()
  const accept = file!.getAttribute('accept')
  expect(accept, 'the file input carries no accept filter').not.toBeNull()
  return accept!.split(',').map((entry) => entry.trim())
}

/** The store as the composer sees it: the two models, the wire they are called on, and the pick. */
async function standOn(activeModelId: string, wire: AssistantProvider['protocol']): Promise<void> {
  useAssistant.setState({
    ...assistantOriginal,
    pending: [],
    skills: [],
    models: [TICKED, UNTICKED],
    providers: [provider(wire)],
    settings: { ...DEFAULT_ASSISTANT_SETTINGS, activeModelId },
    turnTools: [],
    turnScopes: [],
    mcpServers: [],
    mcpCatalog: [],
    webSearch: false,
    loadSkills: vi.fn(async () => undefined),
    loadMcp: vi.fn(async () => undefined),
    activateModel: vi.fn(async () => undefined),
    updateModel: vi.fn(async () => true),
    saveSettings: vi.fn(async () => undefined),
  })
  await act(async () => { root.render(createElement(ChatComposer, {
    streaming: false,
    sendOnEnter: true,
    onSend: async () => true,
    onStop: () => undefined,
    disabled: false,
  })) })
}

/** Re-point the composer at another model the way the picker does, and let the composer answer. */
async function switchTo(activeModelId: string): Promise<void> {
  await act(async () => {
    useAssistant.setState((current) => ({
      settings: { ...(current.settings ?? DEFAULT_ASSISTANT_SETTINGS), activeModelId },
    }))
  })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAssistant.setState(assistantOriginal, true)
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('the file dialog’s audio offer', () => {
  it('shows the audio types once the reader is on a model that takes them', async () => {
    await standOn('m-ticked', 'openai')
    const types = pickedTypes()
    expect(types.filter((entry) => entry.startsWith('audio/')).length, 'no audio mime is offered').toBeGreaterThan(0)
    expect(types.filter((entry) => entry.startsWith('.')), 'no audio extension is offered').toContain('.mp3')
  })

  it('takes them away again when the reader moves to a model nobody ticked', async () => {
    await standOn('m-ticked', 'openai')
    expect(pickedTypes()).toContain('.mp3')

    await switchTo('m-unticked')
    const types = pickedTypes()
    expect(types.some((entry) => entry.startsWith('audio/')), 'the unticked model was still offered an audio mime').toBe(false)
    expect(types).not.toContain('.mp3')
    expect(types).not.toContain('.wav')
  })

  it('takes them away for a model on a wire with no field for them, ticked or not', async () => {
    // The tick means *this model on this wire*: on a line the request builder cannot hand a recording on,
    // offering one is an invitation to a refusal.
    await standOn('m-ticked', 'anthropic')
    const types = pickedTypes()
    expect(types.some((entry) => entry.startsWith('audio/')), 'a dead wire was still offered an audio mime').toBe(false)
    expect(types).not.toContain('.mp3')
  })

  it('never offers a clip on any model, because no protocol carries one', async () => {
    await standOn('m-ticked', 'openai')
    expect(pickedTypes().some((entry) => entry.startsWith('video/') || entry === '.mp4')).toBe(false)
    await switchTo('m-unticked')
    expect(pickedTypes().some((entry) => entry.startsWith('video/') || entry === '.mp4')).toBe(false)
  })

  it('offers no audio entry the audio field would itself refuse', async () => {
    await standOn('m-ticked', 'openai')
    const offered = pickedTypes().filter((entry) => entry.startsWith('audio/') || /\.(mp3|wav|m4a|flac|ogg|aac)$/.test(entry))
    expect(offered.length).toBeGreaterThan(0)
    // A bare `audio/x-wav` has no filename to answer from, so it is asked as the pair a browser hands back.
    for (const entry of offered) {
      const mime = entry.startsWith('audio/') ? entry : ''
      const filename = entry.startsWith('.') ? `recording${entry}` : 'recording'
      expect(audioFormatFor(mime, filename), `${entry} is offered but no container is named for it`).not.toBeNull()
    }
  })

  it('keeps the kinds every turn reads in the list on both models', async () => {
    await standOn('m-ticked', 'openai')
    const types = pickedTypes()
    expect(types).toContain('image/*')
    expect(types).toContain('application/pdf')
    expect(types).toContain('.md')
    // A bare `*` is the defect: it says the picker filters nothing.
    expect(types).not.toContain('*')
    expect(types.every((entry) => entry.length > 0)).toBe(true)

    await switchTo('m-unticked')
    expect(pickedTypes()).toContain('.md')
  })
})
