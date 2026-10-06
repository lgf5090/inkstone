import { t } from '../../lib/i18n'

/** Where a running show is: which slide of the deck, and which page of that slide. `index` and `subPage`
 * are zero-based, `count` and `pageCount` are the totals they are read against.
 *
 * Every surface that writes a deck position out goes through the two functions below. The pill, the
 * corner chip and the slide list used to each build their own — four spellings of one state, two of
 * which were numbers sitting side by side that a reader could not tell apart. */
export interface DeckPosition {
  index: number
  count: number
  subPage: number
  pageCount: number
  /** How far this page has been revealed (N-31). Both are the raw state like `index` and `subPage`:
   * `step` counts from zero, and `steps` is the last step the page holds — zero on a page that has
   * nothing to reveal, which is what leaves it out of the string. */
  step?: number
  steps?: number
}

/** The digits a speaker reads off the screen: `3 / 14`, then `· 2/4` for the page of that slide, then
 * `· 1/3` for how far that page has arrived. Each group rides inside the one it narrows down, with the
 * same divider the reader already knows, so the string reads outward from the deck to the block. */
export function formatDeckPosition({ index, count, subPage, pageCount, step, steps }: DeckPosition): string {
  if (count <= 0) return ''
  const groups = [`${index + 1} / ${count}`]
  if (pageCount > 1) groups.push(`${subPage + 1}/${pageCount}`)
  if (steps) groups.push(`${(step ?? 0) + 1}/${steps + 1}`)
  return groups.join(' · ')
}

/** The same position as a sentence — what the one live region announces, and what the thumbnails are
 * named by. Every number is named in words so a reader hears which slide, which page and how far that
 * page has arrived, rather than a run of digits with no grammar. */
export function describeDeckPosition({ index, count, subPage, pageCount, step, steps }: DeckPosition): string {
  if (count <= 0) return ''
  const slide = { value0: index + 1, value1: count }
  if (pageCount > 1) {
    const page = { ...slide, value2: subPage + 1, value3: pageCount }
    return steps
      ? t('workspace.presentation_slide_page_step_number', { ...page, value4: (step ?? 0) + 1, value5: steps + 1 })
      : t('workspace.presentation_slide_page_number', page)
  }
  return steps
    ? t('workspace.presentation_slide_step_number', { ...slide, value2: (step ?? 0) + 1, value3: steps + 1 })
    : t('workspace.presentation_slide_number', slide)
}
