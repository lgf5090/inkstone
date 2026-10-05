import { describe, expect, it } from 'vitest'
import { t } from '../../lib/i18n'
import {
  MAX_RENDERED_DIFF_LINES,
  computeLineDiff,
  type DiffResult,
} from './VersionsPanel'

interface Line {
  kind: 'same' | 'add' | 'remove'
  text: string
}

/** The pre-change implementation: materialize every line, then truncate the array. */
function referenceDiff(before: string, after: string): DiffResult {
  const a = before.split('\n')
  const b = after.split('\n')
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (suffix < a.length - prefix && suffix < b.length - prefix
    && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++
  const head: Line[] = a.slice(0, prefix).map((text) => ({ kind: 'same', text }))
  const tail: Line[] = suffix ? a.slice(a.length - suffix).map((text) => ({ kind: 'same', text })) : []
  const beforeMiddle = a.slice(prefix, a.length - suffix)
  const afterMiddle = b.slice(prefix, b.length - suffix)
  const simplified = beforeMiddle.length * afterMiddle.length > 600000
  const middle: Line[] = simplified
    ? [
        ...beforeMiddle.map((text): Line => ({ kind: 'remove', text })),
        ...afterMiddle.map((text): Line => ({ kind: 'add', text })),
      ]
    : computeMiddleLcsReference(beforeMiddle, afterMiddle)
  const added = middle.reduce((count, line) => count + (line.kind === 'add' ? 1 : 0), 0)
  const removed = middle.reduce((count, line) => count + (line.kind === 'remove' ? 1 : 0), 0)
  const all = [...head, ...middle, ...tail]
  let lines = all
  if (all.length > MAX_RENDERED_DIFF_LINES) {
    const before1 = Math.floor((MAX_RENDERED_DIFF_LINES - 1) / 2)
    const after1 = MAX_RENDERED_DIFF_LINES - before1 - 1
    lines = [
      ...all.slice(0, before1),
      { kind: 'same', text: t("workspace.value0_unchanged_lines_hidden", { value0: all.length - before1 - after1 }) },
      ...all.slice(-after1),
    ]
  }
  return { lines, added, removed, simplified }
}

function computeMiddleLcsReference(a: string[], b: string[]): Line[] {
  const width = b.length + 1
  const table = new Uint16Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    const row = i * width
    const nextRow = (i + 1) * width
    for (let j = b.length - 1; j >= 0; j--) {
      table[row + j] = a[i] === b[j]
        ? table[nextRow + j + 1]! + 1
        : Math.max(table[nextRow + j]!, table[row + j + 1]!)
    }
  }
  const lines: Line[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i]! })
      i++
      j++
    }
    else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      lines.push({ kind: 'remove', text: a[i]! })
      i++
    }
    else {
      lines.push({ kind: 'add', text: b[j]! })
      j++
    }
  }
  while (i < a.length) lines.push({ kind: 'remove', text: a[i++]! })
  while (j < b.length) lines.push({ kind: 'add', text: b[j++]! })
  return lines
}

const lines = (result: DiffResult) => result.lines.map((line) => `${line.kind[0]}${line.text}`)

const compare = (before: string, after: string) => {
  const mine = computeLineDiff(before, after)
  const reference = referenceDiff(before, after)
  expect(lines(mine)).toEqual(lines(reference))
  expect({ added: mine.added, removed: mine.removed, simplified: mine.simplified })
    .toEqual({ added: reference.added, removed: reference.removed, simplified: reference.simplified })
  return mine
}

const many = (count: number, offset = 0) =>
  Array.from({ length: count }, (_, index) => `line ${index + offset}`).join('\n')

describe('computeLineDiff', () => {
  it('matches the previous implementation on small edits', () => {
    compare('a\nb\nc', 'a\nB\nc')
    compare('a\nb\nc', 'a\nb\nc\nd')
    compare('a\nb\nc\nd', 'b\nc\nd')
    compare('', 'x')
    compare('x', '')
    compare('same', 'same')
  })

  it('matches on a windowed diff whose head and tail dwarf the change', () => {
    const before = many(6000)
    const after = `${many(3000)}\nCHANGED\n${many(2999, 3001)}`
    const result = compare(before, after)
    expect(result.lines.length).toBe(MAX_RENDERED_DIFF_LINES)
    expect(lines(result)).toContain(`s${t("workspace.value0_unchanged_lines_hidden", { value0: 6000 + 1 + 1 - MAX_RENDERED_DIFF_LINES })}`)
    expect(result.added).toBe(1)
    expect(result.removed).toBe(1)
  })

  it('matches in simplified mode without building the middle twice', () => {
    const before = `${Array.from({ length: 900 }, (_, i) => `old ${i}`).join('\n')}\n${many(2000, 900)}`
    const after = `${Array.from({ length: 900 }, (_, i) => `new ${i}`).join('\n')}\n${many(2000, 900)}`
    const result = compare(before, after)
    expect(result.simplified).toBe(true)
    expect(result.added).toBe(900)
    expect(result.removed).toBe(900)
  })

  it('keeps counts exact while truncating what is shown', () => {
    const before = many(12000)
    const after = `${many(11000)}\n${Array.from({ length: 500 }, (_, i) => `inserted ${i}`).join('\n')}\n${many(499, 11001)}`
    const result = computeLineDiff(before, after)
    expect(result.lines.length).toBe(MAX_RENDERED_DIFF_LINES)
    expect(result.added).toBeGreaterThanOrEqual(500)
    expect(result.removed).toBeGreaterThanOrEqual(0)
    expect(result.lines.filter((line) => line.kind === 'add').length).toBeLessThan(MAX_RENDERED_DIFF_LINES)
  })
})
