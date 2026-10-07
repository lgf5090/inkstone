import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The still of a board has two audiences, and `styles/kanban.css` is the only place that tells them
 * apart: the `list` shape is read at arm's length (a hover card, the editor's live preview, a note
 * export, a shared page), the `board` shape is read from several metres — the projector, the printed
 * deck, the presenter's own panes (N-36). The sheet carries no comments by policy, so the reasoning
 * for its sizes reads here, beside the only assertions that look at it.
 *
 * The floor is N-02's. Its `MIN_FIT_SCALE = 0.64` says the canvas may be shrunk no further than
 * 18/28: body copy on a projected page stays at or above 18 design px of that canvas, in whatever
 * window the show runs in. The board's text was written at desk sizes — a card title at `--text-14`,
 * a chip at `--text-11` — so the still N-36 shipped painted a card title at 11.6 css px in a
 * 1280x900 window while the prose beside it stayed legal. Measured before and after this change on
 * one real show: the board's block went from 368 to 421 design px and the page's content from 480 to
 * 533 of the 632 it has, still one page with the columns a third each.
 *
 * Two tiers, splitting the same way the live board does: the lines a room has to make out — the
 * board's name, a column's name, a card's title, the sentence an empty board leaves — sit at the
 * floor; a card's annotations — its chips, its subtask count, a declared field — sit one step below
 * it. Column names are not given a smaller tier than card titles because the live board does not:
 * there the header is `--text-13` under a `--text-14` title, and a projected header has to be read
 * as well as the card it heads, so both take the floor and the tint and the position carry the rank.
 *
 * A stylesheet cannot say what lands. The projector scenario in `scripts/e2e-visual.mjs` reads the
 * computed size off the real canvas, and this file only pins the contract the sheet writes: that the
 * board channel asks for the two tiers, that the board-scoped rules are the ones that carry them,
 * and that the desk-sized `list` shape kept the sizes it had before anyone thought about a projector.
 */
const KANBAN_CSS = fs.readFileSync('src/client/styles/kanban.css', 'utf8')
const TOKENS = fs.readFileSync('src/client/styles/tokens.css', 'utf8')

const FLOOR_PX = 18
const ANNOTATION_PX = 14

/** Every declaration block, keyed by each selector its selector list names. */
function blocks(): Map<string, string> {
  const found = new Map<string, string>()
  for (const match of KANBAN_CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const body = match[2]!
    for (const selector of match[1]!.split(',')) found.set(selector.trim(), body)
  }
  return found
}

/** The last value the sheet writes for a property in that selector's own block — the cascade's order. */
function declaration(selector: string, property: string): string {
  const body = blocks().get(selector)
  if (body === undefined) throw new Error(`kanban.css declares no block for ${selector}`)
  const found = [...body.matchAll(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'g'))]
  if (found.length === 0) throw new Error(`${selector} declares no ${property}`)
  return found[found.length - 1]![1]!.trim()
}

/** A size in the canvas's own design pixels, read off the token the sheet asked for. */
function designPx(selector: string, property = 'font-size'): number {
  const value = declaration(selector, property)
  const token = /^var\((--[a-z0-9.-]+)\)$/.exec(value)?.[1]
  const raw = token
    ? new RegExp(`\\${token}:\\s*([\\d.]+)px`).exec(TOKENS)?.[1]
    : /^([\d.]+)px$/.exec(value)?.[1]
  if (!raw) throw new Error(`${selector} sets ${property} to ${value}, which is not a text token`)
  return Number.parseFloat(raw)
}

const TITLE = '.ink-prose .kanban-snapshot-board .kanban-snapshot-card-title'
const GROUP = '.ink-prose .kanban-board-columns .kanban-snapshot-group'
const BOARD_TITLE = '.ink-prose .kanban-snapshot-board .kanban-snapshot-title'
const EMPTY = '.ink-prose .kanban-snapshot-board .kanban-snapshot-empty'
const CHIP = '.ink-prose .kanban-snapshot-board .kanban-snapshot-card-tags li'
const PRIORITY = '.ink-prose .kanban-snapshot-board .kanban-snapshot-card-priority'
const SUBTASKS = '.ink-prose .kanban-snapshot-board .kanban-snapshot-card-subtasks'
const CARD = '.ink-prose .kanban-snapshot-board .kanban-snapshot-card'
const FIELD_NAME = '.ink-prose .kanban-snapshot-board [data-kanban-card-fields] dt'
const FIELD_VALUE = '.ink-prose .kanban-snapshot-board [data-kanban-card-fields] dd'

describe('the projected board is sized for the back of the room', () => {
  it('puts every line a reader has to make out at the floor N-02 set', () => {
    for (const selector of [TITLE, GROUP, BOARD_TITLE, EMPTY])
      expect(designPx(selector), `${selector} sits below the projector floor`).toBeGreaterThanOrEqual(FLOOR_PX)
  })

  it('puts a card annotation one step below it, which is what keeps it an annotation', () => {
    for (const selector of [CHIP, PRIORITY, SUBTASKS, FIELD_NAME, FIELD_VALUE])
      expect(designPx(selector), `${selector} is smaller than a chip may be`).toBeGreaterThanOrEqual(ANNOTATION_PX)
    expect(designPx(CARD), 'a card body sets the size its annotations inherit').toBeGreaterThanOrEqual(ANNOTATION_PX)
  })

  it('carries the sizes on the board channel, so the desk-sized still is not dragged along', () => {
    // The four rules the list shape shares: a group name, the board's own name, the sentence an empty
    // board leaves, and a card's line of text. None of them is a projected surface, so none of them
    // takes the floor — and if one of them did, the hover card and the note export would rewrap.
    expect(designPx('.ink-prose .kanban-snapshot-group')).toBeLessThan(FLOOR_PX)
    expect(designPx('.ink-prose .kanban-snapshot-title')).toBeLessThan(FLOOR_PX)
    expect(designPx('.ink-prose .kanban-snapshot-empty')).toBeLessThan(FLOOR_PX)
    expect(designPx('.ink-prose .kanban-snapshot-cards')).toBeLessThan(FLOOR_PX)
  })

  it('names the card title rule for the board it belongs to', () => {
    // A card title is only ever drawn by the board shape today, so the rule could have stayed
    // unscoped. It is scoped anyway: the sheet is then unable to hand a projector's size to a
    // surface that adds the class to the list shape later, which is the mistake this whole item is
    // about.
    expect(blocks().has(TITLE), 'the card title size is not written on the board channel').toBe(true)
    expect(blocks().has('.ink-prose .kanban-snapshot-card-title'), 'an unscoped card-title rule is still there').toBe(false)
  })
})
