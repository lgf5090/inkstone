// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MEMO_PREFERENCES_DEFAULTS } from '@shared/memos/constants'
import type { MemoPreferences } from '@shared/memos/types'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { useMemoPreferences } from './use-memo-preferences'

const api = vi.hoisted(() => ({
  preferences: { get: vi.fn(), patch: vi.fn() },
}))

vi.mock('./api', () => ({ memosApi: api }))

function Probe() {
  const resource = useMemoPreferences()
  return createElement('output', {
    'data-status': resource.status,
    'data-reactions': resource.preferences.reactions.join(','),
    'data-default-visibility': resource.preferences.defaultVisibility,
    'data-preferences': JSON.stringify(resource.preferences),
  })
}

let rendered: RenderedElement | null = null

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  act(() => { rendered?.unmount() })
  rendered = null
  document.body.innerHTML = ''
})

describe('the memo preferences resource', () => {
  it('serves the loaded preferences', async () => {
    const loaded: MemoPreferences = {
      ...MEMO_PREFERENCES_DEFAULTS,
      defaultVisibility: 'public',
      reactions: ['🔥'],
    }
    api.preferences.get.mockResolvedValue(loaded)
    rendered = renderElement(createElement(Probe))
    await flush()
    const output = rendered.container.querySelector('output')!
    expect(output.dataset.status).toBe('ready')
    expect(output.dataset.defaultVisibility).toBe('public')
    expect(output.dataset.reactions).toBe('🔥')
  })

  it('falls back to the defaults when the request fails', async () => {
    api.preferences.get.mockRejectedValue(new Error('offline'))
    rendered = renderElement(createElement(Probe))
    await flush()
    const output = rendered.container.querySelector('output')!
    expect(output.dataset.status).toBe('error')
    expect(output.dataset.defaultVisibility).toBe(MEMO_PREFERENCES_DEFAULTS.defaultVisibility)
    expect(output.dataset.reactions).toBe(MEMO_PREFERENCES_DEFAULTS.reactions.join(','))
  })
})
