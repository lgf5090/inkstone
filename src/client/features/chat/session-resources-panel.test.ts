// @vitest-environment jsdom
/**
 * The session resource panel: what a conversation accumulated, in one place.
 *
 * The whole thread is read rather than the newest page, so the cases set a fetched thread beside the
 * store's own messages — the two must merge without duplicating a turn. The panel's sections are the
 * contract a reader scans: files, links, notes, tools, drafts, sources, and the doors that open them.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantConversation, type AssistantMcpServer } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../../lib/test-render'
import { useNotes } from '../../store/notes'
import { useAssistant } from './assistant-store'
import { SessionResourcesPanel } from './SessionResourcesPanel'
import { fetchWholeConversation } from './thread-fetch'

vi.mock('./thread-fetch', () => ({ fetchWholeConversation: vi.fn() }))

const NOTE = '01hzzzzzzzzzzzzzzzzzzzzz20'
const conversation: AssistantConversation = {
  id: 'c1', title: 'Planning', pinned: false, starred: false, archived: false, ephemeral: false,
  folderId: null, noteId: NOTE, createdAt: 1, updatedAt: 2, messageCount: 2,
}
const server: AssistantMcpServer = {
  id: 's1', label: 'Context7', url: 'https://mcp.example.com', description: '', transport: 'streamableHttp',
  timeoutSeconds: 20, enabled: true, toolMode: 'ask', toolModes: {}, hasKey: false, authorization: null,
  createdAt: 1, updatedAt: 1,
}
const original = useAssistant.getState()
const notesOriginal = useNotes.getState()
let rendered: RenderedElement | null = null

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  vi.mocked(fetchWholeConversation).mockResolvedValue({
    conversation,
    messages: [
      {
        id: 'm1', conversationId: 'c1', role: 'user', content: `Look at https://example.com/page and [[${NOTE}|Plan]]`,
        tools: [], status: 'complete', error: null, createdAt: 1, source: 'chat', attachments: ['a1'],
      },
      {
        id: 'm2', conversationId: 'c1', role: 'assistant', content: 'Answer', tools: [
          { id: 't1', name: 'search_notes', status: 'success', result: JSON.stringify({ notes: [{ id: NOTE, title: 'Plan' }] }) },
        ], status: 'complete', error: null, createdAt: 2, source: 'chat', modelLabel: 'deepseek-chat',
        usage: { inputTokens: 20, outputTokens: 6 },
        sources: [{ url: 'https://cited.example/page', title: 'Cited page', cited: 'passage' }],
      },
    ],
    attachments: [{
      id: 'a1', kind: 'image', filename: 'plot.png', mime: 'image/png', size: 2048, key: 'chat/images/a1.png', createdAt: 1,
    }],
  })
  useNotes.setState({ ...notesOriginal, notes: { [NOTE]: { id: NOTE, title: 'Plan', rev: 1 } as never } })
  useAssistant.setState({
    ...original,
    activeId: 'c1',
    messages: [],
    fileIndex: {},
    artifacts: [{
      id: 'd1', conversationId: 'c1', title: 'A draft', content: '', noteId: null, version: 2, createdAt: 1, updatedAt: 2,
    }],
    skills: [{ id: 'k1', title: 'Summarise', content: '', group: '', icon: '✨', tools: [], scopes: [], modelId: null, createdAt: 1, updatedAt: 1 }],
    mcpServers: [server],
    turn: null,
    loadSkills: vi.fn(async () => undefined),
    loadArtifacts: vi.fn(async () => undefined),
    setView: vi.fn(),
    settings: { ...DEFAULT_ASSISTANT_SETTINGS, activeModelId: 'm1' },
    models: [{
      id: 'm1', providerId: 'p1', model: 'deepseek-chat', label: 'DeepSeek Flash', icon: '', temperature: null,
      maxOutputTokens: null, enabled: true, reasoning: 'auto', contextTokens: null, vision: true, purpose: 'chat',
      kind: 'text', supportsTools: true, maxInputTokens: null, modalities: [], topP: null, customParams: [],
      protocol: null, fallbackModelId: null, inputPrice: null, outputPrice: null, priceCurrency: '', pricePeriods: [],
    }],
  })
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
  useAssistant.setState(original, true)
  useNotes.setState(notesOriginal, true)
  vi.clearAllMocks()
})

async function openPanel(onClose = vi.fn(), onOpenArtifact = vi.fn()) {
  rendered = renderElement(createElement(SessionResourcesPanel, {
    conversationId: 'c1', title: 'Planning', ephemeral: false, onClose, onOpenArtifact,
  }))
  await act(async () => { await Promise.resolve() })
  await vi.waitFor(() => expect(document.body.textContent).toContain(t('assistant.resources.links')))
  return { onClose, onOpenArtifact }
}

describe('the session resource panel', () => {
  it('groups the thread into files, links, notes, tools, drafts and sources', async () => {
    await openPanel()
    expect(document.body.textContent).toContain('Planning')
    expect(document.body.textContent).toContain(t('assistant.resources.images'))
    expect(document.body.textContent).toContain(t('assistant.resources.links'))
    expect(document.body.textContent).toContain('example.com')
    expect(document.body.textContent).toContain(t('assistant.resources.notes'))
    expect(document.body.textContent).toContain('Plan')
    expect(document.body.textContent).toContain(t('assistant.resources.tools'))
    expect(document.body.textContent).toContain(t('assistant.resources.outputs'))
    expect(document.body.textContent).toContain('A draft')
    expect(document.body.textContent).toContain(t('assistant.resources.sources'))
    expect(document.body.textContent).toContain('Cited page')
    expect(document.body.textContent).toContain(t('assistant.resources.skills'))
    expect(document.body.textContent).toContain('Summarise')
    expect(document.body.textContent).toContain('Context7')
  })

  it('leaves the previous thread behind when the conversation changes', async () => {
    useAssistant.setState({
      messages: [{
        id: 'old', conversationId: 'c0', role: 'user', content: 'STALE https://stale.example/x',
        tools: [], status: 'complete', error: null, createdAt: 3, source: 'chat', attachments: [],
      }],
      artifacts: [
        {
          id: 'd0', conversationId: 'c0', title: 'Other draft', content: '', noteId: null, version: 1, createdAt: 1, updatedAt: 1,
        },
        {
          id: 'd1', conversationId: 'c1', title: 'A draft', content: '', noteId: null, version: 2, createdAt: 1, updatedAt: 2,
        },
      ],
    })
    await openPanel()
    expect(document.body.textContent).not.toContain('stale.example')
    expect(document.body.textContent).not.toContain('Other draft')
    expect(document.body.textContent).toContain('A draft')
  })

  it('opens a draft and a note from their rows', async () => {
    const { onClose, onOpenArtifact } = await openPanel()
    act(() => { [...document.querySelectorAll('button')].find((node) => node.textContent?.includes('A draft'))!.click() })
    expect(onOpenArtifact).toHaveBeenCalledWith('d1')

    act(() => { [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Plan')!.click() })
    expect(onClose).toHaveBeenCalled()
  })
})
