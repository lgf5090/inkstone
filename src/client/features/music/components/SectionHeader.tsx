/** A section title with an optional trailing text action ("view all"). */
import type { ReactElement, ReactNode } from 'react'
import { Button } from '../../../components/primitives'

export interface SectionHeaderAction {
  label: string
  onClick: () => void
}

export interface SectionHeaderProps {
  title: string
  description?: ReactNode
  action?: SectionHeaderAction
  /** The id a surrounding `<section aria-labelledby>` points at. */
  id?: string
  className?: string
}

export function SectionHeader({ title, description, action, id, className }: SectionHeaderProps): ReactElement {
  return (
    <header className={className ? `music-section-header ${className}` : 'music-section-header'}>
      <div className="music-section-header__text">
        <h2 id={id} className="music-section-header__title">
          {title}
        </h2>
        {description && <p className="music-section-header__description">{description}</p>}
      </div>
      {action && (
        <Button variant="ghost" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </header>
  )
}
