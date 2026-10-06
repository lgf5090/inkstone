import { useState } from 'react'
import { ChevronDown, Link2 } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'

export function CardBacklinks({ links, onOpen }: {
  links: Array<{ id: string, title: string, context: string }>
  onOpen: (id: string) => void
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  return (
    <div className="shrink-0 border-t border-[var(--border-subtle)] bg-[var(--bg-base)]">
      <button
        type="button"
        aria-expanded={isExpanded}
        aria-label={t('common.backlinks')}
        onClick={() => setIsExpanded((value) => !value)}
        className="flex h-7 w-full items-center gap-1.5 px-3 text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
      >
        <Link2 size={11} className="shrink-0"/>
        <span className="truncate">{t('common.backlinks')}</span>
        <span className="tabular-nums text-[var(--text-quaternary)]">{links.length}</span>
        <ChevronDown size={12} className={cn('ml-auto shrink-0 transition-transform', isExpanded && 'rotate-180')}/>
      </button>
      {isExpanded && (
        <ul className="max-h-33 overflow-y-auto overscroll-contain px-1.5 pb-1.5">
          {links.map((link) => (
            <li key={link.id}>
              <button
                type="button"
                onClick={() => onOpen(link.id)}
                className="group w-full rounded-[var(--r-sm)] px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
              >
                <span className="block truncate text-[length:var(--text-11)] font-medium text-[var(--text-primary)]">{link.title}</span>
                <span className="mt-0.5 block truncate-2 text-[length:var(--text-10-5)] leading-relaxed text-[var(--text-tertiary)]">{link.context}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
