import { expect, it } from 'vitest'
import { countText, segmentCJK, toPlainText } from '@shared/markdown-utils'
import { utf8ByteLength } from '@shared/text-utils'
import { renderMarkdown } from '../src/client/lib/markdown/renderer'

// Reference implementations kept from before the fast paths landed: these lock P2-01 /
// P2-02 / P2-20 as behaviour-preserving. Code points are written numerically so ranges
// cannot drift, and range boundaries are sampled on purpose.
const CJK_CHAR = new RegExp('[\\u2e80-\\u9fff\\uf900-\\ufaff]')
const CJK_GLOBAL = new RegExp('[\\u2e80-\\u9fff\\uf900-\\ufaff\\uff01-\\uffe0]', 'g')

function segmentCJKReference(text: string): string {
  return text.replace(CJK_GLOBAL, (c) => ` ${c} `).replace(/\s{2,}/g, ' ')
}

function countTextReference(md: string): { words: number; chars: number } {
  const plain = toPlainText(md)
  let cjk = 0
  for (const ch of plain) if (CJK_CHAR.test(ch)) cjk++
  const latin = plain.match(/[A-Za-z0-9_'’-]+/g)?.length ?? 0
  return { words: cjk + latin, chars: [...md].length }
}

const at = (...codes: number[]) => String.fromCodePoint(...codes)

const TEXT_SAMPLES = [
  // CJK range boundaries: 2E80/9FFF and F900/FAFF are counted, neighbours are not.
  at(0x2dff, 0x2e80, 0x2e81),
  at(0x9ffe, 0x9fff, 0xa000),
  at(0xf8ff, 0xf900, 0xfaff, 0xfb00),
  at(0xff00, 0xff01, 0xffe0, 0xffe1),
  'mixed \u4e2d\u6587 and english \u5185\u5bb9 with words 1234',
  '# \u6807\u9898\n\n\u6b63\u6587 mixed with words 1234 and emoji \ud83d\ude00\ud83d\ude00',
  'plain english words only',
  at(0x10437, 0x10428) + ' astral code points count as one char each',
  'lone high surrogate \ud800 end',
  'lone low surrogate \udc00 end',
  '- [ ] \u4efb\u52a1\u9879 with 5 words',
  at(0xff1a, 0xff1a, 0xff06, 0xff06, 0xff1f, 0xff1f),
  '',
]

it('segmentCJK keeps the callback implementation output while using a string replacement', () => {
  for (const sample of TEXT_SAMPLES) {
    expect(segmentCJK(sample)).toBe(segmentCJKReference(sample))
  }
})

it('countText keeps the per-code-point word and char counts', () => {
  for (const sample of TEXT_SAMPLES) {
    expect(countText(sample)).toEqual(countTextReference(sample))
  }
})

it('utf8ByteLength matches TextEncoder for BMP, astral and lone surrogates', () => {
  const encoder = new TextEncoder()
  for (const sample of TEXT_SAMPLES.concat(['ascii', at(0xe9, 0x4e2d, 0x1f600), '\ud800\udc00', 'a\ud800b', 'a\udc00b'])) {
    expect(utf8ByteLength(sample)).toBe(encoder.encode(sample).byteLength)
  }
})

it('renderMarkdown strips Obsidian comments without leaking them or rewriting protected text', () => {
  const of = (source: string) => renderMarkdown(source).html

  // A multi-line comment body carries no marker on its own lines, so those lines must
  // still be blanked by the inComment branch rather than passed through.
  const multiline = of('before\n%%\nSECRET private text\n%%\nafter')
  expect(multiline).not.toContain('SECRET private text')
  expect(multiline).toContain('before')
  expect(multiline).toContain('after')

  expect(of('keep %%HIDDEN%% keep')).not.toContain('HIDDEN')
  const tilde = of('~~~\ncode %% not a comment %% here\n~~~\nreal %% gone %% text')
  expect(tilde).toContain('code %% not a comment %% here')
  expect(tilde).not.toContain('real %% gone')
  expect(of('a `code %% still code` b')).toContain('code %% still code')
  expect(of('keep \\%% literal %% HIDDEN end')).not.toContain('HIDDEN')
})
