// @vitest-environment jsdom
/**
 * Applying a saved skill arms the turn, not only the text box.
 *
 * The point of binding tools, folders and a model to a skill is that one press arranges all four. What
 * is pinned here is the arrangement: the pins take the place of the turn's own rather than joining them,
 * the ceilings the turn obeys are the ceilings a saved skill obeys, and a skill that names no model
 * leaves the reader's current one alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantSettings, AssistantSkill } from '@shared/assistant'
import { MAX_TURN_SCOPES, MAX_TURN_TOOLS } from '@shared/assistant'

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    assistant: {
      conversations: vi.fn(async () => ({ conversations: [] })),
      conversationFolders: vi.fn(async () => ({ folders: [], unfiled: 0 })),
      conversationTags: vi.fn(async () => ({ tags: [] })),
      saveSettings: vi.fn(async (body: Record<string, unknown>) => ({
        settings: { activeModelId: body.activeModelId ?? null },
      })),
    },
  },
}))

const skill = (over: Partial<AssistantSkill>): AssistantSkill => ({
  id: 'p1', title: '周报', content: '按项目分段。', group: '', icon: '',
  tools: [], scopes: [], modelId: null, createdAt: 1, updatedAt: 1,
  ...over,
})

async function freshStore() {
  vi.resetModules()
  const module = await import('./assistant-store')
  const api = await import('../../lib/api')
  return { useAssistant: module.useAssistant, assistant: api.api.assistant }
}

describe('applying a saved skill', () => {
  let useAssistant: Awaited<ReturnType<typeof freshStore>>['useAssistant']
  let assistant: Awaited<ReturnType<typeof freshStore>>['assistant']

  beforeEach(async () => {
    const built = await freshStore()
    useAssistant = built.useAssistant
    assistant = built.assistant
    useAssistant.setState({ turnTools: [], turnScopes: [], settings: null })
  })

  it('pins the tools and folders the skill names, in place of the turn’s own', () => {
    useAssistant.setState({ turnTools: ['list_tasks'], turnScopes: [{ kind: 'tag', id: 't1', name: '旧标签' }] })
    useAssistant.getState().applySkill(skill({
      tools: ['search_notes', 'count_notes'],
      scopes: [{ kind: 'folder', id: 'f1', name: '工作' }],
    }))
    expect(useAssistant.getState().turnTools).toEqual(['search_notes', 'count_notes'])
    expect(useAssistant.getState().turnScopes).toEqual([{ kind: 'folder', id: 'f1', name: '工作' }])
  })

  it('switches to the model the skill asks for, and not again when it already has it', async () => {
    useAssistant.setState({ settings: { activeModelId: 'm-a' } as unknown as AssistantSettings })
    useAssistant.getState().applySkill(skill({ modelId: 'm-b' }))
    await vi.waitFor(() => expect(assistant.saveSettings).toHaveBeenCalledWith({ activeModelId: 'm-b' }))
    expect(useAssistant.getState().settings?.activeModelId).toBe('m-b')

    vi.mocked(assistant.saveSettings).mockClear()
    // The same skill a second time, and one that names no model at all: neither is a reason to write.
    useAssistant.getState().applySkill(skill({ modelId: 'm-b' }))
    useAssistant.getState().applySkill(skill({}))
    expect(assistant.saveSettings).not.toHaveBeenCalled()
  })

  it('keeps a skill inside the ceilings one turn obeys', () => {
    const many = Array.from({ length: MAX_TURN_SCOPES + 4 }, (_, index) => ({
      kind: 'folder' as const, id: `f${index}`, name: `f${index}`,
    }))
    useAssistant.getState().applySkill(skill({
      tools: Array.from({ length: MAX_TURN_TOOLS + 3 }, (_, index) => `t${index}`),
      scopes: many,
    }))
    expect(useAssistant.getState().turnTools).toHaveLength(MAX_TURN_TOOLS)
    expect(useAssistant.getState().turnScopes).toHaveLength(MAX_TURN_SCOPES)
  })
})
