import type { ReactNode } from 'react'
import { ErrorBoundary } from '../../../../components/ErrorBoundary'
import { t } from '../../../i18n'

// Each kanban block is its own React root outside the host tree, so without a
// boundary one throwing board whites out just that card with no failure state.
// The fallback keeps the fenced source visible for recovery, like the parse-error state.
export function KanbanRootBoundary({ source, children }: { source: string; children?: ReactNode }) {
  return (
    <ErrorBoundary
      fallback={
        <div role='alert' className='kanban-error'>
          <span className='kanban-error-message'>{t('preview.kanban_render_failed')}</span>
          <pre>
            <code>{source}</code>
          </pre>
        </div>
      }
    >
      {children}
    </ErrorBoundary>
  )
}
