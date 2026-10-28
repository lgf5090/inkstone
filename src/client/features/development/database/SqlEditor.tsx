import { lazy, Suspense } from 'react'
import { Spinner } from '../../../components/primitives'

const Impl = lazy(() => import('./SqlEditorImpl'))

export interface SqlEditorProps {
  value: string
  onChange: (value: string) => void
  schema: Record<string, string[]>
  onExecute: (sql: string) => void
  onFormat?: (sql: string) => void
  onCursorChange?: (line: number, column: number) => void
  placeholder?: string
  readOnly?: boolean
  className?: string
}

export function SqlEditor(props: SqlEditorProps) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center gap-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          <Spinner size={14} />
        </div>
      }
    >
      <Impl {...props} />
    </Suspense>
  )
}
