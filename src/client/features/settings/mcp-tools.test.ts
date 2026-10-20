// @vitest-environment jsdom
/**
 * The tool switches on the MCP settings screen.
 *
 * A switch here is not a local preference: it decides what the MCP server registers, so what is pinned is
 * that the press sends the whole switched-off list — the route refuses a name it does not recognise, which
 * it can only do against a complete list — and that a switch already off is drawn off when the screen opens.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpSettingsInfo } from '@shared/types'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { McpSettings } from './McpSettings'
import { mcpResource } from './resources'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
  createKey: vi.fn(),
}))

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    mcp: {
      get: mocks.get,
      save: mocks.save,
      revokeGrant: vi.fn(),
      revokeAllGrants: vi.fn(),
      createKey: mocks.createKey,
      revokeKey: vi.fn(),
      aiSearch: { save: vi.fn(), reindex: vi.fn(), clear: vi.fn() },
    },
  },
}))

const info = (disabledTools: string[]): McpSettingsInfo => ({
  enabled: true,
  canManageGlobal: true,
  endpoint: 'https://inkstone.test/mcp',
  oauth: true,
  preferences: { writeEnabled: true, trashEnabled: false, disabledTools, updatedAt: 1 },
  tools: [
    { name: 'search', title: 'Search Inkstone', description: 'Find notes.' },
    { name: 'create_note', title: 'Create note', description: 'Write a note.' },
  ],
  apiKeys: [],
  aiSearch: { available: false, enabled: false, model: '', indexedCount: 0, pendingCount: 0, reason: 'no_ai_binding' },
  grants: [],
  privacy: { publicEndpoint: false, perUserIndex: true, externalClientReceivesSelectedContent: true },
})

let root: Root
let host: HTMLElement
let mounted = false

const toolSwitch = (title: string) => document.body.querySelector<HTMLButtonElement>(
  `[role="switch"][aria-label="${t('settings.mcp_tool_enabled', { name: title })}"]`,
)

async function open(disabledTools: string[] = [], preferences?: McpSettingsInfo['preferences']) {
  mounted = true
  mocks.get.mockResolvedValue(preferences ? { ...info(disabledTools), preferences } : info(disabledTools))
  mocks.save.mockResolvedValue({
    enabled: true,
    preferences: { writeEnabled: true, trashEnabled: false, disabledTools, updatedAt: 2 },
    reconnectRequired: false,
  })
  await act(async () => { root.render(createElement(McpSettings)) })
  await act(async () => { await Promise.resolve() })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  mcpResource.clear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  mounted = false
  mocks.get.mockReset()
  mocks.save.mockReset()
})

afterEach(() => {
  if (mounted) act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  mcpResource.clear()
  vi.clearAllMocks()
})

describe('the MCP tool switches', () => {
  it('draws one switch per tool the server can publish', async () => {
    await open()
    expect(toolSwitch('Search Inkstone')).toBeTruthy()
    expect(toolSwitch('Create note')).toBeTruthy()
    // Every tool arrives offered: nothing is switched off until somebody says so.
    expect(toolSwitch('Create note')?.getAttribute('aria-checked')).toBe('true')
  })

  it('draws a tool the reader switched off as off', async () => {
    await open(['create_note'])
    expect(toolSwitch('Create note')?.getAttribute('aria-checked')).toBe('false')
    expect(toolSwitch('Search Inkstone')?.getAttribute('aria-checked')).toBe('true')
  })

  it('sends the whole switched-off list when one tool is switched off', async () => {
    await open(['search'])
    await act(async () => { toolSwitch('Create note')?.click() })
    await act(async () => { await Promise.resolve() })
    // Both names, not just the new one: the route checks every name against the tools it registers, so a
    // delta would read as "switch everything else back on".
    expect(mocks.save).toHaveBeenCalledWith({ disabledTools: ['search', 'create_note'] })
  })

  it('drops a tool from the list when it is switched back on', async () => {
    await open(['search', 'create_note'])
    await act(async () => { toolSwitch('Search Inkstone')?.click() })
    await act(async () => { await Promise.resolve() })
    expect(mocks.save).toHaveBeenCalledWith({ disabledTools: ['create_note'] })
  })
})

/** The switches that decide what the next API key may do, by the permission they name. */
const keyScopeSwitch = (scopeKey: 'settings.mcp_scope_write' | 'settings.mcp_scope_trash' | 'settings.mcp_scope_todo_read' | 'settings.mcp_scope_todo_write' | 'settings.mcp_scope_todo_danger') =>
  document.body.querySelector<HTMLButtonElement>(
    `[role="switch"][aria-label="${t('settings.mcp_api_key_scope_toggle', { scope: t(scopeKey) })}"]`,
  )

const byText = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
  .find((node) => node.textContent?.trim() === text)

describe('the scope switches for a new API key', () => {
  it('offers only the permissions the account has switched on', async () => {
    await open()
    expect(keyScopeSwitch('settings.mcp_scope_write')?.getAttribute('aria-checked')).toBe('true')
    // Trash is not offered at all: the account has not allowed it, so a key could not carry it anyway, and a
    // greyed-out switch would read as a broken control rather than as an answer.
    expect(keyScopeSwitch('settings.mcp_scope_trash')).toBeNull()
  })

  it('sends the narrowed list, with reads riding along', async () => {
    await open()
    mocks.createKey.mockResolvedValue({
      key: { id: 'k1', name: 'Automation', scopes: ['notes:read'], createdAt: 1, lastUsedAt: null },
      token: 'ink_test',
    })
    await act(async () => { keyScopeSwitch('settings.mcp_scope_write')?.click() })
    await act(async () => { keyScopeSwitch('settings.mcp_scope_todo_read')?.click() })
    await act(async () => { keyScopeSwitch('settings.mcp_scope_todo_write')?.click() })
    const name = document.body.querySelector<HTMLInputElement>(`input[aria-label="${t('settings.mcp_api_key_name')}"]`)
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(name, 'Automation')
      name!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { byText(t('settings.mcp_api_key_create'))?.click() })
    await act(async () => { await Promise.resolve() })
    // The withheld list, not a permission list: the server adds reads back, since a key that may read
    // nothing has no use at this endpoint.
    expect(mocks.createKey).toHaveBeenCalledWith('Automation', [])
  })

  it('asks for everything the account allows when nothing was touched', async () => {
    await open()
    mocks.createKey.mockResolvedValue({
      key: { id: 'k1', name: 'Automation', scopes: ['notes:read', 'notes:write'], createdAt: 1, lastUsedAt: null },
      token: 'ink_test',
    })
    const name = document.body.querySelector<HTMLInputElement>(`input[aria-label="${t('settings.mcp_api_key_name')}"]`)
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(name, 'Automation')
      name!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { byText(t('settings.mcp_api_key_create'))?.click() })
    await act(async () => { await Promise.resolve() })
    // Undefined, not a list: "the reader never touched these" has to stay distinguishable from "the reader
    // switched everything off", or a default would quietly become a decision.
    expect(mocks.createKey).toHaveBeenCalledWith('Automation', undefined)
  })
})

describe('the permissions a key may be given', () => {
  it('offers the to-do family beside the note one, gated the same way', async () => {
    // The fixture's own preferences: writes on, trash off.
    await open()

    expect(keyScopeSwitch('settings.mcp_scope_write'), 'notes:write vanished').toBeTruthy()
    expect(keyScopeSwitch('settings.mcp_scope_todo_read'), 'a key can never be given to-do reads').toBeTruthy()
    expect(keyScopeSwitch('settings.mcp_scope_todo_write'), 'a key can never be given to-do writes').toBeTruthy()
    expect(keyScopeSwitch('settings.mcp_scope_trash'), 'trash was offered with the account switch off').toBeNull()
    expect(keyScopeSwitch('settings.mcp_scope_todo_danger'), 'hard delete was offered with the account switch off').toBeNull()
  })

  it('opens the delete family together for both domains and closes together', async () => {
    await open([], { writeEnabled: false, trashEnabled: true, disabledTools: [], updatedAt: 1 })

    expect(keyScopeSwitch('settings.mcp_scope_write'), 'notes:write stayed with the switch off').toBeNull()
    expect(keyScopeSwitch('settings.mcp_scope_todo_write'), 'todos:write stayed with the switch off').toBeNull()
    expect(keyScopeSwitch('settings.mcp_scope_trash'), 'notes:trash is missing').toBeTruthy()
    expect(keyScopeSwitch('settings.mcp_scope_todo_danger'), 'todos:danger is missing').toBeTruthy()
    // A to-do read costs nothing to the account's own switches — it is a different domain, not a stronger
    // one — so it is offered whether or not writing is on.
    expect(keyScopeSwitch('settings.mcp_scope_todo_read'), 'todos:read rides the account switch it does not need').toBeTruthy()
  })

  it('leaves a denied to-do permission out of the minted key', async () => {
    await open()
    mocks.createKey.mockResolvedValue({
      key: { id: 'k1', name: 'Calendar', scopes: ['notes:read'], createdAt: 1, lastUsedAt: null },
      token: 'ink_test',
    })

    // Every offered permission starts on, so the reader's decision is what to withhold — and what is
    // withheld has to be what the mint leaves out, not merely what the screen stopped showing.
    await act(async () => { keyScopeSwitch('settings.mcp_scope_todo_read')?.click() })

    const name = document.body.querySelector<HTMLInputElement>(`input[aria-label="${t('settings.mcp_api_key_name')}"]`)
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(name, 'Calendar')
      name!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { byText(t('settings.mcp_api_key_create'))?.click() })
    await act(async () => { await Promise.resolve() })

    expect(mocks.createKey).toHaveBeenCalledWith('Calendar', ['notes:write', 'todos:write'])
  })
})
