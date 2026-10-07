import {
  MEDIA_BLOCK_DEFAULTS,
  MEDIA_MAX_CELLS_PER_ROW,
  MEDIA_MAX_COLUMNS,
  MEDIA_MAX_ROW_HEIGHT,
  MEDIA_MAX_WIDTH,
  MEDIA_MIN_ROW_HEIGHT,
  MEDIA_MIN_WIDTH,
} from './media-layout';
import type { MediaAlign, MediaBlockOptions, MediaFit, MediaGap, MediaRadius, MediaWrap } from './media-layout';

/**
 * The one place a layout block's numbers become CSS.
 *
 * The rendered markup carries only `data-media-*` values, because the prose whitelist strips a `style`
 * attribute off anything the renderer wrote. So this runs after sanitization and hands each number to the
 * stylesheet as a custom property — the route the column blocks and the example split already take.
 *
 * Every value is read out of the DOM and re-checked here rather than trusted from the renderer, since a
 * note the author edited by hand, a share page and an import all reach this function with whatever text
 * they had.
 *
 * The row's share of the work is deliberately class-led: a picture with no stated width keeps its own
 * shape, and only a row the reader sized stretches its pictures to fill. Guessing that from the CSS alone
 * would give every unsized row in every note a height it never asked for.
 */

function numberInRange(raw: string | undefined, min: number, max: number): number | null {
  if (raw === undefined || !/^\d{1,4}$/.test(raw)) return null;
  const value = Number(raw);
  return value >= min && value <= max ? value : null;
}

function ratioValue(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(raw);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 1 || height < 1) return null;
  return `${width} / ${height}`;
}

/** The weights a row's attribute lists, one per picture it actually holds, or null when unusable. */
function weightValue(raw: string | undefined, cells: HTMLElement[]): number[] | null {
  if (raw === undefined || cells.length < 2) return null;
  const parts = raw.split(',');
  if (parts.length < 2 || parts.length > MEDIA_MAX_CELLS_PER_ROW) return null;
  const weights: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,2}(?:\.\d{1,2})?$/.test(part)) return null;
    const weight = Number(part);
    if (weight <= 0) return null;
    weights.push(weight);
  }
  while (weights.length < cells.length) weights.push(1);
  return weights.slice(0, cells.length);
}

function rowCells(row: HTMLElement): HTMLElement[] {
  return [...row.querySelectorAll<HTMLElement>(':scope > .markdown-media-cell')];
}

/**
 * A floated block has to float the element the page actually lays out.
 *
 * In the live editor each rendered block sits in its own CodeMirror widget host, and a float nested in
 * that host only escapes its own paragraph — the following blocks are separate widgets and would be
 * pushed below it. Moving the float onto the host puts the picture beside the text the way the reading
 * view does, since both are then siblings in the same formatting context.
 */
function applyMediaFloatHost(block: HTMLElement): void {
  const host = block.parentElement;
  if (!host || !host.classList.contains('cm-live-block')) return;
  const wrap = block.dataset.mediaWrap;
  const width = numberInRange(block.dataset.mediaWidth, MEDIA_MIN_WIDTH, MEDIA_MAX_WIDTH);
  host.classList.toggle('cm-media-float-left', wrap === 'left');
  host.classList.toggle('cm-media-float-right', wrap === 'right');
  if (wrap === 'left' || wrap === 'right') {
    host.style.setProperty('--cm-media-host-width', `${width ?? 40}%`);
    // The host is what shrinks now, so the block inside it has to stop sizing itself.
    block.style.setProperty('--media-width', '100%');
  }
  else {
    host.style.removeProperty('--cm-media-host-width');
  }
}

/**
 * The block's settings, read back off the markup its header produced.
 *
 * A control surface has to answer "which button is already pressed", and the rendered block is the only
 * answer a surface that cannot read the note — a share page, an embed card — ever gets. Reading the
 * settings off the DOM rather than re-parsing the header keeps the two from being able to disagree.
 */
export function mediaOptionsFromDOM(block: HTMLElement): MediaBlockOptions {
  const wrap = block.dataset.mediaWrap;
  const align = block.dataset.mediaAlign;
  const fit = block.dataset.mediaFit;
  const gap = block.dataset.mediaGap;
  const radius = block.dataset.mediaRadius;
  const captionAlign = block.dataset.mediaCaptionAlign;
  const ratio = ratioValue(block.dataset.mediaRatio);
  return {
    ...MEDIA_BLOCK_DEFAULTS,
    wrap: wrap === 'left' || wrap === 'right' ? (wrap as MediaWrap) : null,
    width: numberInRange(block.dataset.mediaWidth, MEDIA_MIN_WIDTH, MEDIA_MAX_WIDTH),
    gap: gap === 'narrow' || gap === 'normal' || gap === 'wide' ? (gap as MediaGap) : MEDIA_BLOCK_DEFAULTS.gap,
    align: align === 'left' || align === 'center' || align === 'right' ? (align as MediaAlign) : MEDIA_BLOCK_DEFAULTS.align,
    fit: fit === 'contain' || fit === 'cover' || fit === 'fill' || fit === 'none' ? (fit as MediaFit) : MEDIA_BLOCK_DEFAULTS.fit,
    ratio: ratio === null ? null : (block.dataset.mediaRatio ?? null),
    border: block.hasAttribute('data-media-border'),
    shadow: block.hasAttribute('data-media-shadow'),
    radius: radius === 'none' || radius === 'sm' || radius === 'md' || radius === 'lg' || radius === 'full'
      ? (radius as MediaRadius)
      : MEDIA_BLOCK_DEFAULTS.radius,
    caption: block.dataset.mediaCaption !== 'off',
    captionAlign: captionAlign === 'left' ? 'left' : 'center',
    numbered: block.hasAttribute('data-media-numbered'),
    columns: numberInRange(block.dataset.mediaColumns, 1, MEDIA_MAX_COLUMNS),
  };
}

/** One row's own settings, read the same way, beside how many pictures it really holds. */
export function mediaRowFromDOM(row: HTMLElement): { height: number | null, weights: number[], align: MediaAlign | null, cells: number } {
  const weights = (row.dataset.mediaRowWeights ?? '')
    .split(',')
    .filter((part) => /^\d{1,2}(?:\.\d{1,2})?$/.test(part))
    .map(Number);
  const align = row.dataset.mediaRowAlign;
  return {
    height: numberInRange(row.dataset.mediaRowHeight, MEDIA_MIN_ROW_HEIGHT, MEDIA_MAX_ROW_HEIGHT),
    weights,
    align: align === 'left' || align === 'center' || align === 'right' ? (align as MediaAlign) : null,
    cells: rowCells(row).length,
  };
}

export function applyMediaLayouts(root: HTMLElement): void {  root.querySelectorAll<HTMLElement>('.markdown-media[data-media]').forEach((block) => {
    const width = numberInRange(block.dataset.mediaWidth, MEDIA_MIN_WIDTH, MEDIA_MAX_WIDTH);
    if (width === null) block.style.removeProperty('--media-width');
    else block.style.setProperty('--media-width', `${width}%`);

    const ratio = ratioValue(block.dataset.mediaRatio);
    if (ratio === null) block.style.removeProperty('--media-ratio');
    else block.style.setProperty('--media-ratio', ratio);

    const columns = numberInRange(block.dataset.mediaColumns, 1, MEDIA_MAX_COLUMNS);
    if (columns === null) block.style.removeProperty('--media-columns');
    else block.style.setProperty('--media-columns', String(columns));

    applyMediaFloatHost(block);

    for (const row of block.querySelectorAll<HTMLElement>(':scope > .markdown-media-row')) {
      const cells = rowCells(row);
      const height = numberInRange(row.dataset.mediaRowHeight, MEDIA_MIN_ROW_HEIGHT, MEDIA_MAX_ROW_HEIGHT);
      if (height === null) row.style.removeProperty('--media-row-h');
      else row.style.setProperty('--media-row-h', `${height}px`);
      const weights = weightValue(row.dataset.mediaRowWeights, cells);
      cells.forEach((cell, index) => {
        cell.classList.toggle('is-media-sized', height !== null);
        cell.classList.toggle('is-media-weighted', weights !== null);
        if (weights === null) cell.style.removeProperty('--media-w');
        else cell.style.setProperty('--media-w', String(weights[index] ?? 1));
      });
    }
  });
}
