/**
 * Text-box layout with an injected measurer.
 *
 * The browser passes a canvas `measureText` wrapper; tests pass a deterministic function. Lines wrap
 * on whitespace and between CJK characters (the reference only split on whitespace, so an unspaced
 * Chinese sentence never wrapped), honour explicit newlines, and use the current font stack rather
 * than the reference's global constant. Box coordinates stay normalized; layout output is in page
 * pixels relative to the box's top-left corner.
 */
import { INKNOTE_PAGE_HEIGHT, INKNOTE_PAGE_WIDTH } from '@shared/inknote/constants'
import type { InknoteFontFamily, InknoteTextBox } from '@shared/inknote/types'

export type MeasureText = (text: string, font: string) => number

export interface TextLayoutOptions {
  /** Display width of the paper, in page units. Defaults to the standard page. */
  pageWidth?: number
  /** Display height of the paper, in page units. Defaults to the standard page. */
  pageHeight?: number
  /** Font stack from `fontStackFor`; defaults to the system stack. */
  font?: string
}

export interface TextLayoutLine {
  /** The string to paint, including its list marker. */
  text: string
  width: number
  /** Offset from the box's left edge after alignment. */
  x: number
  /** Offset from the box's top edge. */
  y: number
}

export interface TextLayout {
  lines: TextLayoutLine[]
  lineHeight: number
  boxWidth: number
  contentWidth: number
  contentHeight: number
}

export const SYSTEM_FONT_STACK = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'
export const DEFAULT_TEXT_LINE_HEIGHT = 1.3
export const TEXT_BOX_PADDING = 10
export const TEXT_MIN_WIDTH = 0.12

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u
const WHITESPACE = /\s/u
const BULLET_PREFIX = '\u2022 '

/** The font stack each family setting maps to, matching the reference's four choices. */
export function fontStackFor(fontFamily: InknoteFontFamily | string | null | undefined): string {
  if (fontFamily === 'rounded') return 'ui-rounded, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'
  if (fontFamily === 'serif') return 'Georgia, "Songti SC", "STSong", "SimSun", serif'
  if (fontFamily === 'mono') return '"SF Mono", Menlo, Consolas, monospace'
  return SYSTEM_FONT_STACK
}

/** Lay out a text item's text inside its normalized box. */
export function layoutTextBox(
  text: string,
  item: InknoteTextBox,
  measure: MeasureText,
  options: TextLayoutOptions = {},
): TextLayout {
  const pageWidth = positiveOr(options.pageWidth, INKNOTE_PAGE_WIDTH)
  const font = fontSpec(item, options.font ?? SYSTEM_FONT_STACK)
  const lineHeight = item.fontSize * (item.lh > 0 ? item.lh : DEFAULT_TEXT_LINE_HEIGHT)
  const boxWidth = Math.max(1, item.w * pageWidth)
  const lines: TextLayoutLine[] = []
  let listIndex = 1

  for (const paragraph of text === '' ? [] : text.split('\n')) {
    for (const rawLine of wrapParagraph(paragraph, boxWidth, measure, font)) {
      let display = rawLine
      if (display) {
        if (item.list === 'bullet') display = BULLET_PREFIX + display
        else if (item.list === 'number') {
          display = `${listIndex}. ${display}`
          listIndex += 1
        }
      }
      const width = measure(display, font)
      let x = 0
      if (item.align === 'center') x = (boxWidth - width) / 2
      else if (item.align === 'right') x = boxWidth - width
      lines.push({ text: display, width, x, y: lines.length * lineHeight })
    }
  }

  const contentWidth = lines.reduce((max, line) => Math.max(max, line.width), 0)
  return {
    lines,
    lineHeight,
    boxWidth,
    contentWidth,
    contentHeight: lines.length * lineHeight,
  }
}

/** Natural pixel size of the laid-out text, before it is normalized into a box. */
export function measureTextBox(
  text: string,
  item: InknoteTextBox,
  measure: MeasureText,
  options: TextLayoutOptions = {},
): { width: number; height: number } {
  const layout = layoutTextBox(text, item, measure, options)
  return { width: layout.contentWidth, height: layout.contentHeight }
}

/**
 * Size a text box for newly entered text, as normalized `w`/`h` with a 10 px inset.
 *
 * The width follows the longest explicit line rather than wrapping, which is what the reference's
 * commit path did; an empty box still gets the minimum width and one line of height.
 */
export function autoTextBoxSize(
  text: string,
  item: InknoteTextBox,
  measure: MeasureText,
  options: TextLayoutOptions = {},
): { w: number; h: number } {
  const pageWidth = positiveOr(options.pageWidth, INKNOTE_PAGE_WIDTH)
  const pageHeight = positiveOr(options.pageHeight, INKNOTE_PAGE_HEIGHT)
  const font = fontSpec(item, options.font ?? SYSTEM_FONT_STACK)
  const lineHeight = item.fontSize * (item.lh > 0 ? item.lh : DEFAULT_TEXT_LINE_HEIGHT)
  const paragraphs = text.split('\n')
  let maxWidth = 0
  for (const paragraph of paragraphs) maxWidth = Math.max(maxWidth, measure(paragraph, font))
  return {
    w: Math.max(TEXT_MIN_WIDTH, (maxWidth + TEXT_BOX_PADDING * 2) / pageWidth),
    h: (paragraphs.length * lineHeight + TEXT_BOX_PADDING * 2) / pageHeight,
  }
}

function fontSpec(item: InknoteTextBox, fontStack: string): string {
  const style = item.italic ? 'italic ' : ''
  const weight = item.bold ? 700 : 400
  return `${style}${weight} ${item.fontSize}px ${fontStack}`
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

function wrapParagraph(paragraph: string, maxWidth: number, measure: MeasureText, font: string): string[] {
  if (paragraph === '') return ['']
  const lines: string[] = []
  let current = ''
  for (const token of tokenize(paragraph)) {
    if (!current && WHITESPACE.test(token)) continue
    const candidate = current + token
    if (current.trim().length > 0 && measure(candidate, font) > maxWidth) {
      lines.push(current.trimEnd())
      current = token.trimStart()
    } else {
      current = candidate
    }
  }
  lines.push(current.trimEnd())
  return lines
}

/** Split into words, whitespace and single CJK/fullwidth characters, the units a line may break at. */
function tokenize(text: string): string[] {
  const tokens: string[] = []
  let word = ''
  const flush = (): void => {
    if (word) {
      tokens.push(word)
      word = ''
    }
  }
  for (const char of text) {
    if (WHITESPACE.test(char)) {
      flush()
      tokens.push(char)
    } else if (CJK_CHAR.test(char)) {
      flush()
      tokens.push(char)
    } else {
      word += char
    }
  }
  flush()
  return tokens
}
