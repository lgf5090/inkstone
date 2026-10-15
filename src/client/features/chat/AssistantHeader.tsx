/**
 * The title block every assistant page opens with.
 *
 * The surfaces behind the rail are one page with different contents, and each of them had written this
 * pair out for itself: a serif title at one size, and a line under it saying what the page is for. Three
 * copies drifted — one of them put its action beside the title and the others did not — so the shape
 * lives here. The action rides the title line, which is where a page's primary button belongs on a page
 * that also has a list under it.
 */
import type { ReactNode } from 'react'

export function AssistantHeader({
  title,
  description,
  action,
}: {
  title: string
  description?: ReactNode
  /** Drawn on the title line, right-aligned; the page's primary action when it has one. */
  action?: ReactNode
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="font-serif text-[length:var(--text-18)] font-semibold tracking-[var(--tracking-title)] text-[var(--text-primary)]">
          {title}
        </h2>
        {description && (
          <p className="mt-1 text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  )
}
