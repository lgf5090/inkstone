import { useRef, useState } from 'react'
import {
  Check,
  GitBranch,
  LayoutGrid,
  Link2,
  Loader2,
  Pencil,
  Redo2,
  RotateCcw,
  Save,
  ShieldAlert,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import { t } from '../../../lib/i18n'
import { cn } from '../../../lib/cn'
import { Button, IconButton } from '../../../components/primitives'
import { Tooltip } from '../../../components/overlay'
import { ToolbarPanel } from './ToolbarPanel'
import type { DiagramIssue } from './diagram-issues'

export interface ErdToolbarProps {
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
  issues: DiagramIssue[]
  selectedEdge: boolean
  saving: boolean
  onExit: () => void
  onNewTable: () => void
  onAddRelation: () => void
  onEditRelation: () => void
  onDeleteRelation: () => void
  onUndo: () => void
  onRedo: () => void
  onAutoLayout: () => void
  onResetLayout: () => void
  onSave: () => void
  onSelectIssue: (issue: DiagramIssue) => void
}

export function diagramIssueText(issue: DiagramIssue): string {
  const params = issue.params ?? {}
  switch (issue.code) {
    case 'table_empty_name':
      return t('development.database.diagram.issue_table_empty_name', params)
    case 'table_duplicate_name':
      return t('development.database.diagram.issue_table_duplicate_name', params)
    case 'column_empty_name':
      return t('development.database.diagram.issue_column_empty_name', params)
    case 'column_duplicate_name':
      return t('development.database.diagram.issue_column_duplicate_name', params)
    case 'no_primary_key':
      return t('development.database.diagram.issue_no_primary_key', params)
    case 'fk_missing_table':
      return t('development.database.diagram.issue_fk_missing_table', params)
    case 'fk_missing_column':
      return t('development.database.diagram.issue_fk_missing_column', params)
    case 'fk_arity_mismatch':
      return t('development.database.diagram.issue_fk_arity_mismatch', params)
    case 'fk_duplicate_columns':
      return t('development.database.diagram.issue_fk_duplicate_columns', params)
    case 'fk_target_not_key':
      return t('development.database.diagram.issue_fk_target_not_key', params)
    case 'fk_duplicate_name':
      return t('development.database.diagram.issue_fk_duplicate_name', params)
    case 'fk_circular':
      return t('development.database.diagram.issue_fk_circular', params)
    case 'index_empty_name':
      return t('development.database.diagram.issue_index_empty_name', params)
    case 'index_duplicate_name':
      return t('development.database.diagram.issue_index_duplicate_name', params)
    case 'index_no_columns':
      return t('development.database.diagram.issue_index_no_columns', params)
    case 'unique_empty_name':
      return t('development.database.diagram.issue_unique_empty_name', params)
    case 'unique_duplicate_name':
      return t('development.database.diagram.issue_unique_duplicate_name', params)
    case 'unique_no_columns':
      return t('development.database.diagram.issue_unique_no_columns', params)
    case 'constraint_unknown':
      return t('development.database.diagram.issue_constraint_unknown', params)
    default:
      return issue.code
  }
}

const SEVERITY_STYLE: Record<DiagramIssue['severity'], string> = {
  error: 'text-[var(--danger)]',
  warning: 'text-[var(--warning)]',
  info: 'text-[var(--text-tertiary)]',
}

export function ErdToolbar({
  dirty,
  canUndo,
  canRedo,
  issues,
  selectedEdge,
  saving,
  onExit,
  onNewTable,
  onAddRelation,
  onEditRelation,
  onDeleteRelation,
  onUndo,
  onRedo,
  onAutoLayout,
  onResetLayout,
  onSave,
  onSelectIssue,
}: ErdToolbarProps) {
  const issuesAnchor = useRef<HTMLButtonElement>(null)
  const [issuesOpen, setIssuesOpen] = useState(false)

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1.5">
      <Button variant="ghost" size="sm" onClick={onExit}>
        <X size={13} />
        {t('development.database.diagram.exit')}
      </Button>
      <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-[var(--border-subtle)]" />
      <Button variant="secondary" size="sm" onClick={onNewTable}>
        <Pencil size={13} />
        {t('development.database.diagram.new_table')}
      </Button>
      <Button variant="secondary" size="sm" onClick={onAddRelation}>
        <Link2 size={13} />
        {t('development.database.diagram.add_relation')}
      </Button>
      <Button variant="secondary" size="sm" disabled={!selectedEdge} onClick={onEditRelation}>
        <GitBranch size={13} />
        {t('development.database.diagram.edit_relation')}
      </Button>
      <Button variant="secondary" size="sm" disabled={!selectedEdge} onClick={onDeleteRelation}>
        <Trash2 size={13} />
        {t('development.database.diagram.delete_relation')}
      </Button>
      <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-[var(--border-subtle)]" />
      <Tooltip label={t('development.database.diagram.undo')}>
        <IconButton label={t('development.database.diagram.undo')} size="sm" disabled={!canUndo} onClick={onUndo}>
          <Undo2 size={14} />
        </IconButton>
      </Tooltip>
      <Tooltip label={t('development.database.diagram.redo')}>
        <IconButton label={t('development.database.diagram.redo')} size="sm" disabled={!canRedo} onClick={onRedo}>
          <Redo2 size={14} />
        </IconButton>
      </Tooltip>
      <Tooltip label={t('development.database.diagram.auto_layout')}>
        <IconButton label={t('development.database.diagram.auto_layout')} size="sm" onClick={onAutoLayout}>
          <LayoutGrid size={14} />
        </IconButton>
      </Tooltip>
      <Tooltip label={t('development.database.diagram.reset_layout')}>
        <IconButton label={t('development.database.diagram.reset_layout')} size="sm" onClick={onResetLayout}>
          <RotateCcw size={14} />
        </IconButton>
      </Tooltip>

      <div className="flex-1" />

      {dirty && (
        <span className="flex items-center gap-1 text-[length:var(--text-11)] text-[var(--warning)]" role="status">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-[var(--warning)]" />
          {t('development.database.diagram.dirty')}
        </span>
      )}

      <Button
        ref={issuesAnchor}
        variant="secondary"
        size="sm"
        aria-expanded={issuesOpen}
        onClick={() => setIssuesOpen((open) => !open)}
      >
        <ShieldAlert size={13} />
        {t('development.database.diagram.issues')}
        <span
          className={cn(
            'rounded-full px-1 text-[length:var(--text-10)] tabular-nums',
            issues.length > 0 ? 'bg-[var(--warning-soft)] text-[var(--warning)]' : 'bg-[var(--bg-hover)] text-[var(--text-tertiary)]',
          )}
        >
          {issues.length}
        </span>
      </Button>
      <Button size="sm" disabled={!dirty || saving} onClick={onSave}>
        {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
        {t('development.database.diagram.save')}
      </Button>

      <ToolbarPanel
        open={issuesOpen}
        onClose={() => setIssuesOpen(false)}
        anchor={issuesAnchor}
        label={t('development.database.diagram.issues')}
        width={360}
      >
        {issues.length === 0 ? (
          <p className="flex items-center gap-1.5 px-1 py-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            <Check size={13} aria-hidden="true" />
            {t('development.database.diagram.no_issues')}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {issues.map((issue) => (
              <li key={issue.id}>
                <button
                  type="button"
                  className="w-full rounded-[var(--r-md)] px-2 py-1.5 text-left text-[length:var(--text-12)] hover:bg-[var(--bg-hover)]"
                  onClick={() => {
                    onSelectIssue(issue)
                    setIssuesOpen(false)
                  }}
                >
                  <span className={cn('block text-[length:var(--text-11)] font-medium uppercase', SEVERITY_STYLE[issue.severity])}>
                    {issue.severity}
                  </span>
                  <span className="block break-words text-[var(--text-primary)]">{diagramIssueText(issue)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </ToolbarPanel>
    </div>
  )
}