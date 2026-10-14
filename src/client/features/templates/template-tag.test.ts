import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { renderElement } from '../../lib/test-render'
import { TemplateTag } from './template-tag'

describe('a template tag', () => {
  it('draws the tag with the hash kept out of its name', () => {
    const { container, unmount } = renderElement(createElement(TemplateTag, { tag: 'sprint' }))
    const pill = container.querySelector('span')!
    expect(pill.textContent).toBe('#sprint')
    expect(pill.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
    unmount()
  })

  it('takes its shape from the spacing and type tokens, not from literals', () => {
    const { container, unmount } = renderElement(createElement(TemplateTag, { tag: 'sprint' }))
    const pill = container.querySelector('span')!
    expect(pill.className).toContain('px-[var(--sp-1-5)]')
    expect(pill.className).toContain('text-[length:var(--text-10)]')
    expect(pill.className).toContain('rounded-[var(--r-full)]')
    unmount()
  })
})
