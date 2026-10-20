// @vitest-environment jsdom
/**
 * What one row's mark renders as.
 *
 * A brand is an image, an emoji is text, a Lucide name is a glyph, and an upload is an image with the
 * reader's own bytes. The fallback is the neutral bot, never a blank tile: a row with no vendor known
 * should still say so rather than look broken.
 */
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { renderElement } from '../../lib/test-render'
import { AssistantIcon } from './AssistantIcon'

describe('the assistant icon', () => {
  it('draws a known brand from its SVG asset', () => {
    const rendered = renderElement(createElement(AssistantIcon, { value: 'brand:deepseek' }))
    const image = rendered.container.querySelector('img')
    expect(image?.getAttribute('src')?.toLowerCase()).toContain('deepseek')
    rendered.unmount()
  })

  it('draws a brand with no SVG as its monogram', () => {
    const rendered = renderElement(createElement(AssistantIcon, { value: 'brand:modelbest' }))
    expect(rendered.container.textContent).toContain('MB')
    rendered.unmount()
  })

  it('draws an emoji, a Lucide glyph and an uploaded image', () => {
    const emoji = renderElement(createElement(AssistantIcon, { value: 'emoji:🐋' }))
    expect(emoji.container.textContent).toContain('🐋')
    emoji.unmount()

    const lucide = renderElement(createElement(AssistantIcon, { value: 'lucide:Brain' }))
    expect(lucide.container.querySelector('svg')).toBeTruthy()
    lucide.unmount()

    const png = 'data:image/png;base64,iVBORw0KGgo='
    const upload = renderElement(createElement(AssistantIcon, { value: png }))
    expect(upload.container.querySelector('img')?.getAttribute('src')).toBe(png)
    upload.unmount()
  })

  it('uses the fallback when the stored value is empty, and a bot when there is none', () => {
    const fallback = renderElement(createElement(AssistantIcon, { value: '', fallback: 'brand:qwen' }))
    expect(fallback.container.querySelector('img')?.getAttribute('src')?.toLowerCase()).toContain('qwen')
    fallback.unmount()

    const none = renderElement(createElement(AssistantIcon, { value: '' }))
    expect(none.container.querySelector('svg')).toBeTruthy()
    none.unmount()
  })
})
