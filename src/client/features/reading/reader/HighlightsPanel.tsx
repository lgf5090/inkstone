/**
 * Everything the reader has marked in this book.
 *
 * Grouped by chapter rather than by colour, because the question a reader brings to this panel is
 * "where did I write something?", and the chapter heading is what lets them decide whether to jump.
 */
import { Trash2 } from 'lucide-react'
import { Textarea } from '../../../components/form'
import { IconButton } from '../../../components/primitives'
import { Tooltip } from '../../../components/overlay'
import { t } from '../../../lib/i18n'
import { DEFAULT_HIGHLIGHT_PAINT } from '../themes'
import type { BookPosition } from '../position'
import type { Highlight } from '../types'

export interface HighlightsPanelProps {
  book: { id: string; toc: { label: string; position: BookPosition | null }[] }
  list: Highlight[]
  onJump: (position: BookPosition) => void
  onRemove: (id: string) => void
  onComment: (id: string, comment: string) => void
}

export function HighlightsPanel({ book, list, onJump, onRemove, onComment }: HighlightsPanelProps) {
  if (!list.length) {
    return <p className="px-3 py-6 text-center text-[length:var(--text-12)] opacity-60">{t('reading.no_highlights')}</p>
  }
  const chapters = [...new Set(list.map((one) => one.chapter))].sort((a, b) => a - b)
  const titleFor = (chapter: number): string => book.toc.find((entry) => entry.position?.kind === 'epub' && entry.position.chapter === chapter)?.label
    ?? t('reading.chapter_value0', { value0: chapter + 1 })

  return (
    <div className="px-1 py-2">
      {chapters.map((chapter) => (
        <section key={chapter} className="mb-2">
          <h3 className="px-2 py-1 text-[length:var(--text-10-5)] font-semibold uppercase tracking-[0.07em] opacity-55">
            {titleFor(chapter)}
          </h3>
          <ul className="space-y-px">
            {list.filter((one) => one.chapter === chapter).sort((a, b) => a.start - b.start).map((highlight) => (
              <li key={highlight.id} className="group/row flex items-start gap-1.5 rounded-[var(--r-sm)] px-2 py-1.5 hover:bg-[color-mix(in_oklab,currentColor_8%,transparent)]">
                <span className="min-w-0 flex-1">
                  <button
                    type="button"
                    className="block w-full border-s-2 ps-2 text-start text-[length:var(--text-12-5)] leading-snug"
                    style={{ borderInlineStartWidth: 2, borderInlineStartColor: DEFAULT_HIGHLIGHT_PAINT[highlight.color] }}
                    onClick={() => onJump({ kind: 'epub', chapter: highlight.chapter, offset: highlight.start })}
                  >
                    {highlight.quote}
                  </button>
                  {highlight.comment ? (
                    <Textarea
                      value={highlight.comment}
                      onChange={(event) => onComment(highlight.id, event.target.value)}
                      rows={2}
                      aria-label={t('reading.comment_for_quote')}
                      className="mt-1 w-full border-transparent bg-transparent px-1.5 py-1 text-[length:var(--text-11-5)] leading-snug opacity-80"
                    />
                  ) : null}
                </span>
                <Tooltip label={t('reading.delete_highlight')} side="left">
                  <IconButton label={t('reading.delete_highlight')} size="xs" onClick={() => onRemove(highlight.id)} className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100">
                    <Trash2 size={12} />
                  </IconButton>
                </Tooltip>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
