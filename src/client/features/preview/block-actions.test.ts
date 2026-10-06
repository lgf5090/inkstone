import { describe, expect, it, vi } from 'vitest'
import { renderMarkdown } from '../../lib/markdown/renderer'
import { closeBlockToolbarOverlay, enhanceBlockToolbars, handleBlockToolbarClick } from './block-actions'
import type { BlockActionContext } from './block-overlay'

const JS_FENCE = '~~~~javascript-example title="Sum"\nconsole.log(1 + 1);\n~~~~'

function surface(markdown: string, chart = true): HTMLElement {
  const root = document.createElement('div')
  root.className = 'ink-prose'
  root.innerHTML = renderMarkdown(markdown).html
  enhanceBlockToolbars(root, { chart })
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

  it('closes an overlay when its own trigger is pressed a second time', () => {
    const root = surface(JS_FENCE)
    const block = root.querySelector('.js-example-block')!
    const trigger = root.querySelector<HTMLElement>('[data-example-action="toggle-settings"]')!
    handleBlockToolbarClick({ preventDefault: vi.fn() }, trigger, ctx())
    expect(block.classList.contains('is-block-settings-open')).toBe(true)
    handleBlockToolbarClick({ preventDefault: vi.fn() }, trigger, ctx())
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

const CHART_NOTE = '```chart\n{"type":"bar","data":{"labels":["Jan","Feb"],"datasets":[{"label":"Shop A","data":[12,19]}]}}\n```\n'
const CHART_SURFACE = `# Tally\n\n${CHART_NOTE}`

const toggleIn = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-chart-action="toggle-source"]')!
const wrapIn = (root: HTMLElement) => root.querySelector<HTMLElement>('.chart-block-wrap')!

describe('a chart block reached through the registry', () => {
  function chartCtx(over: Partial<BlockActionContext> = {}) {
    return ctx({ content: CHART_SURFACE, committedSourceRef: { current: CHART_SURFACE }, ...over })
  }

  it('gets its head from the same pass, and loses the drawn-only tools when charts are off', () => {
    expect(surface(CHART_SURFACE).querySelectorAll('[data-chart-action]')).toHaveLength(3)
    const off = surface(CHART_SURFACE, false)
    expect(off.querySelectorAll('[data-chart-action]')).toHaveLength(1)
    expect(off.querySelector('[data-chart-source]')).toBeNull()
  })

  it('writes the other format to the note through the registry', () => {
    const root = surface(CHART_SURFACE)
    const context = chartCtx()
    handleBlockToolbarClick({ preventDefault: vi.fn() }, root.querySelector<HTMLElement>('[data-chart-action="convert-format"]')!, context)
    expect(context.api.editContent).toHaveBeenCalledWith('n1', expect.stringContaining('| :bar: | Jan | Feb |\n| --- | --- | --- |\n| Shop A | 12 | 19 |'))
    expect(context.api.toast).not.toHaveBeenCalled()
  })

  it('will not convert the format while the preview is behind the note', () => {
    const root = surface(CHART_SURFACE)
    const context = chartCtx({ content: `${CHART_SURFACE}# typed\n` })
    handleBlockToolbarClick({ preventDefault: vi.fn() }, root.querySelector<HTMLElement>('[data-chart-action="convert-format"]')!, context)
    expect(context.api.editContent).not.toHaveBeenCalled()
    expect(context.api.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'preview.the_preview_is_updating_try_again_in_a_moment' }))
  })

  it('opens the source panel while the preview is behind the note, since nothing is written', () => {
    const root = surface(CHART_SURFACE)
    const context = chartCtx({ content: `${CHART_SURFACE}# typed\n` })
    expect(handleBlockToolbarClick({ preventDefault: vi.fn() }, toggleIn(root), context)).toBe(true)
    expect(wrapIn(root).classList.contains('is-block-source-open')).toBe(true)
    expect(root.querySelector('[data-chart-source]')!.hasAttribute('hidden')).toBe(false)
    expect(context.api.toast).not.toHaveBeenCalled()
  })

  it('closes the panel on a second press of its own trigger, and on a click elsewhere', () => {
    const root = surface(CHART_SURFACE)
    const context = chartCtx()
    handleBlockToolbarClick({ preventDefault: vi.fn() }, toggleIn(root), context)
    expect(wrapIn(root).classList.contains('is-block-source-open')).toBe(true)
    handleBlockToolbarClick({ preventDefault: vi.fn() }, toggleIn(root), context)
    expect(wrapIn(root).classList.contains('is-block-source-open')).toBe(false)
    handleBlockToolbarClick({ preventDefault: vi.fn() }, toggleIn(root), context)
    handleBlockToolbarClick({ preventDefault: vi.fn() }, root.querySelector('h1')!, context)
    expect(wrapIn(root).classList.contains('is-block-source-open')).toBe(false)
  })

  it('hands Escape back to the chart trigger, and only while its panel is open', () => {
    const root = surface(CHART_SURFACE)
    const toggle = toggleIn(root)
    handleBlockToolbarClick({ preventDefault: vi.fn() }, toggle, chartCtx())
    expect(closeBlockToolbarOverlay(toggle)?.dataset.chartAction).toBe('toggle-source')
    expect(wrapIn(root).classList.contains('is-block-source-open')).toBe(false)
    expect(closeBlockToolbarOverlay(root.querySelector('.chart-block-title')!)).toBeNull()
  })
})
