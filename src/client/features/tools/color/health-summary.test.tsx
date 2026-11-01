// @vitest-environment jsdom
/**
 * The findings have to be readable, not just computed.
 *
 * A scheme that blurs together for a green-blind reader is a fact about the palette the tool already knew
 * how to measure and never said — this is the line that says it, and the list behind it that names the pair.
 */
import { act, createElement } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { initI18n, t } from '../../../lib/i18n'
import { PaletteHealthSummary } from './components/PaletteHealthSummary'

let rendered: RenderedElement | null = null

function summaryText(): string {
  return document.querySelector('summary')?.textContent ?? ''
}

function open(): string {
  const details = document.querySelector('details')!
  act(() => {
    details.querySelector('summary')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  act(() => {
    details.open = true
  })
  return details.textContent ?? ''
}

beforeEach(async () => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
  await initI18n()
})

describe('the health line', () => {
  it('says nothing for a single colour', () => {
    rendered = renderElement(createElement(PaletteHealthSummary, { colors: ['#123456'] }))
    expect(document.body.textContent).toBe('')
  })

  it('reports the blurred pair and names both swatches when opened', () => {
    rendered = renderElement(
      createElement(PaletteHealthSummary, { colors: ['#a8a832', '#b45a3c', '#ffffff'] }),
    )

    const deficiency = t('tools.color.blindness.type.deuteranopia')
    expect(summaryText()).toContain(t('tools.color.health.confused', { count: 1, deficiency }))
    // Named inside the disclosure, not in the one-line verdict: the summary stays readable on a phone.
    expect(summaryText()).not.toContain('#a8a832')
    const details = open()
    expect(details).toContain('#a8a832')
    expect(details).toContain('#b45a3c')
  })

  it('reassures when the scheme survives the simulation', () => {
    rendered = renderElement(createElement(PaletteHealthSummary, { colors: ['#000000', '#ffffff'] }))

    const deficiency = t('tools.color.blindness.type.deuteranopia')
    expect(summaryText()).toContain(t('tools.color.health.distinct', { deficiency }))
    expect(summaryText()).not.toContain(t('tools.color.health.confused', { count: 1, deficiency }))
    // One readable pairing: white on black.
    expect(summaryText()).toContain(t('tools.color.health.readable', { count: 1 }))
  })

  it('adds the text warning only for a swatch that fails with both blacks and whites', () => {
    rendered = renderElement(createElement(PaletteHealthSummary, { colors: ['#000000', '#808080'] }))

    expect(summaryText()).toContain(t('tools.color.health.textless', { count: 1 }))
    expect(open()).toContain('#808080')
  })
})
