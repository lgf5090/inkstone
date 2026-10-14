/**
 * What a marked passage says.
 *
 * A highlight with a comment is the interesting case, so the card opens straight into the note the
 * reader wrote rather than into the mark's metadata. Clicking a passage that carries two overlapping
 * marks shows both, since the reader may have meant either.
 */
import { useEffect, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Button, IconButton } from '../../../components/primitives'
import { Textarea } from '../../../components/form'
import { Tooltip } from '../../../components/overlay'
import { t } from '../../../lib/i18n'
import { useLibrary } from '../store/library'
import { DEFAULT_HIGHLIGHT_PAINT } from '../themes'
import type { ReaderTheme } from '../themes'

export interface CommentCardProps {
  ids: string[]
  rect: DOMRect
  bookId: string
  theme: ReaderTheme
  onClose: () => void
  onEdit: (id: string, patch: { comment: string }) => void
  onRemove: (id: string) => void
}

export function CommentCard({ ids, rect, bookId, onClose, onEdit, onRemove }: CommentCardProps) {
  const highlights = useLibrary((state) => state.highlights[bookId]) ?? []
  const cards = ids.flatMap((id) => highlights.find((one) => one.id === id) ?? [])
  const ref = useRef<HTMLDivElement>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  useEffect(() => {
    setDrafts(Object.fromEntries(cards.map((one) => [one.id, one.comment])))
    ref.current?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(' ')])

  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (ref.current?.contains(target)) return
      if ((target as Element).closest?.('.reader-mark')) return
      onClose()
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [onClose])

  if (!cards.length) return null
  const width = 300
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left))
  const top = Math.min(window.innerHeight - 140, rect.bottom + 8)

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t('reading.highlight')}
      tabIndex={-1}
      className="app-viewport-fixed fixed z-[7] flex flex-col gap-2 rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-2.5 shadow-[var(--shadow-pop)] outline-none"
      style={{ left, top, width }}
    >
      {cards.map((card) => (
        <div key={card.id} className="flex flex-col gap-1.5">
          <p
            className="border-s-2 ps-2 text-[length:var(--text-12-5)] leading-snug text-[var(--text-primary)]"
            style={{ borderInlineStartColor: DEFAULT_HIGHLIGHT_PAINT[card.color] }}
          >
            {card.quote}
          </p>
          <Textarea
            value={drafts[card.id] ?? ''}
            onChange={(event) => setDrafts((current) => ({ ...current, [card.id]: event.target.value }))}
            onBlur={() => onEdit(card.id, { comment: (drafts[card.id] ?? '').trim() })}
            placeholder={t('reading.comment_placeholder')}
            rows={2}
            aria-label={t('reading.comment_for_quote')}
            className="w-full text-[length:var(--text-12)] leading-snug"
          />
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                onEdit(card.id, { comment: (drafts[card.id] ?? '').trim() })
                onClose()
              }}
            >
              {t('common.save')}
            </Button>
            <span className="ml-auto">
              <Tooltip label={t('reading.delete_highlight')} side="left">
                <IconButton label={t('reading.delete_highlight')} size="sm" variant="ghost" onClick={() => onRemove(card.id)}>
                  <Trash2 size={13} />
                </IconButton>
              </Tooltip>
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}
