export type DdlWarningCode =
  | 'missing_table_name'
  | 'no_columns'
  | 'constraint_references_removed_column'
  | 'index_references_removed_column'
  | 'trigger_references_removed_column'
  | 'without_rowid_without_primary_key'
  | 'dropped_table_has_dependents'
  | 'data_loss_drop_table'
  | 'data_loss_drop_column'
  | 'unknown_constraint_preserved'
  | 'fk_target_not_key'
  | 'fk_type_mismatch'
  | 'fk_cycle'
  | 'no_primary_key'

export interface DdlWarning {
  code: DdlWarningCode
  target: string
  columns?: string[]
}

export interface RebuildObjects {
  indexes?: ReadonlyArray<{ name: string; columns: string[]; sql: string | null; unique?: boolean }>
  triggers?: ReadonlyArray<{ name: string; sql: string }>
  views?: ReadonlyArray<{ name: string; sql: string }>
}