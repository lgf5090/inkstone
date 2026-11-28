import { describe, expect, it } from 'vitest'
import { squeezePunctuation } from '../src/client/features/reading/engine/punctuation'
import { buildTextIndex } from '../src/client/features/reading/engine/text-index'

describe('Chinese punctuation spacing', () => {
  it('squeezes marks without changing the text index', () => {
    const root = document.createElement('div')
    root.textContent = '\u7532\uff0c\u4e59\uff08\u4e19\uff09\u3002'
    const before = buildTextIndex(root).text
    squeezePunctuation(root, true)
    expect(root.textContent).toBe(before)
    expect(buildTextIndex(root).text).toBe(before)
    expect([...root.querySelectorAll<HTMLElement>('.reader-punctuation')].map((node) => node.dataset.side)).toEqual(['after', 'before', 'after'])
  })

  it('leaves the chapter untouched when the setting is off', () => {
    const root = document.createElement('div')
    root.textContent = '\u7532\uff0c\u4e59'
    squeezePunctuation(root, false)
    expect(root.querySelectorAll('.reader-punctuation')).toHaveLength(0)
  })
})
