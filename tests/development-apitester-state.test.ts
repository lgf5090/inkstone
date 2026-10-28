// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { defaultRequest, defaultSettings, normalizeState, stateDataOf } from '../src/shared/development/api-tester/state'
import { MAX_NODES, MAX_TAGS } from '../src/shared/development/api-tester/limits'

describe('API tester state normalization', () => {
  it('fills defaults for a missing state', () => {
    const state = normalizeState(null, 'workspace')
    expect(state.workspaceId).toBe('workspace')
    expect(state.nodes).toEqual([])
    expect(state.settings).toEqual(defaultSettings())
    expect(state.activeEnvId).toBeNull()
  })

  it('keeps known fields and clamps arrays', () => {
    const nodes = Array.from({ length: MAX_NODES + 10 }, (_, index) => ({
      id: `node-${index}`,
      type: 'request' as const,
      name: `Request ${index}`,
      tags: ['tag'],
    }))
    const tags = Array.from({ length: MAX_TAGS + 10 }, (_, index) => ({
      id: `tag-${index}`,
      name: `Tag ${index}`,
      parentId: null,
      color: 'blue',
      sortOrder: index,
      createdAt: 1,
    }))
    const state = normalizeState({ nodes, tags, settings: { timeoutMs: 999_999, splitDirection: 'horizontal' } }, 'ws')
    expect(state.nodes.length).toBe(MAX_NODES)
    expect(state.tags.length).toBe(MAX_TAGS)
    expect(state.settings.timeoutMs).toBe(120_000)
    expect(state.settings.splitDirection).toBe('horizontal')
    expect(state.nodes[0]?.tags).toEqual([])
  })

  it('drops dangling tag references and invalid active environments', () => {
    const state = normalizeState(
      {
        nodes: [{ id: 'n1', type: 'request', name: 'A', tags: ['missing', 't1'] }],
        tags: [{ id: 't1', name: 'One' }],
        environments: [{ id: 'e1', name: 'Env', variables: [{ id: 'v1', key: 'a', value: 'b' }] }],
        activeEnvId: 'missing',
      },
      'ws',
    )
    expect(state.nodes[0]?.tags).toEqual(['t1'])
    expect(state.activeEnvId).toBeNull()
    expect(state.environments[0]?.variables[0]?.enabled).toBe(true)
  })

  it('strips history from the persisted state payload', () => {
    const state = normalizeState({ history: [{ id: 'h1' }] }, 'ws')
    const data = stateDataOf(state)
    expect('history' in data).toBe(false)
    expect(defaultRequest().headers[0]?.key).toBe('Content-Type')
  })
})
