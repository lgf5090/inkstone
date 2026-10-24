/**
 * Page navigation for a long collection.
 *
 * Above the phone breakpoint it is previous / numbers / next; below it the numbers step aside and a
 * single "load more" button takes their place, because a row of five 32px page numbers is not a
 * thumb target. Both controls call the same `onChange`, so a page never has two different notions of
 * what "next" means.
 */
import type { ReactElement } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button, IconButton } from '../../../components/primitives'
import { musicText } from './labels'

export interface PagerProps {
  /** One-based page number. */
  page: number
  pageCount: number
  onChange: (page: number) => void
  className?: string
}

/** At most five numbers plus the ends, so the control keeps one line on a narrow desktop window. */
function pageItems(page: number, pageCount: number): Array<number | 'gap'> {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index + 1)
  const start = Math.max(2, page - 1)
  const end = Math.min(pageCount - 1, page + 1)
  const items: Array<number | 'gap'> = [1]
  if (start > 2) items.push('gap')
  for (let value = start; value <= end; value++) items.push(value)
  if (end < pageCount - 1) items.push('gap')
  items.push(pageCount)
  return items
}

export function Pager({ page, pageCount, onChange, className }: PagerProps): ReactElement | null {
  if (pageCount <= 1) return null
  const current = Math.min(Math.max(1, page), pageCount)
  const hasPrevious = current > 1
  const hasNext = current < pageCount

  return (
    <nav
      className={className ? `music-pager ${className}` : 'music-pager'}
      aria-label={musicText('music.pager.label')}
    >
      <div className="music-pager__pages">
        <IconButton
          label={musicText('music.pager.previous')}
          size="sm"
          disabled={!hasPrevious}
          onClick={() => onChange(current - 1)}
        >
          <ChevronLeft size={15} />
        </IconButton>
        {pageItems(current, pageCount).map((item, index) =>
          item === 'gap' ? (
            <span key={`gap-${index}`} className="music-pager__gap" aria-hidden="true">
              …
            </span>
          ) : (
            <Button
              key={item}
              size="sm"
              variant="ghost"
              className="music-pager__page"
              aria-current={item === current ? 'page' : undefined}
              onClick={() => onChange(item)}
            >
              {item}
            </Button>
          ),
        )}
        <IconButton
          label={musicText('music.pager.next')}
          size="sm"
          disabled={!hasNext}
          onClick={() => onChange(current + 1)}
        >
          <ChevronRight size={15} />
        </IconButton>
      </div>
      <Button
        size="sm"
        variant="secondary"
        className="music-pager__more"
        disabled={!hasNext}
        onClick={() => onChange(current + 1)}
      >
        {musicText('music.pager.load_more')}
      </Button>
    </nav>
  )
}
