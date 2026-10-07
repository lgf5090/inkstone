// The show's keymap as a pure function so it can be tested without a browser: which
// command a key press means, given whether a control or the slide list owns the event.
// Navigation keys always move slides so a stray focused control can never trap the
// keyboard; Space/Enter yield to the focused control to avoid double actions, each list
// keeps only the keys its own walk uses — the rail the vertical ones, the overview grid
// both directions — and the notes pane keeps every key a speaker reads by scrolling.

import { t, type MessageKey } from '../../lib/i18n'
import { prettyCombo } from '../../lib/hotkeys'

export type PresentationCommand = 'next' | 'prev' | 'first' | 'last' | 'fullscreen' | 'slideList' | 'follow' | 'blackout' | 'whiteout' | 'laser' | 'spotlight' | 'overview' | 'presenter' | 'keyGuide'

/** A binding the reference prints: what the keys can run, plus `Escape`, which the dialog owns. */
export type PresentationKeyCommand = PresentationCommand | 'exit'

export interface PresentationKeyContext {
  /** The event targets a button, link or editable control. */
  onControl: boolean
  /** The event targets the slide rail, which walks its column with the vertical keys. */
  onSlideList: boolean
  /** The event targets the overview grid, which roams its cards across rows as well as down them. */
  onOverviewGrid?: boolean
  /** The event targets the speaker notes pane, which is read by scrolling rather than by turning. */
  onNotesPane?: boolean
  /** The event targets an open menu which walks its own items. */
  onMenu?: boolean
}

export function presentationCommand(key: string, context: PresentationKeyContext): PresentationCommand | null {
  if (context.onMenu) return null
  const onNotes = Boolean(context.onNotesPane)
  const onGrid = Boolean(context.onOverviewGrid)
  // The rail walks its column and the grid roams its rows, both with Home/End; a notes pane pages as
  // it is read, so it keeps PageUp/PageDown too. Only the grid claims the sideways turn: the rail
  // has no use for it, and yielding it there left the turn handled by neither side.
  const ownsVertical = context.onSlideList || onNotes || onGrid
  const ownsSideways = onGrid
  switch (key) {
    case 'ArrowRight':
      return ownsSideways ? null : 'next'
    case 'PageDown':
      return onNotes ? null : 'next'
    case 'ArrowLeft':
      return ownsSideways ? null : 'prev'
    case 'PageUp':
      return onNotes ? null : 'prev'
    case 'ArrowDown':
      return ownsVertical ? null : 'next'
    case 'ArrowUp':
      return ownsVertical ? null : 'prev'
    case 'Home':
      return ownsVertical ? null : 'first'
    case 'End':
      return ownsVertical ? null : 'last'
    case ' ':
      return context.onControl || onNotes ? null : 'next'
    case 'Enter':
      return context.onControl ? null : 'next'
    case '.':
      return context.onControl ? null : 'blackout'
    case ',':
      return context.onControl ? null : 'whiteout'
    case '?':
      return context.onControl ? null : 'keyGuide'
    default: {
      const tool = TOOL_KEYS[key.length === 1 ? key.toLowerCase() : '']
      return tool === undefined || context.onControl ? null : tool
    }
  }
}

// The tools a single letter drives, all of which yield to a focused control. Written as a table
// because the eight cases it replaces differed only in the letter: adding a tool is one row here.
// The pointer takes C because L already drives following, and moving a shipped key would cost more
// than the mnemonic it buys; O is the key a deck overview has carried since reveal.js and G names
// the grid it is laid out as, so a presenter who reaches for either gets the same screen.
const TOOL_KEYS: Record<string, PresentationCommand> = {
  f: 'fullscreen',
  l: 'follow',
  c: 'laser',
  t: 'spotlight',
  k: 'spotlight',
  s: 'slideList',
  o: 'overview',
  g: 'overview',
  b: 'blackout',
  w: 'whiteout',
  p: 'presenter',
}

// Every binding the show answers to, in the order the card and the menu print them, with the words the
// control it drives already uses for it. The table is a `Record` over the command union, so a command
// the map gained without a row documenting it does not build — the reference cannot silently fall
// behind the map. What it must not do is claim a key the map answers with something else, which is the
// case `presentation-keys.test.ts` runs against `presentationCommand` itself.
const KEY_REFERENCE: Record<PresentationKeyCommand, { keys: string[]; labelKey: MessageKey }> = {
  next: { keys: ['ArrowRight', 'PageDown', 'ArrowDown', ' ', 'Enter'], labelKey: 'workspace.presentation_next' },
  prev: { keys: ['ArrowLeft', 'PageUp', 'ArrowUp'], labelKey: 'workspace.presentation_prev' },
  first: { keys: ['Home'], labelKey: 'workspace.presentation_first_slide' },
  last: { keys: ['End'], labelKey: 'workspace.presentation_last_slide' },
  overview: { keys: ['g', 'o'], labelKey: 'workspace.presentation_overview' },
  slideList: { keys: ['s'], labelKey: 'workspace.presentation_slides' },
  presenter: { keys: ['p'], labelKey: 'workspace.presentation_presenter' },
  follow: { keys: ['l'], labelKey: 'workspace.presentation_follow' },
  laser: { keys: ['c'], labelKey: 'workspace.presentation_laser' },
  spotlight: { keys: ['t', 'k'], labelKey: 'workspace.presentation_spotlight' },
  blackout: { keys: ['b', '.'], labelKey: 'workspace.presentation_blackout' },
  whiteout: { keys: ['w', ','], labelKey: 'workspace.presentation_whiteout' },
  fullscreen: { keys: ['f'], labelKey: 'workspace.presentation_fullscreen' },
  keyGuide: { keys: ['?'], labelKey: 'workspace.presentation_keys' },
  exit: { keys: ['Escape'], labelKey: 'workspace.presentation_exit' },
}

// The reference stores a keystroke the way the browser reports it, because that is the spelling
// `presentationCommand` is asked about, and shows it through the combo grammar the rest of the app
// already reads — one key, one spelling in the card, the tooltip and the menu row. Only the space bar
// has no word of its own in either spelling, so it is the one name that has to be translated.
function comboGrammar(key: string): string {
  return key === ' ' ? 'space' : key.toLowerCase()
}

/** One row of the reference: the binding, the keys that run it, and the words and caps that say so. */
export interface PresentationKeyRow {
  command: PresentationKeyCommand
  /** The keystrokes as the browser reports them — the spelling `presentationCommand` takes. */
  bindings: string[]
  /** The same keystrokes as the caps a presenter reads. */
  caps: string[]
  description: string
}

export function presentationKeyReference(): PresentationKeyRow[] {
  return (Object.keys(KEY_REFERENCE) as PresentationKeyCommand[]).map((command) => ({
    command,
    bindings: KEY_REFERENCE[command].keys,
    caps: KEY_REFERENCE[command].keys.map((key) => prettyCombo(comboGrammar(key))[0]!),
    description: t(KEY_REFERENCE[command].labelKey),
  }))
}

/** The one key a tooltip or a menu row shows for a binding: the first the reference lists for it. */
export function presentationKeyCombo(command: PresentationKeyCommand): string {
  return comboGrammar(KEY_REFERENCE[command].keys[0]!)
}
