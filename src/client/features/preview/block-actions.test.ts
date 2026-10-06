import { describe, expect, it, vi } from 'vitest'
import { renderMarkdown } from '../../lib/markdown/renderer'
import { closeBlockToolbarOverlay, enhanceBlockToolbars, handleBlockToolbarClick } from './block-actions'
import type { BlockActionContext } from './block-overlay'

const JS_FENCE = '~~~~javascript-example title="Sum"\nconsole.log(1 + 1);\n~~~~'

function surface(markdown: string): HTMLElement {
  const root = document.createElement('div')
  root.className = 'ink-prose'
  root.innerHTML = renderMarkdown(markdown).html
  enhanceBlockToolbars(root)
  return root
}

function ctx(over: Partial<BlockActionContext> = {}): BlockActionContext {
  return {
    content: JS_FENCE,
    sourceNoteId: 'n1',
    committedSourceRef: { current: JS_FENCE },
    api: { editContent: vi.fn(), toast: vi.fn() },
    ...over,
  }
}

describe('the preview block dispatch', () => {
  it('injects every family in one pass', () => {
    const root = surface(`${JS_FENCE}\n\n~~~md-example\nx\n~~~\n\n\`\`\`ts\nx\n\`\`\`\n`)
    expect(root.querySelectorAll('.block-tools').length).toBe(3)
    expect(root.querySelectorAll('.block-settings').length).toBe(0)
    expect(root.querySelectorAll('.js-example-controls').length).toBe(1)
  })

  it('routes a code fence edit to the note and not to the other handlers', () => {
    const root = surface('```ts\nx\n```')
    handleBlockToolbarClick({ preventDefault: vi.fn() }, root.querySelector<HTMLElement>('[data-code-action="toggle-settings"]')!, ctx())
    const context = ctx({ content: '```ts\nx\n```', committedSourceRef: { current: '```ts\nx\n```' } })
    const handled = handleBlockToolbarClick({ preventDefault: vi.fn() }, root.querySelector<HTMLElement>('[data-code-action="set-wrap"]')!, context)
    expect(handled).toBe(true)
    expect(context.api.editContent).toHaveBeenCalledWith('n1', '```ts wrap\nx\n```')
  })

  it('runs the fence the block was drawn from, not whatever the editor holds now', () => {
    const root = surface(JS_FENCE)
    const button = root.querySelector<HTMLElement>('[data-js-run]')!
    const context = ctx({
      content: '# typed above the fence\n\n' + JS_FENCE,
      committedSourceRef: { current: JS_FENCE },
    })
    handleBlockToolbarClick({ preventDefault: vi.fn() }, button, context)
    expect(context.api.toast).not.toHaveBeenCalled()
  })

  it('says so when the committed note no longer holds a runnable fence there', () => {
    const root = surface(JS_FENCE)
    const button = root.querySelector<HTMLElement>('[data-js-run]')!
    const context = ctx({ committedSourceRef: { current: '# only prose\n' } })
    handleBlockToolbarClick({ preventDefault: vi.fn() }, button, context)
    expect(context.api.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'preview.code_edit_unavailable' }))
  })

  it('lets an unrelated click fall through to the other preview handlers', () => {
    const root = surface(`${JS_FENCE}\n\n[a](#t)\n`)
    const link = root.querySelector<HTMLAnchorElement>('a[href="#t"]')!
    expect(handleBlockToolbarClick({ preventDefault: vi.fn() }, link, ctx())).toBe(false)
  })

  it('closes an open overlay on a click anywhere else in the surface', () => {
    const root = surface(JS_FENCE)
    const block = root.querySelector('.js-example-block')!
    handleBlockToolbarClick({ preventDefault: vi.fn() }, root.querySelector<HTMLElement>('[data-example-action="toggle-settings"]')!, ctx())
    expect(block.classList.contains('is-block-settings-open')).toBe(true)
    handleBlockToolbarClick({ preventDefault: vi.fn() }, root.querySelector<HTMLElement>('[data-js-run]')!, ctx())
    expect(block.classList.contains('is-block-settings-open')).toBe(false)
  })

  it('hands Escape back to the trigger that opened the overlay, and only then', () => {
    const root = surface(JS_FENCE)
    const trigger = root.querySelector<HTMLElement>('[data-example-action="toggle-settings"]')!
    handleBlockToolbarClick({ preventDefault: vi.fn() }, trigger, ctx())
    expect(closeBlockToolbarOverlay(trigger)?.dataset.exampleAction).toBe('toggle-settings')
    expect(closeBlockToolbarOverlay(root.querySelector('.js-example-title')!)).toBeNull()
  })
})
