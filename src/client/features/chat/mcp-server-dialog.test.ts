// @vitest-environment jsdom
/**
 * The form a server is added or edited through.
 *
 * What the form hands over is the whole subject: the panel is a way of asking four questions, and the
 * answer that matters is the body the store receives — a description, the transport, a timeout, and the
 * headers box. The headers case is the subtle one. The worker never gives the values back, so the box is
 * prefilled with names and the rule is that an untouched box keeps what is stored while an emptied one
 * drops it; both halves are pinned here, because getting either wrong silently logs the reader out of a
 * third party they had already configured.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AssistantMcpServer, AssistantMcpServerDetail } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { McpTab } from './AssistantMcpTab'
import { useAssistant, type ReportFailure } from './assistant-store'

vi.mock('../../lib/api', () => ({
  // The store's failure path names the class, so the mock has to carry it.
  ApiError: class ApiError extends Error {},
  api: {
    assistant: {
      mcpServers: vi.fn(async () => ({ servers: [] })),
      mcpTools: vi.fn(async () => ({ servers: [], problems: [] })),
      mcpServer: vi.fn(async () => ({ server: {}, headerNames: [] })),
      createMcpServer: vi.fn(async () => ({ server: {} })),
      patchMcpServer: vi.fn(async () => ({ server: {} })),
      removeMcpServer: vi.fn(async () => ({ ok: true })),
      testMcpServer: vi.fn(async () => ({ ok: true, error: '', tools: [] })),
      settings: vi.fn(async () => ({ settings: {}, models: [] })),
      models: vi.fn(async () => ({ models: [] })),
      providers: vi.fn(async () => ({ providers: [] })),
    },
  },
}))

const SERVER: AssistantMcpServer = {
  id: 's1', label: 'Example', url: 'https://mcp.example.test/mcp', description: 'Library docs',
  transport: 'streamableHttp', timeoutSeconds: 30, enabled: true,
  toolMode: 'ask', toolModes: {}, hasKey: true, authorization: null, createdAt: 1, updatedAt: 1,
}

const STORED: AssistantMcpServerDetail = { server: SERVER, headerNames: ['Authorization'] }

const original = useAssistant.getState()
let root: Root
let host: HTMLElement
let add: Mock<(body: Record<string, unknown>, report?: ReportFailure) => Promise<boolean>>
let patch: Mock<(id: string, body: Record<string, unknown>, report?: ReportFailure) => Promise<boolean>>
let detail: Mock<(id: string) => Promise<AssistantMcpServerDetail | null>>

/** The row of a button, found by the word on it; the tab and the dialog share some of those words. */
const buttonByText = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.includes(text))
const claim = <T,>(node: T | null | undefined, name: string): T => {
  expect(node, `${name} is not rendered`).toBeTruthy()
  return node as T
}
const click = (node: HTMLElement | undefined, name: string) => {
  expect(node, `${name} is not rendered`).toBeTruthy()
  act(() => { node!.click() })
}
/** A press that starts work finishing a tick later: saving, or the editor reading back what is stored. */
async function press(node: HTMLElement | undefined, name: string) {
  expect(node, `${name} is not rendered`).toBeTruthy()
  await act(async () => {
    node!.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
const dialog = () => claim(document.body.querySelector<HTMLElement>('[role="dialog"]'), 'the dialog')
/**
 * The third argument a write now takes: where the form wants the refusal sent, in place of the toast it
 * used to get. Asserted as a function rather than an id, because which box it lands in is the form's
 * business; that it is offered at all is what keeps one failure from being told twice.
 */
const sink = () => expect.any(Function)

/** One keystroke's worth of edit: React reads the value off the native setter it installs. */
async function type(node: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  const field = claim(node, 'the field')
  await act(async () => {
    const prototype = field.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  add = vi.fn(async () => true)
  patch = vi.fn(async () => true)
  detail = vi.fn(async () => STORED)
  useAssistant.setState({
    ...original,
    mcpServers: [],
    mcpCatalog: [],
    mcpProblems: [],
    mcpCatalogLoading: false,
    // The tab asks for a listing when it mounts; the fixture is the answer here.
    loadMcp: vi.fn(async () => undefined),
    addMcpServer: add,
    patchMcpServer: patch,
    loadMcpServer: detail,
  })
  await act(async () => { root.render(createElement(McpTab)) })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(original, true)
  vi.clearAllMocks()
})

/** Open the add menu and take the quick-create row, which is the form this file is about. */
function openForm() {
  click(document.body.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]') ?? undefined, 'the add button')
  click(buttonByText(document.body, t('assistant.mcp.add.quick')), 'the quick-create row')
}

describe('the server form', () => {
  it('sends the name, the address, the description and the headers it read off the box', async () => {
    openForm()
    await type(dialog().querySelector(`input[placeholder="${t('assistant.mcp.label_placeholder')}"]`), 'Docs')
    await type(dialog().querySelector('input[placeholder="https://…/mcp"]'), 'https://mcp.example.test/mcp')
    await type(dialog().querySelector(`input[placeholder="${t('assistant.mcp.description_placeholder')}"]`), 'Library documentation')
    click(buttonByText(dialog(), t('assistant.mcp.advanced')), 'the advanced section')
    await type(dialog().querySelector('textarea'), 'Authorization: Bearer ctx7sk-x\nX-Client=inkstone')
    await press(buttonByText(dialog(), t('assistant.mcp.add')), 'the save button')

    expect(add).toHaveBeenCalledWith({
      label: 'Docs',
      url: 'https://mcp.example.test/mcp',
      description: 'Library documentation',
      transport: 'streamableHttp',
      timeoutSeconds: 30,
      headers: { Authorization: 'Bearer ctx7sk-x', 'X-Client': 'inkstone' },
    }, sink())
  })

  it('sends the type the reader picked, and says what that type needs of the address', async () => {
    openForm()
    const select = claim(dialog().querySelector<HTMLSelectElement>(`select[aria-label="${t('assistant.mcp.type')}"]`), 'the type control')
    expect(select.value).toBe('streamableHttp')
    expect(dialog().textContent).toContain(t('assistant.mcp.type.hint.http'))
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(select, 'sse')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    // The hint follows the choice: the two transports ask different things of the same box, and a
    // reader who picked the wrong one has no other place to find that out before saving.
    expect(dialog().textContent).toContain(t('assistant.mcp.type.hint.sse'))
    expect(dialog().textContent).not.toContain(t('assistant.mcp.type.hint.http'))
    await type(dialog().querySelector(`input[placeholder="${t('assistant.mcp.label_placeholder')}"]`), 'Docs')
    await type(dialog().querySelector('input[placeholder="https://…/mcp"]'), 'https://mcp.example.test/sse')
    await press(buttonByText(dialog(), t('assistant.mcp.add')), 'the save button')

    expect(add).toHaveBeenCalledWith({
      label: 'Docs',
      url: 'https://mcp.example.test/sse',
      description: '',
      transport: 'sse',
      timeoutSeconds: 30,
      headers: {},
    }, sink())
  })

  it('refuses to save a server with no name or no address', async () => {
    openForm()
    const save = claim(buttonByText(dialog(), t('assistant.mcp.add')), 'the save button')
    expect(save.disabled).toBe(true)
    await type(dialog().querySelector(`input[placeholder="${t('assistant.mcp.label_placeholder')}"]`), 'Docs')
    expect(save.disabled).toBe(true)
    await type(dialog().querySelector('input[placeholder="https://…/mcp"]'), 'https://mcp.example.test/mcp')
    expect(save.disabled).toBe(false)
  })
})

describe('the headers a stored server already has', () => {
  /** The card's own edit affordance, which is what opens the form on an existing server. */
  const openEditor = () => press(
    document.body.querySelector<HTMLButtonElement>(`button[aria-label="${t('assistant.mcp.edit')}"]`) ?? undefined,
    'the edit button',
  )

  beforeEach(() => {
    act(() => useAssistant.setState({ mcpServers: [SERVER] }))
  })

  it('keeps them when the box was not touched', async () => {
    await openEditor()
    click(buttonByText(dialog(), t('assistant.mcp.advanced')), 'the advanced section')
    expect(dialog().querySelector('textarea')?.value).toContain('Authorization')
    await press(buttonByText(dialog(), t('common.save')), 'the save button')
    expect(patch).toHaveBeenCalledWith('s1', {
      label: 'Example',
      url: 'https://mcp.example.test/mcp',
      description: 'Library docs',
      transport: 'streamableHttp',
      timeoutSeconds: 30,
    }, sink())
  })

  it('drops them when the whole box was emptied', async () => {
    await openEditor()
    click(buttonByText(dialog(), t('assistant.mcp.advanced')), 'the advanced section')
    await type(dialog().querySelector('textarea'), '')
    await press(buttonByText(dialog(), t('common.save')), 'the save button')
    expect(patch).toHaveBeenCalledWith('s1', expect.objectContaining({ headers: null }), sink())
  })
})

/**
 * What the form does with the answer to its own save.
 *
 * The write used to resolve the same whether the route took it or refused it, so the form closed on every
 * press and the reader had a toast and no server. A refusal now stays on the screen with the draft in the
 * boxes, because the one thing a reader cannot do with a closed dialog is fix the field that was refused.
 */
describe('the answer to a save', () => {
  /** What the route says when it refused one named field, which the code's own sentence never carries. */
  const refusal = () => ({ headline: t('api.error.bad_request'), detail: 'The label is already taken.' })
  const labelBox = () => claim(
    dialog().querySelector<HTMLInputElement>(`input[placeholder="${t('assistant.mcp.label_placeholder')}"]`),
    'the name box',
  )
  const urlBox = () => claim(dialog().querySelector<HTMLInputElement>('input[placeholder="https://…/mcp"]'), 'the address box')
  const saveButton = () => claim(buttonByText(dialog(), t('assistant.mcp.add')), 'the save button')
  /** Both required boxes, so the save is pressable and the draft is recognisable afterwards. */
  async function fill() {
    await type(labelBox(), 'Docs')
    await type(urlBox(), 'https://mcp.example.test/mcp')
  }

  it('keeps the draft and prints the refusal when the write is refused', async () => {
    add.mockImplementation(async (_body, report) => {
      report?.(refusal())
      return false
    })
    openForm()
    await fill()
    await press(saveButton(), 'the save button')

    expect(dialog(), 'a refused save closed the form').toBeTruthy()
    expect(labelBox().value).toBe('Docs')
    const note = claim(document.body.querySelector('[role="alert"]'), 'the inline refusal')
    expect(note.textContent).toContain(refusal().headline)
    expect(note.textContent).toContain('The label is already taken.')
  })

  it('keeps an edit open when the route refuses it', async () => {
    patch.mockImplementation(async (_id, _body, report) => {
      report?.(refusal())
      return false
    })
    act(() => useAssistant.setState({ mcpServers: [SERVER] }))
    await press(
      document.body.querySelector<HTMLButtonElement>(`button[aria-label="${t('assistant.mcp.edit')}"]`) ?? undefined,
      'the card edit button',
    )
    await press(buttonByText(dialog(), t('common.save')), 'the save button')

    expect(dialog(), 'a refused edit closed the form').toBeTruthy()
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('The label is already taken.')
  })

  it('closes only once the write lands', async () => {
    openForm()
    await fill()
    await press(saveButton(), 'the save button')
    expect(document.body.querySelector('[role="dialog"]'), 'a saved server left its form open').toBeNull()
    expect(document.body.querySelector('[role="alert"]')).toBeNull()
  })

  it('holds the button shut while the write is out, and takes no second press', async () => {
    let release!: () => void
    add.mockImplementation(() => new Promise<boolean>((resolve) => { release = () => resolve(true) }))
    openForm()
    await fill()
    await act(async () => { saveButton().click() })

    expect(saveButton().disabled, 'a save in flight can be pressed again').toBe(true)
    expect(saveButton().getAttribute('aria-busy')).toBe('true')
    await act(async () => { saveButton().click() })
    expect(add).toHaveBeenCalledTimes(1)

    await act(async () => {
      release()
      await new Promise((resolve) => { setTimeout(resolve, 0) })
    })
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })
})
