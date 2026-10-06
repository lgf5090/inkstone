import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Hover-only controls (`opacity-0` until the card/row is hovered) are invisible
 * while being keyboard-focused, which strands Tab focus on an unseen button.
 * Every such control must also reveal itself on `focus-visible`; this keeps the
 * next `opacity-0` affordance from shipping without it.
 */
const KANBAN_UI_DIR = path.join('src', 'client', 'lib', 'markdown', 'kanban', 'ui')

function hoverOnlyLinesWithoutFocusVariant(): string[] {
  return fs
    .readdirSync(KANBAN_UI_DIR)
    .filter((f) => /\.tsx$/.test(f))
    .flatMap((f) =>
      fs
        .readFileSync(path.join(KANBAN_UI_DIR, f), 'utf8')
        .split('\n')
        .map((line, i) => ({ text: line, n: i + 1 }))
        .filter(({ text }) => text.includes('opacity-0') && !text.includes('focus-visible:'))
        .map(({ text, n }) => `${f}:${n}: ${text.trim()}`)
    )
}

describe('kanban hover-only controls', () => {
  it('reveal themselves on keyboard focus', () => {
    expect(hoverOnlyLinesWithoutFocusVariant()).toEqual([])
  })
})
