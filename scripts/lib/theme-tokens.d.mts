/**
 * The contract of `theme-tokens.mjs`, the reader that judges colours from the declared token text
 * before anything paints them. `themeVars` and `accentVars` hand back the cascade a browser would
 * apply — base `:root`, then the theme block, then, for the background the caller asks about, that
 * theme's white-background override — so a gate comparing tokens sees the same last-wins order the
 * page does. `paper` is the palette a reader gets by default and `white` the opt-in; the default is
 * `white` because the text-ladder gates were all measured against it.
 */

export declare const TOKENS_PATH: 'src/client/styles/tokens.css'

export type ThemeName = 'light' | 'dark'

/** The two backgrounds a theme paints: the default palette and the `data-background='white'` opt-in. */
export declare const BACKGROUNDS: readonly ['paper', 'white']

export type BackgroundName = 'paper' | 'white'

/** The variables one theme resolves to, in cascade order. Throws when the sheet lacks a block it expects. */
export declare function themeVars(theme: ThemeName, source: string, background?: BackgroundName): Map<string, string>

/** Every accent the stylesheet offers, in declaration order and without repeats. */
export declare function accentNames(source: string): string[]

/** One accent's variables over one theme, for a gate that has to hold for every choice the user can make. */
export declare function accentVars(theme: ThemeName, accent: string, source: string, background?: BackgroundName): Map<string, string>
