import { describe, expect, it } from 'vitest'
import type { InknoteTextBox } from '@shared/inknote/types'
import {
  autoTextBoxSize,
  fontStackFor,
  layoutTextBox,
  measureTextBox,
  SYSTEM_FONT_STACK,
  TEXT_MIN_WIDTH,
} from './text-layout'

const HAN = '\u4e2d\u6587\u6d4b\u8bd5'
/** Ten pixels per code point, so expected line widths are readable. */
const measure = (text: string): number => [...text].length * 10

function textBox(overrides: Partial<InknoteTextBox> = {}): InknoteTextBox {
  return {
    id: 't1',
    x: 0,
    y: 0,
    w: 0.5,
    h: 0.2,
    text: '',
    fontSize: 20,
    color: '#111111',
    align: 'left',
    bold: false,
    italic: false,
    underline: false,
    hl: null,
    lh: 1.5,
    list: null,
    ...overrides,
  }
}

describe('fontStackFor', () => {
  it('maps the four families and falls back to system', () => {
    expect(fontStackFor('system')).toBe(SYSTEM_FONT_STACK)
    expect(fontStackFor('rounded')).toContain('ui-rounded')
    expect(fontStackFor('serif')).toContain('Georgia')
    expect(fontStackFor('mono')).toContain('monospace')
    expect(fontStackFor('unknown')).toBe(SYSTEM_FONT_STACK)
    expect(fontStackFor(null)).toBe(SYSTEM_FONT_STACK)
  })
})

describe('layoutTextBox', () => {
  it('wraps on whitespace and reports line positions', () => {
    const layout = layoutTextBox('hello world', textBox(), measure, { pageWidth: 100 })
    expect(layout.boxWidth).toBe(50)
    expect(layout.lineHeight).toBe(30)
    expect(layout.lines.map((line) => line.text)).toEqual(['hello', 'world'])
    expect(layout.lines.map((line) => line.width)).toEqual([50, 50])
    expect(layout.lines.map((line) => line.x)).toEqual([0, 0])
    expect(layout.lines.map((line) => line.y)).toEqual([0, 30])
    expect(layout.contentWidth).toBe(50)
    expect(layout.contentHeight).toBe(60)
  })

  it('centres and right-aligns inside the box', () => {
    const centred = layoutTextBox('hi', textBox({ align: 'center' }), measure, { pageWidth: 100 })
    expect(centred.lines[0]).toMatchObject({ x: 15, width: 20 })
    const right = layoutTextBox('hi', textBox({ align: 'right' }), measure, { pageWidth: 100 })
    expect(right.lines[0]).toMatchObject({ x: 30, width: 20 })
  })

  it('adds list markers and numbers each rendered line', () => {
    const bullets = layoutTextBox('one\ntwo', textBox({ list: 'bullet' }), measure, { pageWidth: 200 })
    expect(bullets.lines.map((line) => line.text)).toEqual(['\u2022 one', '\u2022 two'])
    const numbers = layoutTextBox('one\ntwo', textBox({ list: 'number' }), measure, { pageWidth: 200 })
    expect(numbers.lines.map((line) => line.text)).toEqual(['1. one', '2. two'])
  })

  it('honours explicit newlines, including a blank line', () => {
    const layout = layoutTextBox('a\n\nb', textBox(), measure, { pageWidth: 200 })
    expect(layout.lines.map((line) => line.text)).toEqual(['a', '', 'b'])
    expect(layout.lines.map((line) => line.y)).toEqual([0, 30, 60])
    expect(layout.lines[1]!.width).toBe(0)
  })

  it('wraps unspaced CJK text between characters', () => {
    const layout = layoutTextBox(HAN, textBox(), measure, { pageWidth: 40 })
    expect(layout.lines.map((line) => line.text)).toEqual([
      '\u4e2d\u6587',
      '\u6d4b\u8bd5',
    ])
  })

  it('keeps a long word together and returns no lines for empty text', () => {
    const long = layoutTextBox('abcdef', textBox(), measure, { pageWidth: 30 })
    expect(long.lines.map((line) => line.text)).toEqual(['abcdef'])
    expect(layoutTextBox('', textBox(), measure, { pageWidth: 100 })).toMatchObject({
      lines: [], contentWidth: 0, contentHeight: 0,
    })
  })

  it('uses the current font and style when measuring', () => {
    const fonts: string[] = []
    layoutTextBox('a', textBox({ bold: true, italic: true }), (text, font) => {
      fonts.push(font)
      return measure(text)
    }, { pageWidth: 100, font: 'Georgia, serif' })
    expect(fonts[0]).toContain('italic 700 20px Georgia, serif')
  })

  it('does not mutate the item', () => {
    const item = textBox()
    layoutTextBox('hello', item, measure, { pageWidth: 100 })
    expect(item).toMatchObject({ w: 0.5, h: 0.2, text: '', align: 'left' })
  })
})

describe('measureTextBox', () => {
  it('returns the laid-out content size', () => {
    const size = measureTextBox('hello\nhi', textBox(), measure, { pageWidth: 100 })
    expect(size).toEqual({ width: 50, height: 60 })
  })
})

describe('autoTextBoxSize', () => {
  it('fits the longest explicit line with a 10 px inset', () => {
    const size = autoTextBoxSize('hello\nworld!', textBox(), measure, { pageWidth: 200, pageHeight: 400 })
    expect(size.w).toBeCloseTo(0.4)
    expect(size.h).toBeCloseTo(0.2)
  })

  it('keeps the minimum width and one line of height for empty text', () => {
    const size = autoTextBoxSize('', textBox(), measure, { pageWidth: 200, pageHeight: 400 })
    expect(size.w).toBe(TEXT_MIN_WIDTH)
    expect(size.h).toBeCloseTo(0.125)
  })

  it('falls back to the standard page for unusable dimensions', () => {
    const size = autoTextBoxSize('hi', textBox(), measure, { pageWidth: -1, pageHeight: 0 })
    expect(size.w).toBe(TEXT_MIN_WIDTH)
    expect(size.h).toBeCloseTo((30 + 20) / 1056)
  })
})
