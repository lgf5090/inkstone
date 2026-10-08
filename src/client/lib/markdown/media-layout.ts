import { braceTokens, infoFlag, infoOption, infoTokens, isBraceGroup } from './info-string';

/**
 * The store behind a `::: media` layout block.
 *
 * A block says everything about itself on one header line and each row says everything about itself
 * in a trailing `{…}` group, because those are the only two places a settings toolbar or a drag can
 * rewrite without touching the author's embeds. The embeds themselves are never rewritten, only read
 * and rendered where they were written, so a rename, a move or a hand edit of the picture text can
 * never be clobbered by a layout change.
 *
 * The same shape holds when the feature is switched off: the note keeps ordinary embed lines, and the
 * header and row groups are what an unwrap command deletes.
 */

export type MediaWrap = 'left' | 'right';
export type MediaAlign = 'left' | 'center' | 'right';
export type MediaFit = 'fill' | 'contain' | 'cover' | 'none';
export type MediaGap = 'narrow' | 'normal' | 'wide';
export type MediaRadius = 'none' | 'sm' | 'md' | 'lg' | 'full';

export interface MediaBlockOptions {
  /** The side the note's own text wraps around; null keeps the block in the flow. */
  wrap: MediaWrap | null;
  /** Share of the text column, 20–100. Null fills the column. */
  width: number | null;
  gap: MediaGap;
  align: MediaAlign;
  fit: MediaFit;
  /** `16:9` style aspect lock, or null for each picture's own shape. */
  ratio: string | null;
  border: boolean;
  shadow: boolean;
  radius: MediaRadius;
  /** Whether a caption written on the embed is shown. */
  caption: boolean;
  captionAlign: 'left' | 'center';
  /** Number every captioned picture and let `@fig:` point at it. */
  numbered: boolean;
  /** Flow the pictures into this many columns per row, ignoring how the source groups its lines. */
  columns: number | null;
}

export const MEDIA_BLOCK_DEFAULTS: MediaBlockOptions = {
  wrap: null,
  width: null,
  gap: 'normal',
  align: 'center',
  fit: 'contain',
  ratio: null,
  border: false,
  shadow: false,
  radius: 'md',
  caption: true,
  captionAlign: 'center',
  numbered: false,
  columns: null,
};

export interface MediaRowOptions {
  /** One weight per picture; a short list is padded with 1 by the caller. */
  weights: number[];
  /** Row height in pixels, or null to follow the pictures' own shape. */
  height: number | null;
  align: MediaAlign | null;
}

export const MEDIA_ROW_DEFAULTS: MediaRowOptions = { weights: [], height: null, align: null };
export const MEDIA_MIN_ROW_HEIGHT = 60;
export const MEDIA_MAX_ROW_HEIGHT = 1200;
export const MEDIA_DEFAULT_ROW_HEIGHT = 260;
/**
 * How many pictures one row line may hold.
 *
 * Only lines the author already put inside a layout block — or selected for the wrap command — are ever
 * read as a row, so this is a ceiling on what the layout machinery will build, not a guess about whether
 * a sentence full of pictures meant to be a gallery. Twelve covers the rows people actually typeset (a
 * film strip, a year of thumbnails); past it a line is a paragraph, and the weight list a drag writes
 * would be longer than the row is readable.
 */
export const MEDIA_MAX_CELLS_PER_ROW = 12;
export const MEDIA_MIN_WIDTH = 20;
export const MEDIA_MAX_WIDTH = 100;
export const MEDIA_MAX_COLUMNS = 4;
export const MEDIA_GAP_PX: Record<MediaGap, number> = { narrow: 6, normal: 14, wide: 28 };

export interface MediaCell {
  /** The embed exactly as the author wrote it; emitted for rendering, never rewritten. */
  raw: string;
  kind: 'image' | 'video' | 'other';
  /** The file or URL the embed points at, without size, alias or title. */
  target: string;
  /** A cross-reference name for this picture, from a trailing `{#fig:name}` or a title that carries one. */
  figId: string | null;
  /** A caption the block has to draw itself, because the embed syntax carries no title. */
  caption: string | null;
  /** Whether the rendered embed brings its own `<figcaption>`. */
  nativeCaption: boolean;
}

export interface MediaRow {
  cells: MediaCell[];
  options: MediaRowOptions;
  /** The line with its trailing group removed, kept so a rewrite can restore it byte for byte. */
  body: string;
}

const IMAGE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp']);
const VIDEO_EXTENSIONS = new Set(['mkv', 'mov', 'mp4', 'ogv', 'webm', 'm4v']);

// The reference grammar this port keeps: a wiki embed, or a Markdown image whose destination is
// <…> or allows one level of parentheses, with an optional title.
const EMBED_PATTERN = /!\[\[[^\]\n]{1,400}\]\]|!\[(?:[^\]\\]|\\.)*\]\(\s*(?:<[^>\n]*>|(?:[^()\s]|\([^()\s]*\))*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
const FIG_ID_PATTERN = /\{\s*#(?:fig|figure):([A-Za-z0-9][A-Za-z0-9_-]{0,63})\s*\}/;
const FIG_ID_PATTERN_GLOBAL = /\{\s*#(?:fig|figure):[A-Za-z0-9][A-Za-z0-9_-]{0,63}\s*\}/g;
const ROW_GROUP_AT_END = /[ \t]*\{([^{}\n]*)\}[ \t]*$/;
const LEADING_GROUP = /^[ \t]*\{\s*#(?:fig|figure):[A-Za-z0-9][A-Za-z0-9_-]{0,63}\s*\}/;
const WIKI_TARGET = /^!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$/;
// Group 1 is a `<…>` destination, 2 a bare one, 3 and 4 the two quote spellings of a title. The bare
// destination is one capture around a repeated alternation, so a name with parentheses in it stays one
// string rather than ending as the last character that matched.
const MARKDOWN_DEST = /^!\[(?:[^\]\\]|\\.)*\]\(\s*(?:<([^>\n]*)>|((?:[^()\s]|\([^()\s]*\))*)(?:\s+(?:"([^"\n]*)"|'([^'\n]*)'))?)\s*\)$/;
const SIZE_ONLY = /^[0-9]+(?:[xX][0-9]+)?$/;
const RATIO_PATTERN = /^\d{1,2}:\d{1,2}$/;

const WRAP_WORDS: Record<string, MediaWrap> = { left: 'left', right: 'right' };
const GAP_WORDS: Record<string, MediaGap> = { narrow: 'narrow', tight: 'narrow', normal: 'normal', wide: 'wide', loose: 'wide' };
const FIT_WORDS: Record<string, MediaFit> = { fill: 'fill', contain: 'contain', cover: 'cover', none: 'none', natural: 'none' };
const RADIUS_WORDS: Record<string, MediaRadius> = { none: 'none', sm: 'sm', md: 'md', lg: 'lg', full: 'full', round: 'full' };

export function isImageTarget(target: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(target));
}

function extensionOf(target: string): string {
  const name = target.split(/[\\/]/).pop()?.split(/[?#]/)[0] ?? '';
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function mediaKind(target: string): MediaCell['kind'] {
  const extension = extensionOf(target);
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  return 'other';
}

/** The clamped integer a drag or a button asked for, or null when the text was not a size. */
export function clampWidth(value: number): number {
  return Math.round(Math.min(MEDIA_MAX_WIDTH, Math.max(MEDIA_MIN_WIDTH, value)));
}

export function clampRowHeight(value: number): number {
  return Math.round(Math.min(MEDIA_MAX_ROW_HEIGHT, Math.max(MEDIA_MIN_ROW_HEIGHT, value)));
}

/** A weight list long enough for this many pictures, with anything unusable replaced by 1. */
export function rowWeights(weights: readonly number[], cells: number): number[] {
  const clean = (index: number): number => {
    const value = weights[index];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 1;
    return Math.round(Math.min(20, Math.max(0.1, value)) * 10) / 10;
  };
  return Array.from({ length: Math.max(1, cells) }, (_unused, index) => clean(index));
}

function parseRatio(value: string): string | null {
  const match = /^(\d{1,2})\s*[:xX]\s*(\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 1 || height < 1) return null;
  return `${width}:${height}`;
}

function parseWidthValue(value: string): number | null {
  const trimmed = value.trim().replace(/%$/, '');
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  const width = Number(trimmed);
  return width >= MEDIA_MIN_WIDTH && width <= MEDIA_MAX_WIDTH ? width : null;
}

function parseWeightList(value: string): number[] | null {
  const parts = value.split(/[:/,]/).filter((part) => part !== '');
  if (parts.length < 1 || parts.length > MEDIA_MAX_CELLS_PER_ROW) return null;
  const weights: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,2}(?:\.\d{1,2})?$/.test(part.trim())) return null;
    const weight = Number(part.trim());
    if (weight <= 0) return null;
    weights.push(Math.round(weight * 10) / 10);
  }
  return weights;
}

function applyBlockOption(options: MediaBlockOptions, key: string, rawValue: string): boolean {
  const value = rawValue.toLowerCase();
  if (key === 'wrap') {
    const wrap = value === 'none' || value === 'off' ? null : WRAP_WORDS[value];
    if (wrap === undefined && value !== 'none' && value !== 'off') return false;
    options.wrap = wrap ?? null;
    return true;
  }
  if (key === 'width') {
    const width = parseWidthValue(rawValue);
    if (width === null) return false;
    options.width = width;
    return true;
  }
  if (key === 'gap') {
    const gap = GAP_WORDS[value];
    if (!gap) return false;
    options.gap = gap;
    return true;
  }
  if (key === 'align') {
    const align = value === 'justify' ? 'left' : alignOf(value);
    if (!align) return false;
    options.align = align;
    return true;
  }
  if (key === 'fit' || key === 'crop') {
    const fit = FIT_WORDS[value];
    if (!fit) return false;
    options.fit = fit;
    return true;
  }
  if (key === 'ratio') {
    if (value === 'none' || value === 'auto' || value === 'off') {
      options.ratio = null;
      return true;
    }
    const ratio = parseRatio(rawValue);
    if (!ratio) return false;
    options.ratio = ratio;
    return true;
  }
  if (key === 'radius' || key === 'round') {
    const radius = RADIUS_WORDS[value];
    if (!radius) return false;
    options.radius = radius;
    return true;
  }
  if (key === 'caption') {
    if (value === 'on' || value === 'show') options.caption = true;
    else if (value === 'off' || value === 'hide') options.caption = false;
    else return false;
    return true;
  }
  if (key === 'caption-align' || key === 'capalign') {
    if (value !== 'left' && value !== 'center') return false;
    options.captionAlign = value;
    return true;
  }
  if (key === 'number' || key === 'numbered') {
    if (value === 'on' || value === 'true') options.numbered = true;
    else if (value === 'off' || value === 'false') options.numbered = false;
    else return false;
    return true;
  }
  if (key === 'cols' || key === 'columns') {
    if (value === 'none' || value === 'auto') {
      options.columns = null;
      return true;
    }
    if (!/^[1-4]$/.test(value)) return false;
    options.columns = Number(value);
    return true;
  }
  if (key === 'border' || key === 'frame') {
    const on = onOff(value);
    if (on === null) return false;
    options.border = on;
    return true;
  }
  if (key === 'shadow') {
    const on = onOff(value);
    if (on === null) return false;
    options.shadow = on;
    return true;
  }
  return false;
}

function onOff(value: string): boolean | null {
  if (value === 'on' || value === 'true' || value === 'yes') return true;
  if (value === 'off' || value === 'false' || value === 'no') return false;
  return null;
}

function alignOf(value: string): MediaAlign | null {
  return value === 'left' || value === 'center' || value === 'right' ? value : null;
}

function applyBlockFlag(options: MediaBlockOptions, flag: string): boolean {
  if (flag === 'border' || flag === 'framed') {
    options.border = true;
    return true;
  }
  if (flag === 'shadow') {
    options.shadow = true;
    return true;
  }
  if (flag === 'rounded') {
    options.radius = 'lg';
    return true;
  }
  if (flag === 'square') {
    options.radius = 'none';
    return true;
  }
  if (flag === 'numbered' || flag === 'number') {
    options.numbered = true;
    return true;
  }
  if (flag === 'no-caption' || flag === 'nocaption') {
    options.caption = false;
    return true;
  }
  if (flag === 'cover' || flag === 'contain' || flag === 'fill') {
    options.fit = FIT_WORDS[flag]!;
    return true;
  }
  const wrap = WRAP_WORDS[flag];
  if (wrap) {
    options.wrap = wrap;
    return true;
  }
  const align = alignOf(flag);
  if (align) {
    options.align = align;
    return true;
  }
  const gap = GAP_WORDS[flag];
  if (gap) {
    options.gap = gap;
    return true;
  }
  const radius = RADIUS_WORDS[flag];
  if (radius) {
    options.radius = radius;
    return true;
  }
  if (/^\d{1,3}%$/.test(flag)) {
    const width = parseWidthValue(flag);
    if (width !== null) options.width = width;
    return width !== null;
  }
  if (RATIO_PATTERN.test(flag)) {
    const ratio = parseRatio(flag);
    if (ratio) options.ratio = ratio;
    return ratio !== null;
  }
  if (/^[1-4]$/.test(flag)) {
    options.columns = Number(flag);
    return true;
  }
  return false;
}

/**
 * The header's configuration, after the `media` keyword.
 *
 * An option nobody recognises is left alone rather than failing the block: `::: media alt=on` has to
 * keep laying out its pictures, because throwing the whole block away would punish the author for a
 * typo in one word.
 */
export function parseMediaOptions(info: string): MediaBlockOptions {
  const options: MediaBlockOptions = { ...MEDIA_BLOCK_DEFAULTS };
  for (const raw of infoTokens(info)) {
    const tokens = isBraceGroup(raw) ? braceTokens(raw) : [raw];
    for (const token of tokens) {
      const option = infoOption(token);
      if (option) {
        applyBlockOption(options, option.key, option.value);
        continue;
      }
      applyBlockFlag(options, infoFlag(token));
    }
  }
  return options;
}

/** The header's tokens with one option changed; defaults are left out so the line stays short. */
export function formatMediaOptions(options: MediaBlockOptions): string {
  const parts: string[] = [];
  if (options.wrap) parts.push(`wrap=${options.wrap}`);
  if (options.width !== null) parts.push(`width=${options.width}%`);
  if (options.columns !== null) parts.push(`cols=${options.columns}`);
  if (options.gap !== MEDIA_BLOCK_DEFAULTS.gap) parts.push(`gap=${options.gap}`);
  if (options.align !== MEDIA_BLOCK_DEFAULTS.align) parts.push(`align=${options.align}`);
  if (options.fit !== MEDIA_BLOCK_DEFAULTS.fit) parts.push(`fit=${options.fit}`);
  if (options.ratio) parts.push(`ratio=${options.ratio}`);
  if (options.radius !== MEDIA_BLOCK_DEFAULTS.radius) parts.push(`radius=${options.radius}`);
  if (options.border) parts.push('border');
  if (options.shadow) parts.push('shadow');
  if (!options.caption) parts.push('no-caption');
  if (options.captionAlign !== MEDIA_BLOCK_DEFAULTS.captionAlign) parts.push(`caption-align=${options.captionAlign}`);
  if (options.numbered) parts.push('numbered');
  return parts.join(' ');
}

export function formatMediaHeader(options: MediaBlockOptions, markerLength: number): string {
  const suffix = formatMediaOptions(options);
  const marker = ':'.repeat(markerLength);
  return suffix ? `${marker} media ${suffix}` : `${marker} media`;
}

/**
 * The embeds on a line, in order, or null when the line holds anything besides them.
 *
 * A picture's own `{#fig:name}` is allowed to sit between them: it belongs to the picture rather than to
 * the line, and `parseMediaRow` is the one that hands it to the right cell.
 */
export function readEmbedRow(line: string): string[] | null {
  const pattern = new RegExp(EMBED_PATTERN.source, 'g');
  const spans: string[] = [];
  let cursor = 0;
  let rest = '';
  for (const match of line.matchAll(pattern)) {
    const from = match.index ?? 0;
    rest += line.slice(cursor, from);
    spans.push(match[0]);
    cursor = from + match[0].length;
  }
  rest += line.slice(cursor);
  if (!spans.length) return null;
  return rest.replace(FIG_ID_PATTERN_GLOBAL, '').trim() === '' ? spans : null;
}

function decodeWikiAlias(alias: string): string {
  return alias.trim();
}

function cellFromRaw(raw: string): MediaCell {
  const fig = FIG_ID_PATTERN.exec(raw);
  const cleaned = fig ? raw.replace(FIG_ID_PATTERN, '') : raw;
  const wiki = WIKI_TARGET.exec(cleaned.trim());
  const markdown = wiki ? null : MARKDOWN_DEST.exec(cleaned.trim());
  let target = cleaned;
  let caption: string | null = null;
  let nativeCaption = false;
  if (wiki) {
    target = (wiki[1] ?? '').trim();
    const alias = wiki[2];
    if (alias !== undefined && !SIZE_ONLY.test(alias.trim())) caption = decodeWikiAlias(alias) || null;
  }
  else if (markdown) {
    target = (markdown[1] ?? markdown[2] ?? '').trim();
    const title = markdown[3] ?? markdown[4] ?? '';
    if (title.trim()) {
      caption = title.trim();
      nativeCaption = true;
    }
  }
  return {
    raw: cleaned,
    kind: mediaKind(target),
    target,
    figId: fig ? fig[1]! : null,
    caption,
    nativeCaption,
  };
}

/** The row a body line spells, or null when the line is not made of embeds only. */
export function parseMediaRow(line: string): MediaRow | null {
  const text = line.replace(/\r$/, '');
  let rowGroup = '';
  let body = text;
  const trailing = ROW_GROUP_AT_END.exec(text);
  // A trailing `{…}` is the row's own configuration unless it opens with `#`, which is how a picture
  // declares the name a `@fig:` reference points at.
  if (trailing && !/^\s*#/.test(trailing[1] ?? '')) {
    rowGroup = trailing[1]!;
    body = text.slice(0, trailing.index);
  }
  const spans = readEmbedRow(body);
  if (!spans) return null;

  const cells: MediaCell[] = [];
  let rest = body;
  for (const span of spans) {
    const at = rest.indexOf(span);
    if (at < 0) return null;
    const after = rest.slice(at + span.length);
    const attached = LEADING_GROUP.exec(after);
    const raw = attached ? span + attached[0] : span;
    cells.push(cellFromRaw(raw));
    rest = attached ? after.slice(attached[0].length) : after;
  }
  if (rest.trim() !== '') return null;
  if (cells.length > MEDIA_MAX_CELLS_PER_ROW) return null;

  const options = parseMediaRowOptions(rowGroup, cells.length);
  return { cells, options, body: body.replace(/[ \t]+$/, '') };
}

export function parseMediaRowOptions(group: string, cells: number): MediaRowOptions {
  const options: MediaRowOptions = { weights: [], height: null, align: null };
  for (const token of infoTokens(group)) {
    const option = infoOption(token);
    const flag = infoFlag(token);
    if (option) {
      const key = option.key;
      const value = option.value.toLowerCase();
      if (key === 'w' || key === 'weights') {
        const weights = parseWeightList(value);
        if (weights) options.weights = rowWeights(weights, cells);
      }
      else if (key === 'h' || key === 'height') {
        if (/^\d{2,4}$/.test(value.trim())) options.height = clampRowHeight(Number(value.trim()));
      }
      else if (key === 'align') options.align = alignOf(value);
      continue;
    }
    if (/^\d{2,4}$/.test(flag)) {
      options.height = clampRowHeight(Number(flag));
      continue;
    }
    const align = alignOf(flag);
    if (align) options.align = align;
  }
  return { ...options, weights: options.weights.length ? rowWeights(options.weights, cells) : [] };
}

/** Whether a row's settings say anything beyond the defaults, which is what makes it worth writing. */
export function mediaRowHasOptions(options: MediaRowOptions): boolean {
  return options.height !== null || options.align !== null || options.weights.length > 1;
}

export function formatMediaRowGroup(options: MediaRowOptions): string {
  const parts: string[] = [];
  if (options.weights.length > 1) parts.push(`w=${options.weights.join(':')}`);
  if (options.height !== null) parts.push(`h=${options.height}`);
  if (options.align) parts.push(`align=${options.align}`);
  return parts.length ? `{${parts.join(' ')}}` : '';
}

/**
 * The row line for these settings, with every embed left exactly as it was written.
 *
 * The trailing group is replaced rather than appended, so a row keeps one group and a hand-written
 * `{h=…}` survives a width drag that never mentioned a height. A weight list is trimmed or padded to the
 * pictures the row really holds, and dropped when one picture holds nothing to share.
 */
export function formatMediaRowLine(line: string, options: MediaRowOptions): string {
  const row = parseMediaRow(line);
  if (!row) return line;
  const weights = options.weights.length ? rowWeights(options.weights, row.cells.length) : [];
  const group = formatMediaRowGroup({ ...options, weights: weights.length > 1 ? weights : [] });
  return group ? `${row.body} ${group}` : row.body;
}

/** The row's own line with its trailing group stripped; the embeds stay byte for byte. */
export function stripMediaRowGroup(line: string): string {
  const row = parseMediaRow(line);
  return row ? row.body : line;
}
