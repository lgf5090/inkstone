import type { ReactNode } from 'react'
import { AlignCenter, ArrowDownUp, ArrowUpAZ, ArrowDownAZ, Copy, CopyPlus, Eraser, FileSpreadsheet, Minus, Pencil, Plus, Rows, Trash2 } from 'lucide-react'
import { submenuFor, type MenuItem } from '../../../components/overlay'
import { t, type MessageKey } from '../../../lib/i18n'
import {
  clearTableCell,
  clearTableRow,
  deleteTableColumn,
  deleteTableRow,
  duplicateTableRow,
  insertTableColumn,
  insertTableRow,
  parseMarkdownTable,
  setColumnAlignment,
  sortTableRowByColumn,
  tableToCsv,
  type ColumnAlignment,
  type ParsedTable,
} from '../../../lib/markdown/table-editor'
import { joinLines, splitLines } from '../../../lib/markdown/fence-edit'
import type { MenuCtx } from './types'
import { isSourceMenu } from './types'

/**
 * The table menu, built once for both panes.
 *
 * The source knows which cell the cursor is in from the character offset; the preview knows from the
 * `td` that was clicked. Both end up as a row and column index, so the rows below are the same list
 * and only the writer differs — a CodeMirror transaction against the block's lines, or a rewrite of
 * the note's text through the same parser.
 */

const ALIGNMENTS: Array<{ value: ColumnAlignment; label: MessageKey; icon: ReactNode }> = [
  { value: 'left', label: 'contextmenu.table_align_left', icon: <AlignCenter size={13} className="-scale-x-100" /> },
  { value: 'center', label: 'contextmenu.table_align_center', icon: <AlignCenter size={13} /> },
  { value: 'right', label: 'contextmenu.table_align_right', icon: <AlignCenter size={13} className="scale-x-[-1]" /> },
  { value: 'default', label: 'contextmenu.table_align_default', icon: <Minus size={13} /> },
]

/** The rows of one table menu, given the parsed block and the one way to write it back. */
export function tableMenuItems(table: ParsedTable, apply: (next: ParsedTable) => void, extras: MenuItem[], copyCsv: (text: string) => void): MenuItem[] {
  const row = table.cursorRowIndex
  const column = table.cursorColIndex
  const alignItems: MenuItem[] = ALIGNMENTS.map(({ value, label, icon }) => ({
    id: `align-${value}`,
    label: t(label),
    icon,
    checked: table.alignments[column] === value,
    onSelect: () => apply(setColumnAlignment(table, column, value)),
  }))
  const sortItems: MenuItem[] = [
    { id: 'sort-asc', label: t('contextmenu.table_sort_asc'), icon: <ArrowUpAZ size={13} />, onSelect: () => apply(sortTableRowByColumn(table, column, 'asc')) },
    { id: 'sort-desc', label: t('contextmenu.table_sort_desc'), icon: <ArrowDownAZ size={13} />, onSelect: () => apply(sortTableRowByColumn(table, column, 'desc')) },
  ]
  return [
    { id: 'insert-row-above', label: t('contextmenu.table_insert_row_above'), icon: <Rows size={14} />, onSelect: () => apply(insertTableRow(table, row, 'above')) },
    { id: 'insert-row-below', label: t('contextmenu.table_insert_row_below'), icon: <Rows size={14} />, onSelect: () => apply(insertTableRow(table, row, 'below')) },
    { id: 'duplicate-row', label: t('contextmenu.table_duplicate_row'), icon: <CopyPlus size={14} />, disabled: row < 0, onSelect: () => apply(duplicateTableRow(table, row)) },
    { id: 'delete-row', label: t('contextmenu.table_delete_row'), icon: <Trash2 size={14} />, disabled: row < 0 && table.rows.length === 0, onSelect: () => apply(deleteTableRow(table, row)) },
    { id: 'insert-col-left', label: t('contextmenu.table_insert_col_left'), icon: <Plus size={14} />, separatorBefore: true, onSelect: () => apply(insertTableColumn(table, column, 'left')) },
    { id: 'insert-col-right', label: t('contextmenu.table_insert_col_right'), icon: <Plus size={14} />, onSelect: () => apply(insertTableColumn(table, column, 'right')) },
    { id: 'delete-col', label: t('contextmenu.table_delete_col'), icon: <Trash2 size={14} />, disabled: table.columnCount <= 1, onSelect: () => apply(deleteTableColumn(table, column)) },
    { id: 'align', label: t('contextmenu.table_align'), icon: <AlignCenter size={14} />, separatorBefore: true, subItems: alignItems, submenu: submenuFor(alignItems) },
    { id: 'sort', label: t('contextmenu.table_sort'), icon: <ArrowDownUp size={14} />, subItems: sortItems, submenu: submenuFor(sortItems) },
    { id: 'clear-cell', label: t('contextmenu.table_clear_cell'), icon: <Eraser size={14} />, separatorBefore: true, onSelect: () => apply(clearTableCell(table, row, column)) },
    { id: 'clear-row', label: t('contextmenu.table_clear_row'), icon: <Eraser size={14} />, onSelect: () => apply(clearTableRow(table, row)) },
    { id: 'format', label: t('contextmenu.table_format'), icon: <FileSpreadsheet size={14} />, separatorBefore: true, onSelect: () => apply({ ...table }) },
    { id: 'copy-csv', label: t('contextmenu.table_copy_csv'), icon: <Copy size={14} />, onSelect: () => copyCsv(tableToCsv(table)) },
    ...extras,
  ]
}

export function buildTableItems(ctx: MenuCtx): MenuItem[] | null {
  if (isSourceMenu(ctx)) {
    const table = ctx.editor?.table
    if (!table) return null
    return tableMenuItems(table, (next) => ctx.replaceTable(table, next), [
      { id: 'copy-table-md', label: t('contextmenu.copy_source'), icon: <Copy size={14} />, separatorBefore: true, onSelect: () => ctx.onCopyText(tableSource(ctx, table)) },
      {
        id: 'delete-table',
        label: t('contextmenu.delete_block'),
        icon: <Trash2 size={14} />,
        tone: 'danger',
        onSelect: () => {
          const view = ctx.editorView
          if (!view) return
          const doc = view.state.doc
          const from = doc.line(table.startLine + 1).from
          const to = Math.min(doc.length, doc.line(table.endLine + 1).to + 1)
          view.dispatch({ changes: { from, to, insert: '' } })
          view.focus()
        },
      },
    ], ctx.onCopyText)
  }

  const cell = ctx.preview?.table
  const line = ctx.preview?.line
  if (!cell || line === undefined) return null
  const { lines } = splitLines(ctx.content)
  const table = parseMarkdownTable(lines, line, cell.colIndex)
  if (!table) return null
  // The rendered row and column are the truth about what was clicked; the parsed table's own cursor
  // came from a character offset that means nothing here.
  const aimed: ParsedTable = { ...table, cursorRowIndex: cell.rowIndex, cursorColIndex: cell.colIndex }
  return tableMenuItems(aimed, (next) => ctx.modifyTable(line, () => next), [
    { id: 'jump-to-editor', label: t('contextmenu.jump_to_editor'), icon: <Pencil size={14} />, separatorBefore: true, onSelect: () => ctx.onJumpToLine(line) },
    { id: 'copy-table-md', label: t('contextmenu.copy_source'), icon: <Copy size={14} />, onSelect: () => ctx.onCopyText(tableSource(ctx, aimed)) },
    {
      id: 'delete-table',
      label: t('contextmenu.delete_block'),
      icon: <Trash2 size={14} />,
      tone: 'danger',
      onSelect: () => {
        const { lines: all, eol, trailingNewline } = splitLines(ctx.content)
        all.splice(table.startLine, table.endLine - table.startLine + 1)
        ctx.onEditContent(joinLines(all, eol, trailingNewline))
      },
    },
  ], ctx.onCopyText)
}

/** The table exactly as the note holds it, which is what a copy should give back. */
function tableSource(ctx: MenuCtx, table: ParsedTable): string {
  const { lines } = splitLines(ctx.content)
  return lines.slice(table.startLine, table.endLine + 1).join('\n')
}
