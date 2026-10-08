import { describe, expect, it } from 'vitest'
import {
  escapeIntoScalar,
  frontMatterRange,
  quotedScalarAt,
  unquoteTypedScalars,
} from './yaml-quotes'

describe('the properties a formatted token can land inside', () => {
  it('measures the block between the fences', () => {
    const text = '---\ntitle: x\n---\nbody\n'
    const range = frontMatterRange(text)
    expect(range).not.toBeNull()
    expect(text.slice(range!.start, range!.end)).toBe('title: x\n')
    expect(frontMatterRange('no fences here')).toBeNull()
    expect(frontMatterRange('---\nnever closed')).toBeNull()
  })

  it('finds the quoted scalar a token sits inside, and whether it is the whole value', () => {
    const text = '---\ntitle: "{{VALUE}}"\nauthor: J. R.\n---\n'
    const start = text.indexOf('{{VALUE}}')
    const end = start + '{{VALUE}}'.length
    expect(quotedScalarAt(text, start, end)).toEqual({ quote: '"', wholeScalar: true })
    const padded = '---\ntitle: "x {{VALUE}} y"\n---\n'
    const at = padded.indexOf('{{VALUE}}')
    expect(quotedScalarAt(padded, at, at + 9)).toEqual({ quote: '"', wholeScalar: false })
    const outside = '---\ntitle: x\n---\nSay "{{VALUE}}"\n'
    const out = outside.indexOf('{{VALUE}}')
    expect(quotedScalarAt(outside, out, out + 9), 'the body is not a property').toBeNull()
  })

  it('reads the quote style a single-quoted scalar uses', () => {
    const text = "---\nauthor: '{{VALUE:who}}'\n---\n"
    const start = text.indexOf('{{VALUE:who}}')
    expect(quotedScalarAt(text, start, start + 13)).toEqual({ quote: "'", wholeScalar: true })
  })

  it('leaves a token that only looks adjacent to a scalar alone', () => {
    const text = '---\ncount: {{VALUE:n}}\n---\n'
    const start = text.indexOf('{{VALUE:n}}')
    expect(quotedScalarAt(text, start, start + 11)).toBeNull()
    const comment = '---\ntitle: "{{VALUE}}" # note\n---\n'
    const at = comment.indexOf('{{VALUE}}')
    expect(quotedScalarAt(comment, at, at + 9)).toEqual({ quote: '"', wholeScalar: true })
  })
})

describe('writing a value into a quoted scalar', () => {
  it('escapes what a double-quoted scalar cannot hold raw', () => {
    expect(escapeIntoScalar('Say "hi"', '"').text).toBe('Say \\"hi\\"')
    expect(escapeIntoScalar('C:\\path', '"').text).toBe('C:\\\\path')
    expect(escapeIntoScalar('a\nb', '"')).toEqual({ text: 'a\\nb', folded: false })
  })

  it('doubles the quote a single-quoted scalar cannot hold, and folds a line break', () => {
    expect(escapeIntoScalar("O'Brien", "'").text).toBe("O''Brien")
    const folded = escapeIntoScalar('a\nb', "'")
    expect(folded).toEqual({ text: 'a b', folded: true })
  })
})

describe('taking the quotes off a scalar that means a number or a flag', () => {
  it('unquotes only a whole-scalar token that declares a numeric or checkbox type', () => {
    expect(unquoteTypedScalars('---\nrating: "{{VALUE:num|type:number}}"\n---\n'))
      .toBe('---\nrating: {{VALUE:num|type:number}}\n---\n')
    expect(unquoteTypedScalars('---\ndone: "{{VALUE:d|type:checkbox}}"\n---\n'))
      .toBe('---\ndone: {{VALUE:d|type:checkbox}}\n---\n')
    expect(unquoteTypedScalars('---\nid: "{{VALUE:id|type:text}}"\n---\n'))
      .toBe('---\nid: "{{VALUE:id|type:text}}"\n---\n')
    expect(unquoteTypedScalars('---\ntitle: "x {{VALUE}}"\n---\n'))
      .toBe('---\ntitle: "x {{VALUE}}"\n---\n')
  })

  it('keeps every other byte of the note, including the body and the line endings', () => {
    const text = '---\r\ntitle: "{{VALUE:t}}"\r\nrating: "{{VALUE:n|type:number}}"\r\n---\r\nSaid "{{VALUE:n|type:number}}" today\r\n'
    expect(unquoteTypedScalars(text)).toBe(
      '---\r\ntitle: "{{VALUE:t}}"\r\nrating: {{VALUE:n|type:number}}\r\n---\r\nSaid "{{VALUE:n|type:number}}" today\r\n',
    )
  })

  it('does nothing to a note without properties', () => {
    expect(unquoteTypedScalars('Just text with "{{VALUE:n|type:number}}"\n')).toBe('Just text with "{{VALUE:n|type:number}}"\n')
  })
})
