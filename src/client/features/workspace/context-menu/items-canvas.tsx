import { EditorSelection } from '@codemirror/state'
import { ArrowDownToLine, ArrowUpToLine, CheckSquare, Columns2, Copy, Download, FileCode, FileDown, FileText, Pencil, Presentation } from 'lucide-react'
import { submenuFor, type MenuItem } from '../../../components/overlay'
import { t, type MessageKey } from '../../../lib/i18n'
import { insertMenuItem } from '../../../editor/editorMenus'
import { preferredScrollBehavior } from '../../../lib/motion'
import { APP_SHORTCUTS } from '../../../lib/shortcuts'
import type { EditorLayout } from '@shared/types'
import type { MenuCtx } from './types'
import { isSourceMenu } from './types'

/**
 * The rows that belong to no block: the note as a whole, and the pane it is being read in.
 *
 * On the source side this is the insert list and the two note-wide commands. On the preview side it
 * is the layout switch, the exports and the scroll jumps — the things a reader asks of a page they
 * are not editing.
 */

function presentationItem(ctx: MenuCtx): MenuItem[] {
  return [{ id: 'presentation', label: t('workspace.presentation_mode'), icon: <Presentation size={14} />, combo: APP_SHORTCUTS.present, onSelect: ctx.onPresent }]
}

function exportItem(ctx: MenuCtx): MenuItem | null {
  const items: MenuItem[] = [
    { id: 'export-md', label: t('workspace.export_markdown'), icon: <FileText size={13} />, onSelect: () => ctx.onExport('md') },
    { id: 'export-html', label: t('workspace.export_html'), icon: <FileCode size={13} />, onSelect: () => ctx.onExport('html') },
    { id: 'export-pdf', label: t('workspace.export_pdf'), icon: <FileDown size={13} />, onSelect: () => ctx.onExport('pdf') },
  ]
  return { id: 'export', label: t('workspace.export'), icon: <Download size={14} />, separatorBefore: true, subItems: items, submenu: submenuFor(items) }
}

const LAYOUTS: Array<{ value: EditorLayout; label: MessageKey }> = [
  { value: 'live', label: 'workspace.editing_mode' },
  { value: 'split', label: 'workspace.split_view' },
  { value: 'preview', label: 'workspace.reading_mode' },
]

export function buildCanvasItems(ctx: MenuCtx): MenuItem[] {
  if (isSourceMenu(ctx)) {
    const view = ctx.editorView
    return [
      {
        id: 'select-all',
        label: t('contextmenu.select_all'),
        icon: <CheckSquare size={14} />,
        combo: 'mod+a',
        onSelect: () => {
          if (!view) return
          view.dispatch({ selection: EditorSelection.range(0, view.state.doc.length) })
          view.focus()
        },
      },
      ...presentationItem(ctx),
      insertMenuItem((command) => ctx.runCommand(command), ctx.onPickImage, ctx.onPickFile),
    ]
  }

  const layoutItems: MenuItem[] = LAYOUTS.map((layout) => ({
    id: `layout-${layout.value}`,
    label: t(layout.label),
    checked: ctx.layout === layout.value,
    onSelect: () => ctx.onSwitchLayout(layout.value),
  }))
  const exportRow = exportItem(ctx)
  const scroller = ctx.previewScroller
  return [
    {
      id: 'layout',
      label: t('workspace.layout'),
      icon: <Columns2 size={14} />,
      subItems: layoutItems,
      submenu: submenuFor(layoutItems),
    },
    ...presentationItem(ctx),
    {
      id: 'switch-edit',
      label: t('contextmenu.switch_to_editor'),
      icon: <Pencil size={14} />,
      onSelect: () => ctx.onSwitchLayout(ctx.layout === 'preview' ? 'split' : 'live'),
    },
    {
      id: 'copy-note',
      label: t('contextmenu.copy_note_markdown'),
      icon: <Copy size={14} />,
      separatorBefore: true,
      onSelect: () => ctx.onCopyText(ctx.content),
    },
    ...(exportRow ? [exportRow] : []),
    {
      id: 'scroll-top',
      label: t('contextmenu.scroll_top'),
      icon: <ArrowUpToLine size={14} />,
      separatorBefore: true,
      onSelect: () => scroller?.scrollTo({ top: 0, behavior: preferredScrollBehavior() }),
    },
    {
      id: 'scroll-bottom',
      label: t('contextmenu.scroll_bottom'),
      icon: <ArrowDownToLine size={14} />,
      onSelect: () => scroller?.scrollTo({ top: scroller.scrollHeight, behavior: preferredScrollBehavior() }),
    },
  ]
}
