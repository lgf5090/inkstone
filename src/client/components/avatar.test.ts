// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { Avatar } from './primitives'
import { renderElement } from '../lib/test-render'

describe('the avatar', () => {
  it('draws an emoji preference as its glyph', () => {
    const view = renderElement(createElement(Avatar, { src: 'emoji:😀', name: 'Ada', size: 32 }))
    expect(document.body.textContent).toContain('😀')
    view.unmount()
  })

  it('draws a lucide preference as an icon, not a letter', () => {
    const view = renderElement(createElement(Avatar, { src: 'lucide:cat', name: 'Ada', size: 32 }))
    expect(document.querySelector('span[style] svg')).not.toBeNull()
    expect(document.body.textContent).not.toContain('A')
    view.unmount()
  })
})
