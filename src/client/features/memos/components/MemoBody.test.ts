// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { MemoBody } from './MemoBody'

const FILE_URL = '/api/memos/files/01m5ggtqz1y8qkxhggffy2arnm'
const REMOTE_FILE_URL = 'https://cdn.example.com/api/memos/files/01m5ggtqz1y8qkxhggffy2arnm'

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

  it('never sends a share token to another origin', () => {
    view = renderElement(createElement(MemoBody, {
      content: `![coast](${REMOTE_FILE_URL})\n\n[download](${REMOTE_FILE_URL})`,
      shareToken: 'share-token',
    }))
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe(REMOTE_FILE_URL)
    expect(view.container.querySelector('a')?.getAttribute('href')).toBe(REMOTE_FILE_URL)
  })

  it('marks every occurrence of a search word outside code, links and existing marks', () => {
    view = renderElement(createElement(MemoBody, {
      content: [
        'Hello **hello** world',
        '',
        '`hello`',
        '',
        '[hello](https://example.com)',
        '',
        '==hello==',
        '',
        '<span title="hello">plain</span>',
      ].join('\n'),
      highlight: ['hello', 'wor'],
    }))
    const marks = [...view.container.querySelectorAll<HTMLElement>('mark[data-memo-hit]')]
    expect(marks.map((mark) => mark.textContent)).toEqual(['Hello', 'hello', 'wor'])
    const span = view.container.querySelector('span[title="hello"]')
    expect(span?.getAttribute('title')).toBe('hello')
    expect(span?.querySelector('mark')).toBeNull()
  })

  it('escapes search words before building the highlight pattern', () => {
    view = renderElement(createElement(MemoBody, {
      content: 'a.b ab',
      highlight: ['a.b'],
    }))
    const marks = [...view.container.querySelectorAll('mark[data-memo-hit]')]
    expect(marks.map((mark) => mark.textContent)).toEqual(['a.b'])
  })

  it('makes inline tags plain text when no tag handler is attached', () => {
    view = renderElement(createElement(MemoBody, { content: 'tagged #work' }))
    const tag = view.container.querySelector<HTMLElement>('[data-tag]')
    expect(tag).not.toBeNull()
    expect(tag?.hasAttribute('role')).toBe(false)
    expect(tag?.hasAttribute('tabindex')).toBe(false)
    expect(tag?.hasAttribute('draggable')).toBe(false)
  })

  it('keeps tags focusable and answers Enter when the surface handles them', () => {
    const pressed: string[] = []
    view = renderElement(createElement(MemoBody, {
      content: 'tagged #work',
      onTagPress: (tag: string) => pressed.push(tag),
    }))
    const tag = view.container.querySelector<HTMLElement>('[data-tag]')
    expect(tag?.getAttribute('role')).toBe('link')
    expect(tag?.getAttribute('tabindex')).toBe('0')
    act(() => {
      tag!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    act(() => {
      tag!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
    })
    expect(pressed).toEqual(['work', 'work'])
  })
})
