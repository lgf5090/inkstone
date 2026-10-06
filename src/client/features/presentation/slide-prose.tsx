import { useMemo, type Ref } from 'react'
import type { ProseFont } from '@shared/types'
import { cn } from '../../lib/cn'
import type { SlideLayout } from './slides'

// A slide's own switch, and the class it draws. `cover` needs a box to centre in, which is why it
// carries the page height inline; `split` needs nothing but its columns, and its block heights are
// what the measuring canvas reads to decide the slide still fits on one page.
export const LAYOUT_CLASS: Record<SlideLayout, string> = { cover: 'ink-slide-cover', split: 'ink-slide-split' }

// The html object identity matters: React re-applies `dangerouslySetInnerHTML`
// whenever the object changes, which would wipe every rendered diagram on any
// re-render (pagination, theme, controls). Memoizing per html string keeps the
// markup untouched unless the slide content itself changed.
export function SlideProse({ html, contentWidth, contentHeight, font, layout, hostRef, className }: {
  html: string
  contentWidth: number
  contentHeight: number
  font: ProseFont
  layout?: SlideLayout
  hostRef?: Ref<HTMLDivElement>
  className?: string
}) {
  const htmlObj = useMemo(() => ({ __html: html }), [html])
  return (
    <div className='mx-auto' style={{ width: contentWidth }}>
      <div
        ref={hostRef}
        data-font={font}
        data-slide-page
        className={cn('ink-prose relative', className, layout && LAYOUT_CLASS[layout])}
        style={layout === 'cover' ? { minHeight: contentHeight } : undefined}
        dangerouslySetInnerHTML={htmlObj}
      />
    </div>
  )
}
