// @vitest-environment jsdom
/**
 * The settings screen's answer to a server that wants a login.
 *
 * A third party that refuses a call is not broken, and the fix is not a field on this screen — it is the
 * reader pressing a button and logging in at the other end. What is pinned here is that the screen says so
 * in the one case where it is true, keeps quiet in the ordinary case where a server answers with the key it
 * was given, and that the press reaches the flow.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMcpCatalogEntry, AssistantMcpProblem, AssistantMcpServer } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useUi } from '../../store/ui'
import { McpTab } from './AssistantMcpTab'
import { useAssistant } from './assistant-store'

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    assistant: {
      mcpServers: vi.fn(async () => ({ servers: [] })),
      mcpTools: vi.fn(async () => ({ servers: [], problems: [] })),
      patchMcpServer: vi.fn(async () => ({ server: {} })),
      testMcpServer: vi.fn(async () => ({ ok: true, error: '', tools: [] })),
      authorizeMcpServer: vi.fn(async () => ({ url: 'https://auth.example.test/authorize?state=abc' })),
      revokeMcpServer: vi.fn(async () => ({ ok: true })),
      revokeMcpClient: vi.fn(async () => ({ ok: true, revokedAtIssuer: true })),
      settings: vi.fn(async () => ({ settings: {}, models: [] })),
      models: vi.fn(async () => ({ models: [] })),
      providers: vi.fn(async () => ({ providers: [] })),
    },
  },
}))

const CATALOG: AssistantMcpCatalogEntry[] = [{
  serverId: 's1',
  serverLabel: 'Example',
  tools: [{ name: 'mcp_s1_do', remoteName: 'do', serverId: 's1', serverLabel: 'Example', description: 'Does one thing', mode: 'ask' }],
}]

const REFUSAL: AssistantMcpProblem = {
  serverId: 's1', label: 'Example', error: 'The server refused the credentials.', needsAuthorization: true,
}

const serverOf = (over: Partial<AssistantMcpServer>): AssistantMcpServer => ({
  id: 's1', label: 'Example', url: 'https://mcp.example.test/mcp', description: '',
  transport: 'streamableHttp', timeoutSeconds: 30, enabled: true,
  toolMode: 'ask', toolModes: {}, hasKey: false, authorization: null, createdAt: 1, updatedAt: 1,
  ...over,
})

const original = useAssistant.getState()
let root: Root
let host: HTMLElement
let mounted = false

const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const byLabel = (text: string) => buttons().find((node) => node.textContent?.trim() === text)
const click = (node: HTMLElement | undefined) => {
  expect(node, 'the button is not rendered').toBeTruthy()
  act(() => { node!.click() })
}

async function openTab(over: Partial<AssistantMcpServer> = {}, problems: AssistantMcpProblem[] = []) {
  mounted = true
  useAssistant.setState({
    ...original,
    mcpServers: [serverOf(over)],
    mcpCatalog: CATALOG,
    mcpProblems: problems,
    mcpCatalogLoading: false,
    loadMcp: vi.fn(async () => undefined),
    authorizeMcp: vi.fn(async () => true),
    revokeMcp: vi.fn(async () => undefined),
    revokeMcpClient: vi.fn(async () => true),
    testMcpServer: vi.fn(async () => ({ ok: true, error: '', count: 1 })),
  })
  await act(async () => { root.render(createElement(McpTab)) })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  mounted = false
})

afterEach(() => {
  if (mounted) act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(original, true)
  vi.clearAllMocks()
})

describe('a server that wants a login', () => {
  it('offers the one press that can fix it', async () => {
    await openTab({}, [REFUSAL])
    const authorize = byLabel(t('assistant.mcp.authorize'))
    expect(authorize).toBeTruthy()
    // The refusal is still shown: the button is the way out, not a reason to hide what happened.
    expect(document.body.textContent).toContain(REFUSAL.error)
    click(authorize)
    await act(async () => { await Promise.resolve() })
    expect(useAssistant.getState().authorizeMcp).toHaveBeenCalledWith('s1')
  })

  it('offers it again when a round trip was started and never finished', async () => {
    await openTab({ authorization: { issuer: 'https://auth.example.test', scopes: ['mcp:tools'], authorized: false, expiresAt: 0, clientId: 'client-42', dynamic: true } })
    expect(byLabel(t('assistant.mcp.authorize'))).toBeTruthy()
    expect(byLabel(t('assistant.mcp.reauthorize'))).toBeUndefined()
  })

  it('says who the reader logged in with, and offers to take that away', async () => {
    await openTab({
      hasKey: true,
      authorization: { issuer: 'https://auth.example.test', scopes: ['mcp:tools'], authorized: true, expiresAt: Date.now() + 60_000, clientId: 'client-42', dynamic: true },
    })
    expect(document.body.textContent).toContain('auth.example.test')
    expect(byLabel(t('assistant.mcp.authorize'))).toBeUndefined()
    expect(byLabel(t('assistant.mcp.reauthorize'))).toBeUndefined()
    click(byLabel(t('assistant.mcp.revoke')))
    await act(async () => { await Promise.resolve() })
    expect(useAssistant.getState().revokeMcp).toHaveBeenCalledWith('s1')
  })

  it('names the registered client and offers to withdraw it, apart from revoking access', async () => {
    await openTab({
      hasKey: true,
      authorization: { issuer: 'https://auth.example.test', scopes: ['mcp:tools'], authorized: true, expiresAt: Date.now() + 60_000, clientId: 'client-42', dynamic: true },
    })
    // Both the id and the scopes are on screen: the reader's account page at their provider lists clients
    // by id, so a registration they want gone is only findable if the screen names it.
    expect(document.body.textContent).toContain('client-42')
    expect(document.body.textContent).toContain('mcp:tools')
    // Two separate presses, because they are two separate acts: logging out leaves the registration, and
    // withdrawing it is the rarer one that tells the provider to forget this app.
    expect(byLabel(t('assistant.mcp.revoke'))).toBeTruthy()
    click(byLabel(t('assistant.mcp.revoke_client')))
    await act(async () => { await Promise.resolve() })
    expect(useAssistant.getState().revokeMcpClient).toHaveBeenCalledWith('s1')
    expect(useAssistant.getState().revokeMcp).not.toHaveBeenCalled()
  })

  it('asks to be let in again when a server refuses one it already holds a token for', async () => {
    await openTab(
      { hasKey: true, authorization: { issuer: 'https://auth.example.test', scopes: [], authorized: true, expiresAt: 0, clientId: 'client-42', dynamic: true } },
      [REFUSAL],
    )
    // Not the plain first-run word: the reader has done this, and something about it stopped working.
    click(byLabel(t('assistant.mcp.reauthorize')))
    await act(async () => { await Promise.resolve() })
    expect(useAssistant.getState().authorizeMcp).toHaveBeenCalledWith('s1')
  })

  it('says nothing about logging in to a server that answered', async () => {
    await openTab({ hasKey: true })
    expect(byLabel(t('assistant.mcp.authorize'))).toBeUndefined()
    expect(byLabel(t('assistant.mcp.revoke'))).toBeUndefined()
  })

  it('does not offer a login for a server that refused for some other reason', async () => {
    await openTab({}, [{ serverId: 's1', label: 'Example', error: 'The server could not be reached.', needsAuthorization: false }])
    expect(document.body.textContent).toContain('The server could not be reached.')
    expect(byLabel(t('assistant.mcp.authorize'))).toBeUndefined()
  })
})

describe('the login the press starts', () => {
  const AUTH_URL = 'https://auth.example.test/authorize?state=abc'

  beforeEach(async () => {
    installTestGlobals()
    await initI18n()
    useAssistant.setState({
      ...original,
      mcpServers: [serverOf({})],
      mcpCatalog: CATALOG,
      mcpProblems: [],
      loadMcp: vi.fn(async () => undefined),
    })
  })

  it('opens the address the worker built, then reads the server list again', async () => {
    const { api } = await import('../../lib/api')
    const opened = vi.spyOn(window, 'open').mockImplementation(() => ({ closed: true }) as unknown as Window)
    await useAssistant.getState().authorizeMcp('s1')
    expect(api.assistant.authorizeMcpServer).toHaveBeenCalledWith('s1')
    expect(opened).toHaveBeenCalledWith(AUTH_URL, 'inkstone-mcp-oauth', expect.any(String))
    // Read again rather than remembered: whether the token arrived is a fact about the worker, and the
    // popup that carried the login is on somebody else's origin by the time it closes.
    await vi.waitFor(() => expect(useAssistant.getState().loadMcp).toHaveBeenCalled())
    opened.mockRestore()
  })

  it('says when the browser took the way out away', async () => {
    const toasts = useUi.getState().toast
    const spy = vi.fn()
    useUi.setState({ toast: spy as typeof toasts })
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null)
    const done = await useAssistant.getState().authorizeMcp('s1')
    expect(done).toBe(false)
    expect(spy).toHaveBeenCalledWith({ title: t('assistant.mcp.authorize_blocked'), tone: 'danger' })
    expect(useAssistant.getState().loadMcp).not.toHaveBeenCalled()
    opened.mockRestore()
  })
})
