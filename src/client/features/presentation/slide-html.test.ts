import { describe, expect, it } from 'vitest'
import { SLIDE_CONTROL_SELECTORS, dropSlideControls, slideSettingFlags, stagedFor, type SlideMarkup } from './slide-html'

const parse = (html: string) => {
  const host = document.createElement('div')
  host.innerHTML = html
  return host
}

const controlMarkup = () => SLIDE_CONTROL_SELECTORS.map((selector) => {
  const anchor = /^a\.([\w-]+)$/.exec(selector)
  if (anchor) return `<a class="${anchor[1]}">anchor</a>`
  const attribute = /^\[([\w:-]+)\]$/.exec(selector)
  if (!attribute) throw new Error(`unhandled control selector: ${selector}`)
  return `<button type="button" ${attribute[1]}="1">press</button>`
}).join('\n')

describe('dropSlideControls', () => {
  it('takes out every control family the list names', () => {
    const out = parse(dropSlideControls(`<section>kept<div>${controlMarkup()}</div></section>`))
    expect(out.textContent).toContain('kept')
    expect(out.textContent).not.toContain('press')
    for (const selector of SLIDE_CONTROL_SELECTORS) {
      expect(out.querySelectorAll(selector), selector).toHaveLength(0)
    }
  })

  it('reaches a control buried inside its block', () => {
    const out = parse(dropSlideControls('<div data-chart="{}"><div class="wrap"><span><button type="button" data-chart-action="copy">press</button></span></div></div>'))
    expect(out.querySelector('[data-chart]')).not.toBeNull()
    expect(out.querySelectorAll('[data-chart-action]')).toHaveLength(0)
  })

  it('leaves the block a control was attached to', () => {
    const out = parse(dropSlideControls('<div class="ink-code"><button type="button" data-code-action="format">press</button><pre><code>let a = 1</code></pre></div>'))
    expect(out.querySelector('pre code')?.textContent).toBe('let a = 1')
  })

  it('keeps a task line checked state on the page and out of the hit test', () => {
    const out = parse(dropSlideControls('<ul><li><input type="checkbox" data-task-line="3" name="task-3" checked> done</li></ul>'))
    const box = out.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(box).not.toBeNull()
    expect(box?.checked).toBe(true)
    expect(box?.hasAttribute('data-task-line')).toBe(false)
    expect(box?.hasAttribute('name')).toBe(false)
    expect(box?.tabIndex).toBe(-1)
    expect(box?.style.pointerEvents).toBe('none')
  })

  it('does not truncate a code block behind an expander that is no longer there', () => {
    const out = parse(dropSlideControls('<pre data-code-collapse-at="12"><code>line</code></pre>'))
    const block = out.querySelector('pre')
    expect(block?.hasAttribute('data-code-collapse-at')).toBe(false)
    expect(block?.textContent).toBe('line')
  })

  it('leaves a placeholder and its fence body key alone', () => {
    const html = '<div data-mindmap="1" data-body-key="board-a">waiting</div>'
    expect(dropSlideControls(html)).toContain('data-body-key="board-a"')
    expect(dropSlideControls(html)).toContain('waiting')
  })
})

describe('stagedFor', () => {
  const entry = (flags?: string): SlideMarkup => ({ html: '<p>x</p>', fences: {} as SlideMarkup['fences'], flags })

  it('accepts a page prepared under the settings being asked for', () => {
    expect(stagedFor(entry('mdc'), 'mdc')?.flags).toBe('mdc')
  })

  it('refuses a page prepared under other settings', () => {
    expect(stagedFor(entry('m-c'), 'mdc')).toBeUndefined()
  })

  it('leaves a plain render for its reader to overwrite', () => {
    expect(stagedFor(entry(), 'mdc')?.flags).toBeUndefined()
  })

  it('has nothing to hand over when nothing is staged', () => {
    expect(stagedFor(undefined, 'mdc')).toBeUndefined()
  })
})

describe('slideSettingFlags', () => {
  it('names the three switches that reach the enhancement chain', () => {
    expect(slideSettingFlags({ math: true, mermaid: true, chart: true })).toBe('mdc')
    expect(slideSettingFlags({ math: false, mermaid: false, chart: false })).toBe('---')
    expect(slideSettingFlags({ math: true, mermaid: false, chart: true })).toBe('m-c')
  })

  it('tells two settings apart that draw different pages', () => {
    expect(slideSettingFlags({ math: true, mermaid: true, chart: false })).not.toBe(slideSettingFlags({ math: true, mermaid: false, chart: false }))
  })
})
