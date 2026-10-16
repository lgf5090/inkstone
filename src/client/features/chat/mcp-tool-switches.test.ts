// @vitest-environment jsdom
/**
 * The switches inside one MCP server.
 *
 * Two halves are pinned. The screen is the drive — a card says how many of its tools are on, opening it
 * lists them, and one switch changes exactly one name — and the store is the write: every press sends the
 * whole off-list, because the row holds a list and a delta would race the press before it.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMcpServer } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { api } from '../../lib/api'
import { McpTab } from './AssistantMcpTab'
import { useAssistant } from './assistant-store'

vi.mock('../../lib/api', () => ({
  // The store's failure path names the class, so the mock has to carry it.
  ApiError: class ApiError extends Error {},
  api: {
    assistant: {
      mcpServers: vi.fn(async () => ({ servers: [] })),
      mcpTools: vi.fn(async () => ({ servers: [], problems: [] })),
      patchMcpServer: vi.fn(async () => ({ server: {} })),
      testMcpServer: vi.fn(async () => ({ ok: true, error: '', tools: [] })),
      settings: vi.fn(async () => ({ settings: {}, models: [] })),
      models: vi.fn(async () => ({ models: [] })),
      providers: vi.fn(async () => ({ providers: [] })),
    },
  },
}))

const SERVER: AssistantMcpServer = {
  id: 's1', label: 'Example', url: 'https://mcp.example.test/mcp', description: '',
  transport: 'streamableHttp', timeoutSeconds: 30, enabled: true,
  toolMode: 'ask', disabledTools: ['drop_everything'], hasKey: true, authorization: null, createdAt: 1, updatedAt: 1,
}

const CATALOG = [{
  serverId: 's1',
  serverLabel: 'Example',
  tools: [
    { name: 'mcp_s1_resolve', remoteName: 'resolve-library-id', description: 'Find a library id', disabled: false },
    { name: 'mcp_s1_drop', remoteName: 'drop_everything', description: 'Removes data', disabled: true },
    { name: 'mcp_s1_web', remoteName: 'web_lookup', description: 'Searches the live web', disabled: false },
  ],
}]

const original = useAssistant.getState()
let root: Root
let host: HTMLElement

const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
/** The tools door carries its count beside its word, so the row is found by what it contains. */
const byText = (text: string) => buttons().find((node) => node.textContent?.includes(text))
const switches = () => [...document.body.querySelectorAll<HTMLButtonElement>('button[role="switch"]')]
const switchFor = (name: string) => document.body.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${name}"]`)
const click = (node: HTMLElement | undefined, name: string) => {
  expect(node, `${name} is not rendered`).toBeTruthy()
  act(() => { node!.click() })
}

let mounted = false

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  mounted = false
  useAssistant.setState({
    ...original,
    mcpServers: [SERVER],
    mcpCatalog: CATALOG,
    mcpProblems: [],
    mcpCatalogLoading: false,
    // The tab asks for a listing when it mounts; here the fixture is the answer, so the real one — which
    // would replace this server with the empty response its own mocked call returns — is not called.
    loadMcp: vi.fn(async () => undefined),
    setMcpToolsEnabled: vi.fn(async () => undefined),
  })
})

/** Render the tab. Only the screen's own cases do; the last one writes through the store alone. */
async function openTab() {
  mounted = true
  await act(async () => { root.render(createElement(McpTab)) })
}

afterEach(() => {
  if (mounted) act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(original, true)
  vi.clearAllMocks()
})

describe('one server and its tools', () => {
  beforeEach(openTab)

  it('says how many of them are on before any of them is drawn', () => {
    expect(document.body.textContent).toContain('2/3')
    // The row's own switch is the server, and the tools stay folded until asked for.
    expect(switches()).toHaveLength(1)
    expect(document.body.textContent).not.toContain('drop_everything')
  })

  it('lists them, marks the ones switched off, and leaves the filter to the reader', async () => {
    click(byText(t('assistant.mcp.tools')), 'the tools door')
    expect(document.body.textContent).toContain('resolve-library-id')
    expect(document.body.textContent).toContain('drop_everything')
    expect(switchFor('drop_everything')?.getAttribute('aria-checked')).toBe('false')
    expect(switchFor('resolve-library-id')?.getAttribute('aria-checked')).toBe('true')

    const search = document.body.querySelector<HTMLInputElement>(`input[aria-label="${t('assistant.mcp.search_tools')}"]`)
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(search, 'web')
      search!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(document.body.textContent).toContain('web_lookup')
    expect(document.body.textContent).not.toContain('resolve-library-id')
  })

  it('switches exactly the tool whose switch was pressed', () => {
    click(byText(t('assistant.mcp.tools')), 'the tools door')
    click(switchFor('resolve-library-id') ?? undefined, 'the resolve switch')
    expect(useAssistant.getState().setMcpToolsEnabled)
      .toHaveBeenCalledWith(SERVER, ['resolve-library-id'], false)
    click(switchFor('drop_everything') ?? undefined, 'the drop switch')
    expect(useAssistant.getState().setMcpToolsEnabled)
      .toHaveBeenCalledWith(SERVER, ['drop_everything'], true)
  })

  it('turns every tool on or off in one press, naming them all', () => {
    click(byText(t('assistant.mcp.tools')), 'the tools door')
    click(byText(t('assistant.mcp.enable_all')), 'the enable-all button')
    expect(useAssistant.getState().setMcpToolsEnabled)
      .toHaveBeenCalledWith(SERVER, ['resolve-library-id', 'drop_everything', 'web_lookup'], true)
    click(byText(t('assistant.mcp.disable_all')), 'the disable-all button')
    expect(useAssistant.getState().setMcpToolsEnabled)
      .toHaveBeenCalledWith(SERVER, ['resolve-library-id', 'drop_everything', 'web_lookup'], false)
  })
})

describe('what one press writes', () => {
  it('sends the whole off-list, so two presses cannot lose one another', async () => {
    useAssistant.setState({ ...original, loadMcp: vi.fn(async () => undefined) }, true)
    await act(async () => {
      await useAssistant.getState().setMcpToolsEnabled(SERVER, ['web_lookup'], false)
    })
    expect(api.assistant.patchMcpServer).toHaveBeenCalledWith('s1', {
      disabledTools: ['drop_everything', 'web_lookup'],
    })

    const switchedOn = { ...SERVER, disabledTools: ['drop_everything', 'web_lookup'] }
    await act(async () => {
      await useAssistant.getState().setMcpToolsEnabled(switchedOn, ['drop_everything'], true)
    })
    expect(api.assistant.patchMcpServer).toHaveBeenLastCalledWith('s1', { disabledTools: ['web_lookup'] })
  })
})
