import { describe, expect, it } from 'vitest'
import {
  SLIDE_CONTROL_SELECTORS,
  buildIncrementalSlidePlans,
  clearSlideHtmlCache,
  clearSlidePlanCache,
  dropSlideControls,
  markSlideFailed,
  readSlideHtml,
  readSlidePlan,
  rememberSlideHtml,
  rememberSlidePlan,
  releaseSlideCache,
  reserveSlideCache,
  slideCacheMetrics,
  slideSettingFlags,
  stagedFor,
  type SlideMarkup,
} from './slide-html'
import type { SlidePlan } from './slide-pagination'

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

  it('reads a class rule on the tag the selector named, not on every element wearing it', () => {
    const out = parse(dropSlideControls('<a class="heading-anchor">press</a><span class="heading-anchor">kept</span>'))
    expect(out.querySelectorAll('a.heading-anchor')).toHaveLength(0)
    expect(out.textContent).toContain('kept')
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

const planOf = (from: number): SlidePlan => ({ pages: [{ from, to: from + 1, top: 0 }], scales: [1] })
const markupOf = (html: string, flags?: string): SlideMarkup => ({ html, fences: {} as SlideMarkup['fences'], flags })

describe('reserveSlideCache', () => {
  it('keeps the first page of a deck longer than the floor', () => {
    clearSlideHtmlCache()
    reserveSlideCache(80)
    for (let index = 0; index < 80; index++) rememberSlideHtml(`k${index}`, markupOf(`<p>${index}</p>`))
    expect(readSlideHtml('k0')?.html).toBe('<p>0</p>')
    expect(readSlideHtml('k79')?.html).toBe('<p>79</p>')
  })

  it('does not shrink the floor for a short deck', () => {
    clearSlideHtmlCache()
    reserveSlideCache(5)
    for (let index = 0; index < 60; index++) rememberSlideHtml(`s${index}`, markupOf(`<p>${index}</p>`))
    expect(readSlideHtml('s0')?.html).toBe('<p>0</p>')
  })

  it('takes the ceiling back down for the next show', () => {
    clearSlideHtmlCache()
    reserveSlideCache(80)
    clearSlideHtmlCache()
    reserveSlideCache(5)
    for (let index = 0; index < 70; index++) rememberSlideHtml(`u${index}`, markupOf(`<p>${index}</p>`))
    expect(readSlideHtml('u0')).toBeUndefined()
    expect(readSlideHtml('u69')?.html).toBe('<p>69</p>')
  })
})

describe('buildIncrementalSlidePlans', () => {
  it('hands back the very object when no page moved', () => {
    clearSlidePlanCache()
    const first = planOf(0)
    rememberSlidePlan('a', first)
    const current = { 0: first }
    expect(buildIncrementalSlidePlans(['a'], current)).toBe(current)
  })

  it('re-keys the plans it holds onto the deck as it now stands', () => {
    clearSlidePlanCache()
    const first = planOf(0)
    const second = planOf(5)
    rememberSlidePlan('a', first)
    rememberSlidePlan('b', second)
    const out = buildIncrementalSlidePlans(['b', 'a'], { 0: first, 1: second })
    expect(out[0]).toBe(second)
    expect(out[1]).toBe(first)
  })

  it('says the deck changed when a page fell out', () => {
    clearSlidePlanCache()
    const first = planOf(0)
    const second = planOf(5)
    rememberSlidePlan('a', first)
    const current = { 0: first, 1: second }
    const out = buildIncrementalSlidePlans(['a'], current)
    expect(out).not.toBe(current)
    expect(out[1]).toBeUndefined()
  })
})

describe('markSlideFailed', () => {
  it('puts the news on the staged page every surface reads', () => {
    clearSlideHtmlCache()
    rememberSlideHtml('f1', markupOf('<p>x</p>'))
    markSlideFailed('f1', 'mdc')
    expect(readSlideHtml('f1')?.failed).toBe(true)
    expect(readSlideHtml('f1')?.flags).toBe('mdc')
  })

  it('says nothing about a page that was never staged', () => {
    clearSlideHtmlCache()
    expect(() => markSlideFailed('absent', 'mdc')).not.toThrow()
    expect(readSlideHtml('absent')).toBeUndefined()
  })
})

describe('what the page cache may hold', () => {
  const filler = (chars: number) => 'x'.repeat(chars)

  it('refuses to raise the ceiling past the cap for an enormous deck', () => {
    clearSlideHtmlCache()
    reserveSlideCache(5000)
    expect(slideCacheMetrics().limit).toBeLessThanOrEqual(600)
    for (let index = 0; index < 700; index++) rememberSlideHtml(`c${index}`, markupOf(`<p>${index}</p>`))
    expect(readSlideHtml('c0')).toBeUndefined()
    expect(readSlideHtml('c699')?.html).toBe('<p>699</p>')
  })

  it('gives pages back once the byte budget is spent, oldest first', () => {
    clearSlideHtmlCache()
    reserveSlideCache(600)
    for (let index = 0; index < 6; index++) rememberSlideHtml(`b${index}`, markupOf(filler(2_500_000)))
    const metrics = slideCacheMetrics()
    expect(metrics.bytes).toBeLessThanOrEqual(24 * 1024 * 1024)
    expect(metrics.pages).toBeLessThan(6)
    expect(readSlideHtml('b0')).toBeUndefined()
    expect(readSlideHtml('b5')?.html.length).toBe(2_500_000)
  })

  it('keeps the newest page when that page alone is over budget', () => {
    clearSlideHtmlCache()
    rememberSlideHtml('huge', markupOf(filler(13_000_000)))
    expect(slideCacheMetrics().pages).toBe(1)
  })

  it('counts a page once, however many times it was written back', () => {
    clearSlideHtmlCache()
    const page = markupOf(filler(1_000_000))
    rememberSlideHtml('k', page)
    const once = slideCacheMetrics().bytes
    rememberSlideHtml('k', page)
    rememberSlideHtml('k', page)
    expect(slideCacheMetrics().bytes).toBe(once)
  })

  it('gives the whole deck back on request, plans included', () => {
    clearSlideHtmlCache()
    reserveSlideCache(300)
    rememberSlideHtml('r1', markupOf('<p>1</p>'))
    rememberSlidePlan('r1', planOf(0))
    releaseSlideCache()
    expect(readSlideHtml('r1')).toBeUndefined()
    expect(readSlidePlan('r1')).toBeUndefined()
    expect(slideCacheMetrics()).toEqual({ pages: 0, bytes: 0, limit: 60 })
  })
})
