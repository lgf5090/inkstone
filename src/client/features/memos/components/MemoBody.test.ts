// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { MemoBody } from './MemoBody'

const FILE_URL = '/api/memos/files/01m5ggtqz1y8qkxhggffy2arnm'

let view: RenderedElement | null = null

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
})

describe('the memo body', () => {
  it('carries a share token onto managed images and links in the text', () => {
    view = renderElement(createElement(MemoBody, {
      content: `![coast](${FILE_URL})\n\n[download](${FILE_URL}?download=1)`,
      shareToken: 'share-token',
    }))
    const image = view.container.querySelector('img')
    const link = view.container.querySelector('a[href*="download"]')
    expect(image?.getAttribute('src')).toBe(`${FILE_URL}?share=share-token`)
    expect(link?.getAttribute('href')).toBe(`${FILE_URL}?download=1&share=share-token`)
  })

  it('leaves managed urls alone on an ordinary surface', () => {
    view = renderElement(createElement(MemoBody, {
      content: `![coast](${FILE_URL})`,
    }))
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe(FILE_URL)
  })
})
