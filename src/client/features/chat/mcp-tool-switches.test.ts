// @vitest-environment jsdom
/**
 * What one MCP server's tools are each allowed to do.
 *
 * Two halves are pinned. The screen is the drive — a card says how many of its tools are offered, opening
 * it lists them, and one row answers for exactly one name — and the store is the write: every press sends
 * the whole map, because the row holds a map and a delta would race the press before it. The map stays a
 * list of exceptions, so answering with what the server already says puts the tool back under it.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMcpCatalogEntry, AssistantMcpServer, AssistantMcpToolMode } from '@shared/assistant'
import { initI18n, t, type MessageKey } from '../../lib/i18n'
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

const MODE_KEYS: Record<AssistantMcpToolMode, MessageKey> = {
  off: 'assistant.mcp.mode.off',
  ask: 'assistant.mcp.mode.ask',
  auto: 'assistant.mcp.mode.auto',
}

const SERVER: AssistantMcpServer = {
  id: 's1', label: 'Example', url: 'https://mcp.example.test/mcp', description: '',
  transport: 'streamableHttp', timeoutSeconds: 30, enabled: true,
  toolMode: 'ask', toolModes: { drop_everything: 'off', web_lookup: 'auto' },
  hasKey: true, authorization: null, createdAt: 1, updatedAt: 1,
}

const tool = (remoteName: string, description: string, mode: AssistantMcpToolMode, extra: Record<string, unknown> = {}) => ({
  name: `mcp_s1_${remoteName}`, remoteName, serverId: 's1', serverLabel: 'Example',
  description, mode, ...extra,
})

const CATALOG: AssistantMcpCatalogEntry[] = [{
  serverId: 's1',
  serverLabel: 'Example',
  tools: [
    tool('resolve-library-id', 'Find a library id', 'ask'),
    tool('drop_everything', 'Removes data', 'off'),
    tool('web_lookup', 'Searches the live web', 'auto', { inputSchema: '{\n  "type": "object"\n}' }),
  ],
}]

const original = useAssistant.getState()
let root: Root
let host: HTMLElement

const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
/** The tools door carries its count beside its word, so the row is found by what it contains. */
const byText = (text: string) => buttons().find((node) => node.textContent?.includes(text))
const switches = () => [...document.body.querySelectorAll<HTMLButtonElement>('button[role="switch"]')]
/** The one tool's own three answers, found by the group's name and the option's word. */
const modeOption = (remoteName: string, mode: AssistantMcpToolMode) =>
  [...document.body.querySelectorAll<HTMLButtonElement>(`[role="radiogroup"][aria-label="${remoteName}"] button[role="radio"]`)]
    .find((node) => node.textContent?.trim() === t(MODE_KEYS[mode]))
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
    setMcpToolModes: vi.fn(async () => undefined),
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

  it('says how many of them are offered before any of them is drawn', () => {
    expect(document.body.textContent).toContain('2/3')
    // The row's own switch is the server, and the tools stay folded until asked for.
    expect(switches()).toHaveLength(1)
    expect(document.body.textContent).not.toContain('drop_everything')
  })

  it('lists them under the answer each one is running with, and leaves the filter to the reader', async () => {
    click(byText(t('assistant.mcp.tools')), 'the tools door')
    expect(document.body.textContent).toContain('resolve-library-id')
    expect(document.body.textContent).toContain('drop_everything')
    // The server says ask; two of its tools disagree, and the rows show each tool's own answer.
    expect(modeOption('resolve-library-id', 'ask')?.getAttribute('aria-checked')).toBe('true')
    expect(modeOption('drop_everything', 'off')?.getAttribute('aria-checked')).toBe('true')
    expect(modeOption('web_lookup', 'auto')?.getAttribute('aria-checked')).toBe('true')

    const search = document.body.querySelector<HTMLInputElement>(`input[aria-label="${t('assistant.mcp.search_tools')}"]`)
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(search, 'web')
      search!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(document.body.textContent).toContain('web_lookup')
    expect(document.body.textContent).not.toContain('resolve-library-id')
  })

  it('answers for exactly the tool whose row was pressed', () => {
    click(byText(t('assistant.mcp.tools')), 'the tools door')
    click(modeOption('resolve-library-id', 'off'), 'the resolve row’s off')
    expect(useAssistant.getState().setMcpToolModes)
      .toHaveBeenCalledWith(SERVER, { 'resolve-library-id': 'off' })
    click(modeOption('drop_everything', 'ask'), 'the drop row’s ask')
    expect(useAssistant.getState().setMcpToolModes)
      .toHaveBeenCalledWith(SERVER, { drop_everything: 'ask' })
  })

  it('shows a tool’s published arguments when the reader asks for them', () => {
    click(byText(t('assistant.mcp.tools')), 'the tools door')
    expect(document.body.textContent).not.toContain('"type": "object"')
    click(byText(t('assistant.mcp.tool_schema')), 'the arguments door')
    expect(document.body.textContent).toContain('"type": "object"')
  })

  it('answers for every tool in one press', () => {
    click(byText(t('assistant.mcp.tools')), 'the tools door')
    // Following the server is not "on": it is every tool put back under the answer the server already gives.
    click(byText(t('assistant.mcp.enable_all')), 'the follow-all button')
    expect(useAssistant.getState().setMcpToolModes).toHaveBeenCalledWith(SERVER, {
      'resolve-library-id': 'ask', drop_everything: 'ask', web_lookup: 'ask',
    })
    click(byText(t('assistant.mcp.disable_all')), 'the disable-all button')
    expect(useAssistant.getState().setMcpToolModes).toHaveBeenCalledWith(SERVER, {
      'resolve-library-id': 'off', drop_everything: 'off', web_lookup: 'off',
    })
  })
})

describe('what one press writes', () => {
  it('sends the whole map, and drops an answer the server already gives', async () => {
    useAssistant.setState({ ...original, loadMcp: vi.fn(async () => undefined) }, true)
    await act(async () => {
      await useAssistant.getState().setMcpToolModes(SERVER, { web_lookup: 'off' })
    })
    expect(api.assistant.patchMcpServer).toHaveBeenCalledWith('s1', {
      toolModes: { drop_everything: 'off', web_lookup: 'off' },
    })

    // A tool set back to what the server says is no longer an exception, so the map shrinks rather than
    // growing a second entry that says the same thing as the row it sits on.
    await act(async () => {
      await useAssistant.getState().setMcpToolModes(SERVER, { drop_everything: 'ask', web_lookup: 'ask' })
    })
    expect(api.assistant.patchMcpServer).toHaveBeenLastCalledWith('s1', { toolModes: {} })
  })
})
