import { describe, expect, it } from 'vitest'
import { extractMemoLinkUrls, parseMemoHttpUrl } from './link-urls'

describe('the memo link extractor', () => {
  it('collects bare http(s) links in order and drops duplicates', () => {
    const content = 'See https://a.test/x, then http://b.test/y and https://a.test/x#again again.'
    expect(extractMemoLinkUrls(content)).toEqual(['https://a.test/x', 'http://b.test/y'])
  })

  it('ignores fenced and inline code', () => {
    const content = [
      '```',
      'https://code.test/a',
      '```',
      '',
      '~~~md',
      'https://tilde.test/b',
      '~~~',
      '',
      '`https://inline.test/c`',
      '',
      'https://real.test/d',
    ].join('\n')
    expect(extractMemoLinkUrls(content)).toEqual(['https://real.test/d'])
  })

  it('ignores markdown destinations, images, autolinks and reference definitions', () => {
    const content = [
      '[docs](https://link.test/a)',
      '![cover](https://image.test/b.png)',
      '<https://auto.test/c>',
      '[ref]: https://ref.test/d',
      '<a href="https://html.test/e">tag</a>',
      'https://bare.test/f',
    ].join('\n')
    expect(extractMemoLinkUrls(content)).toEqual(['https://bare.test/f'])
  })

  it('keeps parentheses that belong to the URL and trims sentence punctuation', () => {
    expect(extractMemoLinkUrls('See (https://wiki.test/Foo_(bar)).')).toEqual(['https://wiki.test/Foo_(bar)'])
    expect(extractMemoLinkUrls('Read https://x.test/a?b=1, then https://x.test/c.')).toEqual([
      'https://x.test/a?b=1',
      'https://x.test/c',
    ])
    expect(extractMemoLinkUrls('**https://x.test/bold**')).toEqual(['https://x.test/bold'])
  })

  it('drops schemes that are not http or https', () => {
    expect(extractMemoLinkUrls('ftp://x.test/a javascript:alert(1) https://ok.test')).toEqual(['https://ok.test/'])
    expect(parseMemoHttpUrl('javascript:alert(1)')).toBeNull()
    expect(parseMemoHttpUrl('https://ok.test')?.hostname).toBe('ok.test')
  })

  it('drops credentials, which the server refuses to fetch', () => {
    expect(extractMemoLinkUrls('https://user:secret@private.test/page https://public.test/page')).toEqual([
      'https://public.test/page',
    ])
  })

  it('treats an unclosed fence as code to the end', () => {
    expect(extractMemoLinkUrls('```\nhttps://code.test/a\nhttps://after.test/b')).toEqual([])
  })

  it('caps the number of previews and honours a smaller limit', () => {
    const content = Array.from({ length: 12 }, (_, index) => `https://site${index}.test/page`).join(' ')
    expect(extractMemoLinkUrls(content)).toHaveLength(10)
    expect(extractMemoLinkUrls(content, 2)).toEqual([
      'https://site0.test/page',
      'https://site1.test/page',
    ])
    expect(extractMemoLinkUrls(content, 0)).toEqual([])
  })
})
