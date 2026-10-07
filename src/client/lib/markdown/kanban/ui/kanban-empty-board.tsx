import { memo, useId } from 'react'
import { t, useLocaleRepaint, type MessageKey } from '../../../i18n'
import { Button } from '../../../../components/primitives'
import { KANBAN_TEMPLATE_KINDS, type KanbanTemplateKind } from '../templates'

interface KanbanEmptyBoardProps {
  onAddItem: () => void
  onApplyTemplate: (kind: KanbanTemplateKind) => void
}

// The names say what a structure is for, not which fields it holds: a reader who cannot tell a
// roadmap from a triage queue learns that by opening one, and both rename to whatever they need.
const TEMPLATE_LABELS: Record<KanbanTemplateKind, MessageKey> = {
  project: 'preview.kanban_template_project',
  content: 'preview.kanban_template_content',
  issues: 'preview.kanban_template_issues',
}

/**
 * What the board shows in place of its views while the document holds no card at all — see
 * `templates.ts` for what each structure actually writes.
 */
export const KanbanEmptyBoard = memo(function KanbanEmptyBoard({ onAddItem, onApplyTemplate }: KanbanEmptyBoardProps) {
  useLocaleRepaint()
  const templatesLabelId = useId()
  return (
    <div
      data-kanban-empty
      className='flex h-full w-full flex-col items-center justify-center gap-[var(--sp-4)] overflow-y-auto px-[var(--sp-6)] py-[var(--sp-10)] text-center'
    >
      <div className='flex flex-col gap-[var(--sp-1-5)]'>
        {/* The type goes on this wrapper, not on the heading: prose owns a note's `h3` and wins any
            utility written on it (see the hand-back block in `styles/kanban.css`). */}
        <div className='text-[length:var(--text-15)] font-semibold'>
          <h3 className='text-[var(--text-primary)]'>
            {t('preview.kanban_empty_title')}
          </h3>
        </div>
        <p className='text-[length:var(--text-13)] text-[var(--text-secondary)]'>
          {t('preview.kanban_empty_hint')}
        </p>
      </div>

      <Button variant='primary' size='md' data-kanban-empty-add onClick={onAddItem}>
        {t('preview.kanban_empty_add')}
      </Button>

      <div className='flex flex-col items-center gap-[var(--sp-2)]'>
        <span id={templatesLabelId} className='text-[length:var(--text-12)] text-[var(--text-tertiary)]'>
          {t('preview.kanban_empty_templates')}
        </span>
        <div role='group' aria-labelledby={templatesLabelId} className='flex flex-wrap items-center justify-center gap-[var(--sp-2)]'>
          {KANBAN_TEMPLATE_KINDS.map((kind) => (
            <Button
              key={kind}
              variant='secondary'
              size='sm'
              data-kanban-template={kind}
              onClick={() => onApplyTemplate(kind)}
            >
              {t(TEMPLATE_LABELS[kind])}
            </Button>
          ))}
        </div>
      </div>
    </div>
  )
})
