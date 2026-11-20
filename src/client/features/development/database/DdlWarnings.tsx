import { AlertTriangle, Info } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { cn } from '../../../lib/cn'
import type { DdlWarning } from './ddl'

export function ddlWarningText(warning: DdlWarning): string {
  switch (warning.code) {
    case 'missing_table_name':
      return t('development.database.schema.warning_table_name')
    case 'no_columns':
      return t('development.database.schema.warning_no_columns')
    case 'constraint_references_removed_column':
      return t('development.database.schema.warning_constraint', {
        target: warning.target,
        columns: (warning.columns ?? []).join(', '),
      })
    case 'index_references_removed_column':
      return t('development.database.schema.warning_index', {
        target: warning.target,
        columns: (warning.columns ?? []).join(', '),
      })
    case 'trigger_references_removed_column':
      return t('development.database.schema.warning_trigger', {
        target: warning.target,
        columns: (warning.columns ?? []).join(', '),
      })
    case 'without_rowid_without_primary_key':
      return t('development.database.schema.warning_without_rowid')
    case 'data_loss_drop_table':
      return t('development.database.ddl.warning_data_loss_table', { target: warning.target })
    case 'data_loss_drop_column':
      return t('development.database.ddl.warning_data_loss_column', { target: warning.target })
    case 'dropped_table_has_dependents':
      return t('development.database.ddl.warning_dependents', {
        target: warning.target,
        columns: (warning.columns ?? []).join(', '),
      })
    case 'unknown_constraint_preserved':
      return t('development.database.ddl.warning_unknown_constraint', { target: warning.target })
    case 'fk_target_not_key':
      return t('development.database.ddl.warning_fk_target', { target: warning.target })
    case 'fk_type_mismatch':
      return t('development.database.ddl.warning_fk_type', { target: warning.target })
    case 'fk_cycle':
      return t('development.database.ddl.warning_fk_cycle', { target: warning.target })
    case 'no_primary_key':
      return t('development.database.ddl.warning_no_primary_key', { target: warning.target })
    default:
      return warning.target || warning.code
  }
}

export function DdlWarningList({ warnings }: { warnings: DdlWarning[] }) {
  if (warnings.length === 0) return null
  return (
    <ul className="space-y-1 rounded-[var(--r-md)] border border-[var(--warning)]/30 bg-[var(--warning-soft)] p-2 text-[length:var(--text-11)] text-[var(--warning)]">
      {warnings.map((warning, index) => {
        const severe = warning.code.startsWith('data_loss') || warning.code === 'dropped_table_has_dependents'
        return (
          <li key={`${warning.code}-${index}`} className="flex items-start gap-1.5">
            <span className="mt-0.5 shrink-0">
              {severe ? <AlertTriangle size={12} aria-hidden="true" /> : <Info size={12} aria-hidden="true" />}
            </span>
            <span className={cn('min-w-0 break-words', severe && 'font-medium')}>{ddlWarningText(warning)}</span>
          </li>
        )
      })}
    </ul>
  )
}