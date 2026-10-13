/**
 * The reading surface's palettes.
 *
 * A book page is the one place in this app where the reader chooses the colours rather than the
 * deployment, so the themes are their own layer: they paint the page, not the chrome around it. Each
 * one carries the pair the page actually needs (paper and ink) plus the two tints that follow from
 * them, and `auto` hands the decision back to the app's own theme.
 *
 * Every entry is checked for contrast by `tests/reading-theme-contrast.test.ts`, because a warm-paper
 * theme that quietly drops to 3.1:1 is the kind of regression nobody notices until they read a whole
 * chapter with a headache.
 */
export type ReaderThemeName =
  | 'auto'
  | 'paper'
  | 'warm'
  | 'celadon'
  | 'moon'
  | 'xuan'
  | 'fog'
  | 'night'
  | 'ink'
  | 'eink'

export interface ReaderTheme {
  name: ReaderThemeName
  /** CSS colour the page is painted with. */
  background: string
  /** CSS colour the prose is painted with. */
  foreground: string
  /** A quieter version of the ink, for page numbers and metadata. */
  muted: string
  /** The tint a highlight or an active control borrows. */
  accent: string
  /** True when the page is dark, which decides the shadow and the selection blend. */
  dark: boolean
}

export const READER_THEMES: Record<Exclude<ReaderThemeName, 'auto'>, ReaderTheme> = {
  paper: { name: 'paper', background: '#ffffff', foreground: '#1c1c1a', muted: '#6f6f68', accent: '#b4623a', dark: false },
  warm: { name: 'warm', background: '#f6efe2', foreground: '#33291d', muted: '#7a6a55', accent: '#a8642f', dark: false },
  celadon: { name: 'celadon', background: '#e7f0ea', foreground: '#22332b', muted: '#5f7a6d', accent: '#2f7d5c', dark: false },
  moon: { name: 'moon', background: '#eef1f7', foreground: '#232833', muted: '#646c7d', accent: '#4a5f9c', dark: false },
  xuan: { name: 'xuan', background: '#f4ece0', foreground: '#2e2419', muted: '#7c6a53', accent: '#8c5a2b', dark: false },
  fog: { name: 'fog', background: '#dfe7ee', foreground: '#22303b', muted: '#5d7080', accent: '#31698c', dark: false },
  night: { name: 'night', background: '#1b1d21', foreground: '#c9c6bd', muted: '#8a8880', accent: '#d08b5a', dark: true },
  ink: { name: 'ink', background: '#0d0f12', foreground: '#b9bcc2', muted: '#767a81', accent: '#9fb6d4', dark: true },
  // Pure black on pure white, with no tint anywhere: on an e-paper panel every grey is a dithering
  // pattern, and a warm paper reads as noise. 21:1 is the ceiling the contrast test allows.
  eink: { name: 'eink', background: '#ffffff', foreground: '#000000', muted: '#3a3a3a', accent: '#000000', dark: false },
}

export const READER_THEME_ORDER: readonly Exclude<ReaderThemeName, 'auto'>[] = [
  'paper', 'warm', 'celadon', 'moon', 'xuan', 'fog', 'night', 'ink', 'eink',
]

export const DEFAULT_HIGHLIGHT_PAINT: Record<string, string> = {
  yellow: 'rgba(255, 206, 64, 0.45)',
  green: 'rgba(118, 214, 108, 0.42)',
  blue: 'rgba(96, 165, 250, 0.42)',
  pink: 'rgba(248, 123, 168, 0.42)',
  red: 'rgba(245, 168, 160, 0.42)',
  purple: 'rgba(213, 184, 255, 0.42)',
}

/** The theme a page should be painted with, given the choice and the app's own appearance. */
export function resolveReaderTheme(name: ReaderThemeName, appDark: boolean): ReaderTheme {
  if (name !== 'auto') return READER_THEMES[name]
  return appDark ? READER_THEMES.night : READER_THEMES.paper
}
