// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { activeVariables, collectVarNames, resolveVariable, tagPath } from '../src/client/features/development/api-tester/lib/variables'
import { normalizeState } from '../src/shared/development/api-tester/state'

describe('API Tester variable interpolation', () => {
  it('replaces environment values and keeps unknown placeholders', () => {
    const variables = [
      { key: 'baseUrl', value: 'https://example.com' },
      { key: 'token', value: 'abc' },
      { key: 'off', value: 'no', enabled: false },
    ]
    expect(resolveVariable('{{baseUrl}}/users?t={{ token }}&x={{missing}}&y={{off}}', variables)).toBe(
      'https://example.com/users?t=abc&x={{missing}}&y={{off}}',
    )
  })

  it('resolves dynamic variables and collects user-defined names only', () => {
    const value = resolveVariable('{{$guid}} {{$timestamp}} {{$randomInt}} {{$randomFloat}} {{name}}', [])
    expect(value).toMatch(/^[0-9a-f-]{36} \d+ \d+ [0-9.]+ \{\{name\}\}$/)
    expect(collectVarNames('{{a}} {{$guid}} {{ b }} {{a}}')).toEqual(['a', 'b'])
  })

  it('lets the active environment override globals and drops disabled entries', () => {
    const state = normalizeState(
      {
        globalVariables: [
          { id: 'g1', key: 'base', value: 'global', enabled: true },
          { id: 'g2', key: 'keep', value: 'yes', enabled: true },
          { id: 'g3', key: 'off', value: 'no', enabled: false },
        ],
        environments: [
          { id: 'e1', name: 'Prod', variables: [{ id: 'e2', key: 'base', value: 'env', enabled: true }] },
        ],
        activeEnvId: 'e1',
      },
      'ws',
    )
    expect(activeVariables(state).map(({ key, value, enabled }) => ({ key, value, enabled }))).toEqual([
      { key: 'keep', value: 'yes', enabled: true },
      { key: 'base', value: 'env', enabled: true },
    ])
  })

  it('renders a tag path without looping on a malformed parent chain', () => {
    const tags = normalizeState(
      {
        tags: [
          { id: 'a', name: 'A', parentId: 'b' },
          { id: 'b', name: 'B', parentId: 'a' },
        ],
      },
      'ws',
    ).tags
    expect(tagPath(tags, 'a')).toBe('B / A')
  })
})
