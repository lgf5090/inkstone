import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '../../components/primitives'
import { t } from '../../lib/i18n'

export function Pager({ page, pageCount, onPage, label }: {
  page: number
  pageCount: number
  onPage: (page: number) => void
  label: string
}) {
  if (pageCount <= 1) return null
  return (
    <nav aria-label={label} className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--border-subtle)] px-3 py-2">
      <Button
        size="sm"
        variant="ghost"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        icon={<ChevronLeft size={14} />}
      >
        {t('email.list.page_prev')}
      </Button>
      <span className="text-[length:var(--text-11)] tabular-nums text-[var(--text-tertiary)]">
        {t('email.list.page_status', { page, pages: pageCount })}
      </span>
      <Button
        size="sm"
        variant="ghost"
        disabled={page >= pageCount}
        onClick={() => onPage(page + 1)}
        trailing={<ChevronRight size={14} />}
      >
        {t('email.list.page_next')}
      </Button>
    </nav>
  )
}
