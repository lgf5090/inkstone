/**
 * The outline body cannot carry subtasks, files, icons, descriptions, custom
 * properties, views or even the board title — every one of those is editable in
 * the UI, so persisting an outline fence back as outline silently drops the
 * edit. The first UI write therefore promotes the fence to full-fidelity JSON.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanBlockEntry } from './entry'
import { parseKanbanBody, serializeKanban } from './body'
import type { KanbanWriteResult } from './types'
import { discardKanbanWrite, flushKanbanEntry, retryKanbanWrite, scheduleKanbanWrite } from './write'

const OUTLINE_BODY = '## To Do\n- [ ] First Task'

function outlineEntry(): { entry: KanbanBlockEntry; write: ReturnType<typeof vi.fn> } {
  const parsed = parseKanbanBody(OUTLINE_BODY)
  if (!parsed.ok) throw new Error('the outline fence should parse')
  parsed.data.items[0]!.subtasks = [{ id: 'sub-1', title: 'Draft schema', completed: false }]
  const write = vi.fn((): KanbanWriteResult => 'written')
  return {
    write,
    entry: {
      key: 'write-test#0',
      scope: 'write-test',
      noteId: 'note-1',
      index: 0,
      host: document.createElement('div'),
      source: OUTLINE_BODY,
      data: parsed.data,
      mode: 'outline',
      editable: true,
      owner: 'inline',
      container: null,
      root: null,
      reserveHeight: null,
      ref: { line: 3, body: OUTLINE_BODY },
      write,
      dirty: true,
      unsaved: false,
      disposed: false,
      timer: null,
      handlers: null,
      rendered: null,
    },
  }
}

/**
 * Every edit rewrites the whole note, so what a run of edits costs is counted in writes rather than
 * in milliseconds: these tests drive a fake clock and assert how many times the note was written.
 *
 * The counts are the measurement behind K-20. What they show is that the plain debounce already
 * coalesces a gesture — a slider swept in twelve steps writes the note once, when the hand stops —
 * so the cost of an interaction is one whole-note write per gesture, not per edit. The last case
 * measures the other end: gestures far enough apart that the debounce cannot merge them write once
 * each, which is deliberate rather than a defect, and is what an "adaptive quiet period" would have
 * traded for leaving the note unwritten for seconds at a time.
 */

/** One edit that really changes the board: identical content is not a write at all. */
function editBoard(entry: KanbanBlockEntry, step: number): void {
  entry.data!.title = `Sweep ${step}`
  entry.dirty = true
  scheduleKanbanWrite(entry)
}

/** `count` edits, `gapMs` apart, letting the fake clock and the timers move together. */
function sweepEdits(entry: KanbanBlockEntry, count: number, gapMs: number): void {
  for (let step = 0; step < count; step += 1) {
    if (step > 0) vi.advanceTimersByTime(gapMs)
    editBoard(entry, step)
  }
}

/** The fake clock again, for the counts below and nothing else in this file. */
function useWriteClock(): void {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })
}

const edit = editBoard
const sweep = sweepEdits


describe('what one gesture costs the note', () => {
  useWriteClock()

  it('writes once for a slider swept in twelve steps', () => {
    const { entry, write } = outlineEntry()
    sweep(entry, 12, 120)
    expect(write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2_000)
    expect(write).toHaveBeenCalledTimes(1)
    expect(entry.source).toBe(write.mock.calls[0][1])
  })

  it('writes once for a card dragged through a dozen cells', () => {
    const { entry, write } = outlineEntry()
    // A pointer move commits nothing, but a keyboard walk (Shift+Arrow) or a menu move commits per
    // step; either way the gesture is one write once it stops.
    sweep(entry, 12, 40)
    vi.advanceTimersByTime(2_000)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('writes nothing at all when the commit leaves the board the note already holds', () => {
    const { entry, write } = outlineEntry()
    // A commit that changes nothing the fence stores — pressing the view tab it is already on, or a
    // drag that ends in the cell it started from — costs a serialize and no write.
    entry.source = serializeKanban(entry.data!, 'json')
    entry.mode = 'json'
    entry.dirty = true
    scheduleKanbanWrite(entry)
    vi.advanceTimersByTime(1_000)
    expect(write).not.toHaveBeenCalled()
    expect(entry.dirty).toBe(false)
  })})

/**
 * What those writes hand the note, in bytes. A write is a whole-board serialization, so the fence's
 * own size is what one gesture costs: measured 7,285 bytes for 20 cards, 14,935 for 50 and 53,385 for
 * 200 — about 256 bytes per card on top of the board's schema. The budgets are that plus a quarter of
 * room, and they are what catches a change that starts writing something into every card that no
 * reader ever asks for.
 */
describe('what one write hands the note', () => {
  function fenceBytes(cards: number): number {
    const items = Array.from({ length: cards }, (_, index) => ({
      id: `item-${index}`,
      title: `Card ${index}`,
      properties: { status: 'todo', tags: ['feat'], startDate: '2026-09-20', endDate: '2026-09-30', progress: 40 },
    }))
    return new TextEncoder().encode(serializeKanban({ ...outlineEntry().entry.data!, items }, 'json')).length
  }

  it('stays inside the per-card budget the measured fence costs', () => {
    expect(fenceBytes(200)).toBeLessThan(64 * 1024)
    expect(fenceBytes(200) - fenceBytes(50)).toBeLessThan(150 * 320)
  })
})

describe('what gestures far apart cost', () => {
  useWriteClock()

  it('counts the gestures it cannot merge, which is the measured cost of a busy minute', () => {
    const { entry, write } = outlineEntry()
    // Six gestures 700ms apart: each one is a complete edit the reader made, and each writes once.
    // An adaptive quiet period would have written two or three times instead — at the price of
    // leaving up to three seconds of edits unwritten, which is why it was not taken.
    sweep(entry, 6, 700)
    vi.advanceTimersByTime(2_000)
    expect(write.mock.calls.length).toBe(6)
  })

  it('writes on the plain debounce again once a gesture has settled', () => {
    const { entry, write } = outlineEntry()
    sweep(entry, 2, 700)
    vi.advanceTimersByTime(5_000)
    const settled = write.mock.calls.length
    edit(entry, 99)
    vi.advanceTimersByTime(600)
    expect(write.mock.calls.length).toBe(settled + 1)
  })
})

describe('flushKanbanEntry format promotion', () => {
  it('writes an outline fence back as JSON carrying the fields outline cannot hold', () => {
    const { entry, write } = outlineEntry()
    flushKanbanEntry(entry)

    expect(entry.mode).toBe('json')
    const written = write.mock.calls[0][1] as string
    const body = JSON.parse(written)
    expect(body.items[0].subtasks).toEqual([{ id: 'sub-1', title: 'Draft schema', completed: false }])
    expect(entry.source).toBe(written)
  })

  it('keeps a JSON fence writing JSON', () => {
    const { entry, write } = outlineEntry()
    entry.mode = 'json'
    entry.source = JSON.stringify({ ...entry.data, title: 'Other' })

    flushKanbanEntry(entry)

    expect(entry.mode).toBe('json')
    const written = write.mock.calls[0][1] as string
    expect(written.startsWith('{')).toBe(true)
    expect(JSON.parse(written).items[0].subtasks).toBeDefined()
  })
})

describe('flushKanbanEntry conflict handling', () => {
  it('keeps the edits in memory and flags the entry unsaved when the write conflicts', () => {
    const { entry, write } = outlineEntry()
    write.mockReturnValue('conflict')
    const edits = entry.data

    flushKanbanEntry(entry)

    expect(entry.unsaved).toBe(true)
    expect(entry.dirty).toBe(false)
    expect(entry.data).toBe(edits)
    expect(entry.source).toBe(OUTLINE_BODY)
  })
})

describe('retryKanbanWrite and discardKanbanWrite', () => {
  it('retry writes once the fence resolves and clears the unsaved flag', () => {
    const { entry, write } = outlineEntry()
    write.mockReturnValue('conflict')
    flushKanbanEntry(entry)
    expect(entry.unsaved).toBe(true)

    write.mockReturnValue('written')
    const result = retryKanbanWrite(entry)

    expect(result).toBe('written')
    expect(entry.unsaved).toBe(false)
    expect(write).toHaveBeenCalledTimes(2)
    expect(entry.source).toBe(write.mock.calls[1][1])
  })

  it('discard clears the pending state without another write', () => {
    const { entry, write } = outlineEntry()
    write.mockReturnValue('conflict')
    flushKanbanEntry(entry)

    discardKanbanWrite(entry)

    expect(entry.unsaved).toBe(false)
    expect(entry.dirty).toBe(false)
    expect(write).toHaveBeenCalledTimes(1)
    expect(flushKanbanEntry(entry)).toBeNull()
    expect(write).toHaveBeenCalledTimes(1)
  })
})
