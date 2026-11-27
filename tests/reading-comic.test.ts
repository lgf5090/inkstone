// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { orderComicPages } from '../src/client/features/reading/engine/comic'

describe('orderComicPages', () => {
  it('sorts page names numerically', () => {
    expect(orderComicPages(['10.jpg', '2.jpg', '1.jpg'], null).paths).toEqual(['1.jpg', '2.jpg', '10.jpg'])
  })

  it('reverses right-to-left comics from ComicInfo', () => {
    expect(orderComicPages(['1.jpg', '2.jpg'], '<ComicInfo><ReadingOrder>RightToLeft</ReadingOrder></ComicInfo>'))
      .toEqual({ paths: ['2.jpg', '1.jpg'], rtl: true })
  })
})
