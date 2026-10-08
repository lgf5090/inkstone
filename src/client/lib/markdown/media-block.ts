import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';
import { blockLine } from './colon-fence';
import { attachCrossrefName, nextCrossrefNumber } from './crossref';
import type { CrossrefRegistry } from './crossref';
import { parseMediaRow } from './media-layout';
import type { MediaBlockOptions, MediaCell, MediaRowOptions } from './media-layout';

/**
 * The block half of a `::: media` layout: what the body lines mean, and what tokens they become.
 *
 * A row is one source line, and a line only counts as a row when every character on it belongs to an
 * embed or to that row's own `{…}` group. Anything else — a stray word, a half-typed reference — makes
 * the whole block *not a layout*, and the author's text is tokenized as ordinary Markdown instead. That
 * is the difference between a layout block and a trap: the picture lines the note already had keep
 * behaving the way they did before the block existed, and a mistake shows up as plain text rather than
 * as a picture that vanished.
 *
 * The pictures themselves are handed to the inline parser verbatim, so a rename, a size suffix or an
 * alias the author wrote survives every layout edit untouched.
 */

export interface MediaCellToken {
  cell: MediaCell;
  index: number;
  line: number;
  /** The figure number this cell is, when the block numbers its figures. */
  figure: number | null;
  /** Whether the block shows captions at all, read off its header when the block was parsed. */
  captionShown: boolean;
}

export interface MediaRowToken {
  options: MediaRowOptions;
  cells: number;
  line: number;
  /** Which row of the block this is, so a toolbar can address it after the block moves. */
  index: number;
}

/** The rows a body spells, the lines that were text, and whether the two are mixed. */
interface MediaScan {
  rows: Array<{ line: number, options: MediaRowOptions, cells: MediaCell[] }>;
  /**
   * A body that holds both pictures and prose gives up its layout claim: the author's Markdown is then
   * tokenized as it always was, rather than half-eaten by a block that could not say what it meant.
   */
  broken: boolean;
}

function scanMediaBody(state: StateBlock, start: number, end: number): MediaScan {
  const rows: MediaScan['rows'] = [];
  let textLines = 0;
  for (let line = start; line < end; line++) {
    const text = blockLine(state, line);
    if (!text.trim()) continue;
    const row = parseMediaRow(text);
    if (row) rows.push({ line, options: row.options, cells: row.cells });
    else textLines++;
  }
  return { rows, broken: rows.length > 0 && textLines > 0 };
}

/**
 * Whether this block numbers its figures: asked for on the header, or stated by a picture that gives
 * itself a `@fig:` name. An author who names a figure expects it to be numbered whether or not the
 * block was written with `numbered`, and a half-finished reference is worse than either choice.
 */
export function mediaNumbersFigures(options: MediaBlockOptions, rows: ReadonlyArray<{ cells: MediaCell[] }>): boolean {
  if (options.numbered) return true;
  return rows.some((row) => row.cells.some((cell) => cell.figId !== null));
}

/**
 * The tokens for one `::: media` body.
 *
 * With rows, the block is a gallery: every row becomes a grid and every embed a cell. Without any, the
 * body is a text frame — the same floated, width-capped box, holding the author's own Markdown — which
 * is what makes `::: media wrap=left` a sidebar rather than a broken gallery.
 */
export function renderMediaContainer(
  state: StateBlock,
  startLine: number,
  end: number,
  nextLine: number,
  options: MediaBlockOptions,
  crossrefs: CrossrefRegistry,
): void {
  const scan = scanMediaBody(state, startLine + 1, end);
  if (scan.broken) {
    state.md.block.tokenize(state, startLine + 1, end);
    return;
  }
  const numbered = mediaNumbersFigures(options, scan.rows);

  const open = state.push('media_open', 'div', 1);
  open.block = true;
  open.map = [startLine, nextLine];
  open.meta = { options, numbered, rows: scan.rows.length } satisfies { options: MediaBlockOptions, numbered: boolean, rows: number };

  if (!scan.rows.length) {
    state.md.block.tokenize(state, startLine + 1, end);
    state.push('media_close', 'div', -1).block = true;
    return;
  }

  scan.rows.forEach((row, rowIndex) => {
    const rowOpen = state.push('media_row_open', 'div', 1);
    rowOpen.block = true;
    rowOpen.map = [row.line, row.line + 1];
    rowOpen.meta = { options: row.options, cells: row.cells.length, line: row.line, index: rowIndex } satisfies MediaRowToken;
    row.cells.forEach((cell, cellIndex) => {
      let figure: number | null = null;
      if (numbered && (cell.caption || cell.figId)) {
        figure = nextCrossrefNumber(crossrefs, 'fig');
        if (cell.figId) attachCrossrefName(crossrefs, 'fig', cell.figId, figure);
      }
      const meta: MediaCellToken = {
        cell,
        index: cellIndex,
        line: row.line,
        figure,
        captionShown: options.caption,
      };
      const cellOpen = state.push('media_cell_open', 'div', 1);
      cellOpen.block = true;
      cellOpen.map = [row.line, row.line + 1];
      cellOpen.meta = meta;
      const inline = new state.Token('inline', '', 0);
      inline.content = cell.raw;
      inline.map = [row.line, row.line + 1];
      inline.children = [];
      state.tokens.push(inline);
      const cellClose = state.push('media_cell_close', 'div', -1);
      cellClose.block = true;
      cellClose.meta = meta;
    });
    state.push('media_row_close', 'div', -1).block = true;
  });
  state.push('media_close', 'div', -1).block = true;
}

/** The attributes a media block's own markup carries; every value is read back and re-checked. */
export function mediaBlockAttributes(meta: { options: MediaBlockOptions, numbered: boolean, rows: number }, wrap: (value: string) => string): string {
  const { options, numbered } = meta;
  const attrs = ['class="markdown-media"', 'data-media'];
  if (options.wrap) attrs.push(`data-media-wrap="${wrap(options.wrap)}"`);
  if (options.width !== null) attrs.push(`data-media-width="${options.width}"`);
  if (options.columns !== null) attrs.push(`data-media-columns="${options.columns}"`);
  if (options.gap !== 'normal') attrs.push(`data-media-gap="${wrap(options.gap)}"`);
  if (options.align !== 'center') attrs.push(`data-media-align="${wrap(options.align)}"`);
  if (options.fit !== 'contain') attrs.push(`data-media-fit="${wrap(options.fit)}"`);
  if (options.ratio) attrs.push(`data-media-ratio="${wrap(options.ratio)}"`);
  if (options.radius !== 'md') attrs.push(`data-media-radius="${wrap(options.radius)}"`);
  if (options.border) attrs.push('data-media-border="true"');
  if (options.shadow) attrs.push('data-media-shadow="true"');
  if (!options.caption) attrs.push('data-media-caption="off"');
  if (options.captionAlign !== 'center') attrs.push(`data-media-caption-align="${wrap(options.captionAlign)}"`);
  if (numbered) attrs.push('data-media-numbered="true"');
  // A body of prose rather than pictures: the frame holds the author's Markdown, and the stylesheet
  // gives it the inset a gallery would not want around a picture.
  if (!meta.rows) attrs.push('data-media-text="true"');
  return attrs.join(' ');
}

/** The attributes one row carries; the weights are a space-free list so one attribute holds them all. */
export function mediaRowAttributes(meta: MediaRowToken, wrap: (value: string) => string): string {
  const attrs = ['class="markdown-media-row"', 'data-media-row', `data-line="${meta.line}"`, `data-media-cells="${meta.cells}"`,
    `data-media-row-index="${meta.index}"`];
  if (meta.options.height !== null) attrs.push(`data-media-row-height="${meta.options.height}"`);
  if (meta.options.weights.length > 1) attrs.push(`data-media-row-weights="${meta.options.weights.join(',')}"`);
  if (meta.options.align) attrs.push(`data-media-row-align="${wrap(meta.options.align)}"`);
  return attrs.join(' ');
}

/**
 * The attributes one cell carries.
 *
 * The anchor a `@fig:` reference jumps to is spelled like every other block anchor in the note — an `id`
 * with a caret, and the same name in `data-block-id` — so the existing jump, flash and scroll-margin
 * behaviour is already there rather than needing a second one.
 */
export function mediaCellAttributes(meta: MediaCellToken, escape: (value: string) => string): string {
  const attrs = ['class="markdown-media-cell"', 'data-media-cell', `data-line="${meta.line}"`, `data-media-index="${meta.index}"`];
  if (meta.cell.kind !== 'image') attrs.push(`data-media-kind="${meta.cell.kind}"`);
  if (meta.figure !== null) attrs.push(`data-media-figure="${meta.figure}"`);
  if (meta.cell.figId) {
    const anchor = `fig-${meta.cell.figId}`;
    attrs.push(`data-media-fig="${escape(meta.cell.figId)}"`, `id="${escape(`^${anchor}`)}"`, `data-block-id="${escape(anchor)}"`);
  }
  return attrs.join(' ');
}

/**
 * The caption element, with its figure number in front of the text.
 *
 * A numbered block always gets this element and has the embed's own `<figcaption>` hidden: drawing the
 * number onto somebody else's element would need either an attribute the image rule does not add or a
 * CSS counter that restarts per block, and either one leaves a caption that reads differently on a share
 * page than in the editor.
 */
export function mediaCellCaption(meta: MediaCellToken, figureLabel: string | null, escape: (value: string) => string): string {
  if (!meta.captionShown || !meta.cell.caption) return '';
  if (meta.figure === null && meta.cell.nativeCaption) return '';
  const label = figureLabel ? `<span class="markdown-media-figure">${escape(figureLabel)}</span>` : '';
  return `<div class="markdown-media-caption" data-media-caption>${label}${escape(meta.cell.caption)}</div>`;
}
