// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { RawViewer } from '../src/client/features/development/api-tester/components/RawViewer'
import { initI18n } from '../src/client/lib/i18n'
import { renderElement, type RenderedElement } from '../src/client/lib/test-render'

const views: RenderedElement[] = []

afterEach(() => {
  for (const view of views.splice(0)) view.unmount()
})

beforeAll(async () => {
  await initI18n()
})

function body(lines: number, matchLine?: number): string {
  return Array.from({ length: lines }, (_, index) => (index === matchLine ? 'needle here' : `line ${index}`)).join('\n')
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('no HTMLInputElement value setter')
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('API Tester raw viewer windowing', () => {
  it('draws only a window of a huge body', () => {
    const view = renderElement(<RawViewer text={body(5000)} />)
    views.push(view)

    const scroller = view.container.querySelector('[data-line-count="5000"]')
    expect(scroller).not.toBeNull()
    const rows = view.container.querySelectorAll('.h-5')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(200)
  })

  it('finds a match thousands of lines away and renders the row it scrolled to', () => {
    const view = renderElement(<RawViewer text={body(5000, 4000)} />)
    views.push(view)

    const input = view.container.querySelector<HTMLInputElement>('input')
    if (!input) throw new Error('raw search input is missing')
    setInput(input, 'needle')

    expect(view.container.textContent).toContain('1/1')
    expect(view.container.textContent).toContain('needle here')
    expect(view.container.querySelectorAll('mark')).toHaveLength(1)
    expect(view.container.querySelectorAll('.h-5').length).toBeLessThan(200)
  })

  it('says so when the match list is capped instead of collecting millions', () => {
    const many = Array.from({ length: 400 }, () => 'x'.repeat(60)).join('\n')
    const view = renderElement(<RawViewer text={many} />)
    views.push(view)

    const input = view.container.querySelector<HTMLInputElement>('input')
    if (!input) throw new Error('raw search input is missing')
    setInput(input, 'x')

    expect(view.container.textContent).toContain('1/10000+')
  })
})
