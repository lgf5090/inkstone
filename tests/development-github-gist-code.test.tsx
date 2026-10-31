// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { GistCode } from '../src/client/features/development/github/components/GistCode'
import { renderElement } from '../src/client/lib/test-render'

describe('Gist code highlighting', () => {
  it('loads the requested language and renders tokens', async () => {
    const view = renderElement(<GistCode content="const answer: number = 42" language="ts" />)
    await vi.waitFor(() => {
      const code = view.container.querySelector('code')
      expect(code?.querySelector('.token.keyword')).not.toBeNull()
    }, { timeout: 5000 })
    expect(view.container.textContent).toContain('const answer')
    view.unmount()
  })
})
