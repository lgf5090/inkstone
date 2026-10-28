import { describe, expect, it } from 'vitest'
import { answerTextBoxes } from './assistant-answer'

describe('answerTextBoxes', () => {
  it('turns paragraphs into boxes from the top of the page', () => {
    const boxes = answerTextBoxes('First paragraph.\n\nSecond paragraph.', { pageHeight: 1056, textSize: 26 })
    expect(boxes.map((box) => box.text)).toEqual(['First paragraph.', 'Second paragraph.'])
    expect(boxes[0]!.y).toBe(0.08)
    expect(boxes[1]!.y).toBeGreaterThan(boxes[0]!.y)
    expect(boxes.every((box) => box.w === 0.88)).toBe(true)
  })

  it('stops at the page bottom instead of writing below it', () => {
    const boxes = answerTextBoxes(Array.from({ length: 30 }, (_, index) => `Paragraph ${index} ${'x'.repeat(200)}`).join('\n\n'), { pageHeight: 1056, textSize: 26 })
    expect(boxes.length).toBeLessThan(30)
    expect(boxes.every((box) => box.y + box.h <= 0.92)).toBe(true)
  })

  it('caps the number of boxes for a long answer', () => {
    const boxes = answerTextBoxes(Array.from({ length: 20 }, (_, index) => `P${index}`).join('\n\n'), { pageHeight: 4000, textSize: 18 })
    expect(boxes).toHaveLength(12)
  })

  it('ignores blank paragraphs', () => {
    expect(answerTextBoxes('\n\n   \n\nHello\n\n\n\n', { pageHeight: 1056, textSize: 26 }).map((box) => box.text)).toEqual(['Hello'])
  })
})
