import { infoFlag, infoOption, infoTokens } from './info-string';

/**
 * The header vocabulary of the `:::` layout blocks.
 *
 * A block states everything about itself on its header line — the kind, then a few keywords — because
 * the header is the one line a settings toolbar can rewrite without touching the block's content. So
 * reading and writing it lives here as a pair, and the block rule only splits bodies.
 *
 * The keyword set is deliberately closed: an unrecognised `::: whatever` is not claimed, so it keeps
 * rendering as the plain text it always did rather than silently becoming a container.
 */

export type AlignValue = 'left' | 'center' | 'right' | 'justify';
export type ColsGap = 'narrow' | 'normal' | 'wide';

const ALIGN_WORDS: Record<string, AlignValue> = {
  left: 'left',
  l: 'left',
  center: 'center',
  c: 'center',
  right: 'right',
  r: 'right',
  justify: 'justify',
  j: 'justify',
};

/**
 * The words that open a layout block, in the order the editor offers them.
 *
 * Every surface that has to recognise a `:::` kind — the completion list, the Enter handler that
 * writes the matching closer, the title-and-excerpt reader — names this set separately, so it is
 * stated once here rather than four times that can drift.
 */
export const LAYOUT_CONTAINER_WORDS = ['cols', 'left', 'center', 'right', 'justify'] as const;

const GAP_WORDS: Record<string, ColsGap> = {
  narrow: 'narrow',
  tight: 'narrow',
  normal: 'normal',
  cozy: 'normal',
  wide: 'wide',
  loose: 'wide',
};

// A column track is a plain fraction or percentage. Anything else is left alone, so a typo can never
// reach the stylesheet as a CSS value — the enhancer that writes the custom property re-checks it.
const TRACK_PATTERN = /^\d{1,2}(?:\.\d{1,2})?(?:fr|%)$/;
export const MAX_PANEL_COLUMNS = 6;

export function isTrackValue(value: string): boolean {
  return TRACK_PATTERN.test(value);
}

/**
 * The one-click widths for a block of this many columns: one column made twice as wide as the rest,
 * at either end. Derived from the count rather than listed, so a fourth or sixth column is not left
 * with no preset at all, and every button offered keeps the reader's column count.
 */
export function colsRatioPresets(columns: number): string[] {
  if (columns < 2 || columns > MAX_PANEL_COLUMNS) return [];
  const run = (wideFirst: boolean): string => Array.from({ length: columns }, (_unused, index) =>
    (wideFirst ? index === 0 : index === columns - 1) ? '2' : '1').join(':');
  return [run(false), run(true)]
}

// A ratio is a colon-separated run of single digits, so `1:2` can never arrive at the stylesheet as
// anything but a fraction per column — and a reader who types `50:50` is told it means `1:1`.
const RATIO_PATTERN = /^(\d)(?::(\d))+$/;

/** The track list a `1:2` spelling describes, or null when the text is not a ratio. */
export function parseColsRatio(value: string): string | null {
  const text = value.trim();
  if (!RATIO_PATTERN.test(text)) return null;
  const parts = text.split(':');
  if (parts.length < 2 || parts.length > MAX_PANEL_COLUMNS) return null;
  if (parts.some((part) => part === '0')) return null;
  return parts.map((part) => `${part}fr`).join(' ');
}

/** The `1:2` spelling of a track list, or null when the tracks are not plain single-digit fractions. */
export function colsRatioLabel(tracks: string | null): string {
  if (!tracks) return '';
  const parts = tracks.trim().split(/\s+/);
  if (!parts.every((part) => /^\dfr$/.test(part))) return '';
  return parts.map((part) => part.slice(0, -2)).join(':');
}

export interface ColsOptions {
  /** Explicit track sizes, already validated; `null` lets the column count pick equal tracks. */
  tracks: string | null;
  /** A stated column count, which folds the `::` separators down to fit. */
  fixedCount: number | null;
  gap: ColsGap;
  divider: boolean;
  align: AlignValue | null;
}

export const COLS_OPTION_DEFAULTS: ColsOptions = { tracks: null, fixedCount: null, gap: 'normal', divider: false, align: null };

export type PanelHeaderMatch =
  | { kind: 'align'; align: AlignValue; markerLength: number }
  | { kind: 'cols'; cols: ColsOptions; markerLength: number };

function parseTrackTokens(tokens: string[]): string | null {
  if (tokens.length < 2 || tokens.length > MAX_PANEL_COLUMNS) return null;
  return tokens.every((token) => TRACK_PATTERN.test(token)) ? tokens.join(' ') : null;
}

function parseCols(rest: string): ColsOptions {
  const options: ColsOptions = { ...COLS_OPTION_DEFAULTS };
  const tracks: string[] = [];
  for (const token of infoTokens(rest)) {
    const option = infoOption(token);
    const flag = infoFlag(token);
    if (TRACK_PATTERN.test(flag)) {
      tracks.push(flag);
      continue;
    }
    const align = ALIGN_WORDS[option?.key === 'align' ? option.value.toLowerCase() : flag];
    if (align) {
      options.align = align;
      continue;
    }
    const gap = GAP_WORDS[option?.key === 'gap' ? option.value.toLowerCase() : flag];
    if (gap) {
      options.gap = gap;
      continue;
    }
    if (flag === 'divider') {
      options.divider = true;
      continue;
    }
    if (option?.key === 'cols' && /^\d{1,2}$/.test(option.value)) {
      const count = Number(option.value);
      if (count >= 1 && count <= MAX_PANEL_COLUMNS) options.fixedCount = count;
      continue;
    }
    if (/^\d{1,2}$/.test(flag)) {
      const count = Number(flag);
      if (count >= 1 && count <= MAX_PANEL_COLUMNS) options.fixedCount = count;
    }
  }
  options.tracks = parseTrackTokens(tracks);
  return options;
}

/**
 * The header line's colon count and configuration, or null when the line is not one of the layout
 * blocks. A `2cols` spelling is accepted as the count it abbreviates.
 */
export function matchPanelHeader(source: string): PanelHeaderMatch | null {
  const match = /^(:{3,})[ \t]*([^\s{][^\n]*?)[ \t]*$/.exec(source);
  if (!match) return null;
  const markerLength = match[1]!.length;
  const info = match[2]!;
  const tokens = infoTokens(info);
  const keyword = tokens[0] ?? '';
  const rest = info.slice(keyword.length).trim();
  const legacyCount = /^([2-6])cols$/i.exec(keyword);
  if (legacyCount) return { kind: 'cols', markerLength, cols: parseCols(`${legacyCount[1]} ${rest}`) };
  if (keyword.toLowerCase() === 'cols') return { kind: 'cols', markerLength, cols: parseCols(rest) };
  const align = ALIGN_WORDS[keyword.toLowerCase()];
  if (align) return { kind: 'align', markerLength, align };
  return null;
}

/**
 * The tokens after the kind word, in the order the settings panel offers them; defaults are dropped.
 *
 * A stated count is kept alongside a track list rather than hidden by it: the count is what makes an
 * empty column real, since a body with nothing after its last `::` reads back one column short.
 */
export function formatColsOptions(options: ColsOptions): string {
  const parts: string[] = [];
  if (options.fixedCount && options.fixedCount !== 1) parts.push(String(options.fixedCount));
  if (options.tracks) parts.push(options.tracks);
  if (options.gap !== COLS_OPTION_DEFAULTS.gap) parts.push(`gap=${options.gap}`);
  if (options.divider) parts.push('divider');
  if (options.align) parts.push(options.align);
  return parts.join(' ');
}

/** The header line for a column block. */
export function formatColsHeader(options: ColsOptions, markerLength: number): string {
  const suffix = formatColsOptions(options);
  return suffix ? `${':'.repeat(markerLength)} cols ${suffix}` : `${':'.repeat(markerLength)} cols`;
}

/** The header line for an alignment block. */
export function formatAlignHeader(align: AlignValue, markerLength: number): string {
  return `${':'.repeat(markerLength)} ${align}`;
}

export type TabsPosition = 'top' | 'bottom' | 'left' | 'right';

export interface TabsOptions {
  style: 'horizontal' | 'vertical';
  variant: 'default' | 'pills' | 'cards' | 'minimal';
  align: 'start' | 'center' | 'end' | 'stretch';
  /** Which edge the tab strip sits on; unset follows the style default (top / left). */
  position?: TabsPosition;
  /** Coordination group: tab blocks sharing the same id switch together and remember the choice. */
  sync?: string;
}

export const TABS_OPTION_DEFAULTS: TabsOptions = { style: 'horizontal', variant: 'default', align: 'start' };

// Sync ids travel into a data attribute, into a localStorage key and into source text, so only an
// URL-safe token is accepted.
const TABS_SYNC_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

export function isValidTabsSync(value: string): boolean {
  return TABS_SYNC_PATTERN.test(value);
}

// Position is the single layout knob: an explicit edge implies the matching orientation, so an older
// `style=vertical` note (no position yet) keeps rendering on the left edge.
export function effectiveTabsPosition(options: { style: TabsOptions['style']; position?: TabsPosition }): TabsPosition {
  if (options.position) return options.position;
  return options.style === 'vertical' ? 'left' : 'top';
}

export function isVerticalTabsPosition(position: TabsPosition): boolean {
  return position === 'left' || position === 'right';
}

function normalizeTabsPosition(val: string): TabsPosition | undefined {
  const positionMap: Record<string, TabsPosition> = { top: 'top', bottom: 'bottom', left: 'left', right: 'right' };
  return positionMap[val];
}

function applyTabsOption(options: TabsOptions, key: string, rawVal: string): void {
  if (key === 'style' || key === 'orientation') {
    const val = rawVal.toLowerCase();
    if (val === 'vertical' || val === 'horizontal') options.style = val;
    return;
  }
  if (key === 'variant') {
    const val = rawVal.toLowerCase();
    if (['default', 'pills', 'cards', 'minimal'].includes(val)) options.variant = val as TabsOptions['variant'];
    return;
  }
  if (key === 'align') {
    const alignMap: Record<string, TabsOptions['align']> = {
      start: 'start',
      left: 'start',
      center: 'center',
      end: 'end',
      right: 'end',
      stretch: 'stretch',
      full: 'stretch',
    };
    const resolved = alignMap[rawVal.toLowerCase()];
    if (resolved) options.align = resolved;
    return;
  }
  if (key === 'position' || key === 'placement') {
    const resolved = normalizeTabsPosition(rawVal.toLowerCase());
    if (resolved) options.position = resolved;
    return;
  }
  if (key === 'sync' || key === 'group') {
    const val = rawVal.replace(/^["']|["']$/g, '').trim();
    if (isValidTabsSync(val)) options.sync = val;
  }
}

function applyTabsFlag(options: TabsOptions, flag: string): void {
  if (flag === 'vertical' || flag === 'horizontal') {
    options.style = flag;
    return;
  }
  if (['pills', 'cards', 'minimal'].includes(flag)) {
    options.variant = flag as TabsOptions['variant'];
    return;
  }
  if (flag === 'center' || flag === 'stretch') {
    options.align = flag as TabsOptions['align'];
    return;
  }
  const position = normalizeTabsPosition(flag);
  if (position) options.position = position;
}

export function parseTabsOptions(info: string): TabsOptions {
  const options: TabsOptions = { ...TABS_OPTION_DEFAULTS };
  const trimmed = info.trim();
  if (!trimmed) return options;
  for (const token of trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []) {
    const clean = token.replace(/^["']|["']$/g, '').trim();
    const eqIdx = clean.indexOf('=');
    if (eqIdx === -1) {
      applyTabsFlag(options, clean.toLowerCase());
      continue;
    }
    const key = clean.slice(0, eqIdx).toLowerCase().trim();
    // Sync ids are case-sensitive identifiers; every other option is a lowercase enum keyword.
    const rawVal = key === 'sync' || key === 'group'
      ? clean.slice(eqIdx + 1).trim()
      : clean.slice(eqIdx + 1).trim().toLowerCase().replace(/^["']|["']$/g, '').trim();
    applyTabsOption(options, key, rawVal);
  }
  return options;
}
