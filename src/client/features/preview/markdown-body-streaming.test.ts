// @vitest-environment jsdom
/**
 * The enhancement pass belongs to text that has stopped moving.
 *
 * A streamed answer repaints its markup on every batch. Code highlighting, line numbers, copy controls
 * and every other decoration the pass draws into that markup were rebuilt once per batch and thrown away
 * on the next one — and the cache of highlighted code could never hit, because a growing code block is a
 * new key every time. This pins the one behaviour that fixes it: nothing is enhanced while the text is
 * still arriving, and exactly one pass runs once it settles.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { MarkdownBody } from './MarkdownBody'

const passes = vi.hoisted(() => ({ enhance: 0 }))

vi.mock('../../lib/markdown/enhance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/markdown/enhance')>()
  return {
    ...actual,
    enhancePreview: async () => { passes.enhance += 1 },
    renderPendingMermaid: () => undefined,
    renderPendingCharts: () => undefined,
    destroyChartInstances: () => undefined,
  }
})

let root: Root
let container: HTMLDivElement

async function render(source: string) {
  await act(async () => { root.render(createElement(MarkdownBody, { source })) })
}

/** Longer than DEBOUNCE.render, so the settled value has caught up with the source. */
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 140)) })
}

beforeEach(async () => {
  passes.enhance = 0
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  installTestGlobals()
  await initI18n()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('a body whose text is still arriving', () => {
  it('enhances the settled text once, not once per batch', async () => {
    await render('first')
    await settle()
    expect(passes.enhance, 'the first, settled text was never decorated').toBe(1)

    await render('first second')
    await render('first second third')
    expect(passes.enhance, 'a live batch ran the whole enhancement pass').toBe(1)

    await settle()
    expect(passes.enhance, 'the settled text was never decorated after the stream stopped').toBe(2)
  })

  it('still enhances a document whose text never changed', async () => {
    await render('a whole stored reply')
    await settle()
    expect(passes.enhance).toBe(1)
  })
})
