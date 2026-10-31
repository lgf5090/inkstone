/**
 * Client↔server contract constants for the Color Assistant.
 *
 * These values used to live in two places each: the slider bounds in a view, the matching ceiling in a
 * zod schema, and the history window in a comment. A reader who pushed the extract-count slider to its
 * right-hand end sent thirteen colors to an endpoint that accepted twelve, and every picker drag logged a
 * source the schema would refuse. Naming the bounds once is what keeps the control and the validator
 * from drifting apart again, so the schema, the store and the views all read from here.
 */

/** Where a color was picked, recorded in the sliding history window. */
export const COLOR_HISTORY_SOURCES = [
  'studio',
  'picker',
  'eyedropper',
  'input',
  'random',
  'palette',
  'algorithm',
  'image',
  'ai',
  'traditional',
  'colorhunt',
  'gradient',
  'favorites',
  'history',
] as const

export type ColorHistorySource = (typeof COLOR_HISTORY_SOURCES)[number]

/** The image extractor's slider bounds; the AI namer receives the dominant color on top of these. */
export const COLOR_EXTRACT_MIN = 3
export const COLOR_EXTRACT_MAX = 12
export const COLOR_AI_INTERPRET_MAX = COLOR_EXTRACT_MAX + 1

/** How many colors an AI palette may ask for. */
export const COLOR_AI_PALETTE_MIN = 3
export const COLOR_AI_PALETTE_MAX = 8

/** Rows the history keeps, and the page size that shows them. */
export const COLOR_HISTORY_WINDOW = 100

/** A saved palette is capped here, so a gradient editor cannot outgrow what the API will accept. */
export const COLOR_PALETTE_MAX_COLORS = 20

/**
 * The color the studio, the server defaults and the "we have nothing yet" fallbacks all start from.
 *
 * It was written out seven times across three layers, which meant a change of default had to find all of
 * them — and the settings row had already drifted (the server answered `flat_ui` where the client kept
 * `flat`).
 */
export const DEFAULT_SEED_HEX = '#627486'

/**
 * The UI-palette tab a reader with no preference lands on.
 *
 * Both ends used to say `flat_ui`, which is not one of the tab keys — the setting was inert wherever it
 * was honored. Anything the stored value cannot match falls back to this.
 */
export const DEFAULT_UI_TAB = 'tailwind'

/**
 * Why a model-backed answer fell back to the algorithm.
 *
 * The reader needs this to know whether the palette on screen was designed or computed: a fallback that
 * arrives without a label is a feature reporting success while not running.
 */
export const AI_FALLBACK_REASONS = ['no_model', 'quota', 'timeout', 'aborted', 'upstream', 'malformed'] as const
export type AiFallbackReason = (typeof AI_FALLBACK_REASONS)[number]
