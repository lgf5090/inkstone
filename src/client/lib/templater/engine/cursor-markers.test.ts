import { describe, expect, it } from 'vitest'
import { findCursorMarkers, groupCursorMarkers, jumpToNextCursor } from './cursor-markers'

// The expectations below are the ones upstream pins in `test/specs/internal-modules/file.e2e.ts` for its
// `tp.file.cursor` block, restated against this module's data instead of a live Obsidian editor: what the
// note text becomes, where the carets land, and which markers survive for the next jump. A jump moves to the
// lowest order still present, takes every marker written with that number, and removes them in one go, so
// these three answers are the whole of what the page-side editor needs.

const BARE = '<% tp.file.cursor() %>'
const ZERO = '<% tp.file.cursor(0) %>'
const ONE = '<% tp.file.cursor(1) %>'
const ONE_AS_DECIMAL = '<% tp.file.cursor(1.0) %>'
const ONE_AND_HALF = '<% tp.file.cursor(1.5) %>'
const TWO = '<% tp.file.cursor(2) %>'
const MINUS_ONE = '<% tp.file.cursor(-1) %>'

describe('templater cursors: finding markers', () => {
  it('finds nothing in text without a marker', () => {
    expect(findCursorMarkers('plain prose')).toEqual([])
    expect(groupCursorMarkers('plain prose')).toEqual([])
    expect(jumpToNextCursor('plain prose')).toBeNull()
  })

  it('reads the order off the argument, including a sign and a decimal part', () => {
    expect(findCursorMarkers(`a${MINUS_ONE}b${ONE_AND_HALF}c${ONE_AS_DECIMAL}d`)).toEqual([
      { order: -1, start: 1, end: 1 + MINUS_ONE.length },
      { order: 1.5, start: 2 + MINUS_ONE.length, end: 2 + MINUS_ONE.length + ONE_AND_HALF.length },
      { order: 1, start: 3 + MINUS_ONE.length + ONE_AND_HALF.length, end: 3 + MINUS_ONE.length + ONE_AND_HALF.length + ONE_AS_DECIMAL.length },
    ])
  })

  it('reads a marker with no argument as the bare form, not as order zero', () => {
    // Upstream keeps these apart on purpose: `CursorJumper.ts` — "An omitted order is its own group, so
    // that tp.file.cursor() never groups with tp.file.cursor(0)". Folding them here would silently
    // merge two jump groups an author wrote as two.
    expect(findCursorMarkers(BARE)).toEqual([{ order: null, start: 0, end: BARE.length }])
    expect(findCursorMarkers(ZERO)).toEqual([{ order: 0, start: 0, end: ZERO.length }])
  })

  it('matches the tag with any spacing the author typed', () => {
    expect(findCursorMarkers('<%tp.file.cursor(2)%>')).toHaveLength(1)
    expect(findCursorMarkers('<%   tp.file.cursor(2)   %>')).toHaveLength(1)
  })

  it('refuses a marker whose argument is not a plain number', () => {
    // A computed order cannot be placed in a jump list, and guessing it would put a caret somewhere the
    // template did not ask for. Upstream's pattern accepts a number only, and so does this one.
    expect(findCursorMarkers('<% tp.file.cursor(x) %>')).toEqual([])
    expect(findCursorMarkers('<% tp.file.cursor( 2 ) %>')).toEqual([])
    expect(findCursorMarkers('<% tp.file.cursor("2") %>')).toEqual([])
  })

  it('ignores the words of the function when they are not in a command', () => {
    expect(findCursorMarkers('tp.file.cursor(1) is a function')).toEqual([])
  })
})

describe('templater cursors: grouping by order', () => {
  it('orders the groups the way a reader jumps through them, lowest number first', () => {
    const groups = groupCursorMarkers(`a${TWO}b${MINUS_ONE}c${ONE}d${ONE_AND_HALF}e`)
    expect(groups.map((group) => group.order)).toEqual([-1, 1, 1.5, 2])
  })

  it('keeps the bare form and an explicit zero in separate groups', () => {
    // The group is keyed by `order`, so a bare marker has to stay distinguishable from `cursor(0)` all
    // the way through the exported data — not only inside the jump rule.
    const groups = groupCursorMarkers(`a${BARE}b${ZERO}`)
    expect(groups.map((group) => group.order)).toEqual([null, 0])
    expect(groups.every((group) => group.markers.length === 1)).toBe(true)
  })

  it('keeps the markers of one group in the order they appear in the text', () => {
    const [group] = groupCursorMarkers(`${ONE}x${ONE}`)
    expect(group.markers.map((marker) => marker.start)).toEqual([0, ONE.length + 1])
  })

  it('puts every order in the ladder the reader jumps through, at once', () => {
    // The whole rule from the header in one note, rather than the pairwise readings of it this file also
    // makes: `-1` before zero and before the bare form, the bare form and `0` as two stops that sort
    // together, and `1` and `1.0` as one group spelled two ways. No other case here puts a negative order
    // in the same note as zero or the bare form, so the ladder is what this pins and what a sort keyed on
    // anything but the number would break.
    const output = `${ONE_AS_DECIMAL}a${MINUS_ONE}b${BARE}c${ZERO}d${ONE}e${TWO}`
    expect(groupCursorMarkers(output).map((group) => [group.order, group.markers.length])).toEqual([
      [-1, 1],
      [null, 1],
      [0, 1],
      [1, 2],
      [2, 1],
    ])
    const walked: (number | null)[] = []
    let text = output
    for (;;) {
      const jump = jumpToNextCursor(text)
      if (jump === null) break
      walked.push(jump.order)
      text = jump.text
    }
    expect(walked).toEqual([-1, null, 0, 1, 2])
    expect(text).toBe('abcde')
  })
})

describe('templater cursors: jumping', () => {
  it('takes the bare marker alone and leaves the note with the caret behind it', () => {
    const jump = jumpToNextCursor(`before${BARE}after`)
    expect(jump).not.toBeNull()
    expect(jump?.text).toBe('beforeafter')
    expect(jump?.positions).toEqual([{ line: 0, ch: 6 }])
    expect(jump?.order).toBeNull()
    expect(jump?.remaining).toEqual([])
  })

  it('takes the lowest order first and reports the marker that is left for the next jump', () => {
    const jump = jumpToNextCursor(`before${ZERO}after${ONE}`)
    expect(jump?.text).toBe(`beforeafter${ONE}`)
    expect(jump?.positions).toEqual([{ line: 0, ch: 6 }])
    expect(jump?.remaining).toEqual([{ order: 1, start: 11, end: 11 + ONE.length }])
  })

  it('removes every marker of the order it jumps to, and gives one caret each', () => {
    const jump = jumpToNextCursor(`before${ONE}middle${ONE}after${TWO}`)
    expect(jump?.text).toBe(`beforemiddleafter${TWO}`)
    expect(jump?.positions).toEqual([
      { line: 0, ch: 6 },
      { line: 0, ch: 12 },
    ])
    expect(jump?.remaining).toEqual([{ order: 2, start: 17, end: 17 + TWO.length }])
  })

  it('jumps to a decimal order sitting between two integers, then on to the next', () => {
    const output = `before${ONE}middle${ONE_AND_HALF}after${TWO}`
    const first = jumpToNextCursor(output)
    expect(first?.order).toBe(1)
    expect(first?.text).toBe(`beforemiddle${ONE_AND_HALF}after${TWO}`)
    expect(first?.positions).toEqual([{ line: 0, ch: 6 }])
    const second = jumpToNextCursor(first?.text ?? '')
    expect(second?.order).toBe(1.5)
    expect(second?.text).toBe(`beforemiddleafter${TWO}`)
    expect(second?.positions).toEqual([{ line: 0, ch: 12 }])
    expect(jumpToNextCursor(second?.text ?? '')?.order).toBe(2)
  })

  it('jumps to a negative order before anything else', () => {
    const jump = jumpToNextCursor(`${MINUS_ONE}before${ONE}after`)
    expect(jump?.order).toBe(-1)
    expect(jump?.text).toBe(`before${ONE}after`)
    expect(jump?.positions).toEqual([{ line: 0, ch: 0 }])
  })

  it('treats an order written as an integer and as a decimal as the same jump', () => {
    // Upstream had to write this case straight into a note, because a template cannot produce `1.0`: the
    // marker stringifier answers `1`. A note edited by hand can hold it, and a jump has to see through it.
    const jump = jumpToNextCursor(`before${ONE}middle${ONE_AS_DECIMAL}after`)
    expect(jump?.text).toBe('beforemiddleafter')
    expect(jump?.positions).toEqual([
      { line: 0, ch: 6 },
      { line: 0, ch: 12 },
    ])
  })

  it('visits the bare form and the explicit zero as two separate stops', () => {
    // The reader-facing consequence of the group rule: a note that contains both must not collapse them
    // into one jump, because they sort together and only the grouping keeps them apart.
    const first = jumpToNextCursor(`x${ZERO}y${BARE}z`)
    expect(first?.order).toBe(0)
    expect(first?.text).toBe(`xy${BARE}z`)
    const second = jumpToNextCursor(first?.text ?? '')
    expect(second?.order).toBeNull()
    expect(second?.text).toBe('xyz')
    expect(jumpToNextCursor(second?.text ?? '')).toBeNull()
  })

  it('takes only the first of several bare markers, top to bottom', () => {
    const jump = jumpToNextCursor(`${BARE}a${BARE}b`)
    expect(jump?.markers).toHaveLength(1)
    expect(jump?.text).toBe(`a${BARE}b`)
    expect(jump?.remaining).toEqual([{ order: null, start: 1, end: 1 + BARE.length }])
    expect(jumpToNextCursor(jump?.text ?? '')?.text).toBe('ab')
  })

  it('keeps a bare marker out of the explicit zero group when it is the one on the way', () => {
    const jump = jumpToNextCursor(`a${BARE}b${ZERO}c`)
    expect(jump?.text).toBe(`ab${ZERO}c`)
    expect(jump?.remaining).toEqual([{ order: 0, start: 2, end: 2 + ZERO.length }])
  })

  it('clears every explicit zero marker and leaves the bare one for later', () => {
    const jump = jumpToNextCursor(`a${ZERO}b${ZERO}c${BARE}d`)
    expect(jump?.text).toBe(`abc${BARE}d`)
    expect(jump?.positions).toEqual([
      { line: 0, ch: 1 },
      { line: 0, ch: 2 },
    ])
  })

  it('reports the markers it took at the offsets they had in the text it was given', () => {
    const output = `${ONE}x${ONE}`
    const jump = jumpToNextCursor(output)
    expect(jump?.markers).toEqual([
      { order: 1, start: 0, end: ONE.length },
      { order: 1, start: ONE.length + 1, end: 2 * ONE.length + 1 },
    ])
  })

  it('places carets on the lines the markers were on, after the text above them shrank', () => {
    const jump = jumpToNextCursor(`A${ONE}\nB${ONE}`)
    expect(jump?.text).toBe('A\nB')
    expect(jump?.positions).toEqual([
      { line: 0, ch: 1 },
      { line: 1, ch: 1 },
    ])
  })

  it('counts a marker on a later line as the note text above it is deleted', () => {
    // Deleting the order-1 markers shortens every line below, so the surviving marker has to be reported
    // against the text the caller is now holding, not the one it came from.
    const jump = jumpToNextCursor(`${ONE}\nsecond line\n${TWO}`)
    expect(jump?.remaining).toEqual([{ order: 2, start: 13, end: 13 + TWO.length }])
  })
})
