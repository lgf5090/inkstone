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
}))

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    mcp: {
      get: mocks.get,
      save: mocks.save,
      revokeGrant: vi.fn(),
      revokeAllGrants: vi.fn(),
      createKey: vi.fn(),
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

async function open(disabledTools: string[] = []) {
  mounted = true
  mocks.get.mockResolvedValue(info(disabledTools))
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
