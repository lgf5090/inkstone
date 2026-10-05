import { describe, expect, it } from 'vitest'
import {
  deriveTitle,
  extractAttachmentIds,
  scanAttachmentReferences,
  toPlainText,
} from '../src/shared/markdown-utils'

const ID = 'a'.repeat(26)
const REF = `/api/files/${ID}`

/** One md-example fence costs 17 bytes; nesting requires a strictly longer outer fence. */
function nest(depth: number, leaf: string): string {
  let body = leaf
  for (let level = depth; level >= 1; level--) {
    const fence = '`'.repeat(2 + level)
    body = `${fence}md-example\n${body}\n${fence}\n`
  }
  return body
}

describe('scanAttachmentReferences work bound', () => {
  it('collects references from a singly nested md-example', () => {
    expect(extractAttachmentIds(nest(1, REF))).toEqual([ID])
    expect(scanAttachmentReferences(nest(1, REF)).truncated).toBe(false)
  })

  it('stops at the documented nesting depth instead of recursing without limit', () => {
    expect(scanAttachmentReferences(nest(3, REF))).toEqual({ ids: [ID], truncated: false })
    expect(scanAttachmentReferences(nest(9, REF)).truncated).toBe(true)
  })

  it('falls back to a flat pass so a capped scan never under-counts a reference', () => {
    // Pruning and backups delete or omit files on the strength of these ids, so an
    // unfinished descent must over-report rather than return a partial set.
    expect(scanAttachmentReferences(nest(9, REF))).toEqual({ ids: [ID], truncated: true })
    expect(extractAttachmentIds(nest(9, REF))).toEqual([ID])
    expect(extractAttachmentIds(nest(24, REF))).toEqual([ID])
  })

  it('leaves ordinary notes untruncated', () => {
    const note = `# Title\n\n${REF}\n\n\`\`\`md-example\n${REF}\n\`\`\`\n\nplain prose`
    expect(scanAttachmentReferences(note)).toEqual({ ids: [ID], truncated: false })
  })
})

// Expected values captured from the pre-rewrite implementation at fc61e80.
describe('toPlainText link stripping', () => {
  const cases: Array<[string, string]> = [
    [`see [label](${REF}) here`, 'see label here'],
    [`![alt](${REF})`, 'alt'],
    ['[empty]()', 'empty'],
    ['[](x)', ''],
    ['[no close](x', '[no close](x'],
    ['[t](', '[t]('],
    ['[a](b)(c)', 'a(c)'],
    ['[![nested](y)](x)', 'nested'],
    ['] [ orphan ] (x)', '] [ orphan ] (x)'],
    ['[hash](url#frag) and [q](url?x=1)', 'hash and q'],
    ['[unclosed', '[unclosed'],
    ['[a](b[c]d)', 'a'],
    ['[x](y[z)', 'x'],
    ['text ![img](one.png) more [lnk](two.png) end', 'text img more lnk end'],
    ['[![a](b)](c)', 'a'],
    ['![x]()[y](z)', 'xy'],
    ['a [b](c) [d](e) f', 'a b d f'],
    ['[\\]](u)', '[\\]](u)'],
    ['[a](b\\)c)', 'ac)'],
    ['[]()', ''],
    ['[[', '[['],
  ]

  it.each(cases)('reproduces the regex output for %j', (source, expected) => {
    expect(toPlainText(source)).toBe(expected)
  })

  it('keeps working for wiki links and images without targets', () => {
    expect(toPlainText('a [[Note|label]] b')).toBe('a label b')
    expect(toPlainText('![[embed]]')).toBe('embed')
  })

  it('stays linear on content that makes the regex pass backtrack per opening bracket', () => {
    // 160 KB cost the regex version ~8.7 s and the blowup scales with the square of
    // the length, so the 1.9 MB content cap extrapolates to ~20 min per call.
    const payload = '[t]('.repeat(40_000)
    const started = Date.now()
    expect(toPlainText(payload)).toBe(payload)
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it('keeps the same shape cheap for deriveTitle, which strips links per line', () => {
    expect(deriveTitle(`[t](${REF})`)).toBe('t')
    expect(deriveTitle(`# Heading\n\n[t](${REF})`)).toBe('Heading')
  })
})
