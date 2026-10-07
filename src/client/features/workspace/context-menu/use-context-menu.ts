import { useCallback, useMemo } from 'react'
import type { EditorView } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'
import { redo, redoDepth, undo, undoDepth } from '@codemirror/commands'
import type { EditorLayout } from '@shared/types'
import type { MenuItem } from '../../../components/overlay'
import { t } from '../../../lib/i18n'
import { formatMarkdownTable, parseMarkdownTable, type ParsedTable } from '../../../lib/markdown/table-editor'
import { joinLines, splitLines } from '../../../lib/markdown/fence-edit'
import type { BlockToast } from '../../preview/block-overlay'
import { buildCanvasItems } from './items-canvas'
import { FENCE_BUILDERS } from './items-blocks'
import { buildTableItems } from './items-table'
import {
  buildContainerItems,
  buildEmbedItems,
  buildFrontmatterItems,
  buildHeadingItems,
  buildImageItems,
  buildLinkItems,
  buildMathItems,
  buildSelectionItems,
  buildTaskItems,
  buildWikiLinkItems,
} from './items-inline'
import type { ContextKind, EditorContext, MenuCtx, PreviewContext } from './types'

/**
 * The menu's state, assembled once per open.
 *
 * The host supplies the note, the editor view and the callbacks; everything below turns those into
 * the single `MenuCtx` the builders read. Two things are derived here rather than in a builder
 * because they are shared: what "copy" means for the block under the pointer, and the table writers,
 * which need both the parser and the editor's line arithmetic.
 */
export interface EditorContextMenuProps {
  point: { x: number; y: number } | null
  onClose: () => void
  editorView: EditorView | null
  editor: EditorContext | null
  preview: PreviewContext | null
  content: string
  noteId: string | null
  onEditContent: (next: string) => void
  onJumpToLine: (line: number) => void
  onPickImage: () => void
  onPickFile: () => void
  onSwitchLayout: (layout: EditorLayout) => void
  layout: EditorLayout
  onExport: (format: 'md' | 'html' | 'pdf') => void
  onPresent: () => void
  onOpenNote: (id: string) => void
  onCreateNote: (input: { title: string; open?: boolean }) => void
  onOpenInSecondary: (id: string) => void
  onToast: BlockToast
  onLightbox: (image: { src: string; alt: string }) => void
  onBlockAction: MenuCtx['onBlockAction']
  previewScroller: HTMLElement | null
  showToolbar: boolean
  searchable: boolean
}

/** What the copy button puts on the clipboard for the block the menu was opened on. */
export function copyTextFor(ctx: { editor: EditorContext | null; preview: PreviewContext | null; content: string; editorView: EditorView | null }): string {
  const kind: ContextKind | undefined = ctx.editor?.kind ?? ctx.preview?.kind
  if (kind === 'empty' || !kind) return ''
  if (ctx.editor?.selectedText) return ctx.editor.selectedText
  if (ctx.preview?.selectedText) return ctx.preview.selectedText
  if (ctx.editor?.kind) {
    const editor = ctx.editor
    switch (editor.kind) {
      case 'heading': return editor.heading?.text ?? ''
      case 'table': return editor.table ? formatMarkdownTable(editor.table).join('\n') : ''
      case 'math': return editor.math?.formula ?? ''
      case 'image': return editor.image?.raw ?? ''
      case 'link': return editor.link?.url ?? ''
      case 'wikilink': return editor.wikiLink ? `[[${editor.wikiLink.target}]]` : ''
      case 'embed': return editor.embed ? `![[${editor.embed.target}]]` : ''
      case 'task': return editor.task?.text ?? ''
      case 'frontmatter': return ''
      case 'container': return ''
      default: return ''
    }
  }
  const preview = ctx.preview
  if (!preview) return ''
  switch (preview.kind) {
    case 'heading': return preview.heading?.text ?? ''
    case 'math': return preview.math?.formula ?? ''
    case 'image': return preview.image ? `![${preview.image.alt}](${preview.image.src})` : ''
    case 'link': return preview.link?.url ?? ''
    case 'wikilink': return preview.wikiLink ? `[[${preview.wikiLink.target}]]` : ''
    case 'task': return ''
    default: return ''
  }
}

export function useContextMenuState(props: EditorContextMenuProps): { ctx: MenuCtx; items: MenuItem[]; toolbarCopy: () => string } {
  const {
    editorView, editor, preview, content, noteId, onEditContent, onToast,
    onJumpToLine, onPickImage, onPickFile, onSwitchLayout, layout, onExport, onPresent,
    onOpenNote, onCreateNote, onOpenInSecondary, onLightbox, onBlockAction, previewScroller,
  } = props

  const runCommand = useCallback((command: (target: EditorView) => boolean) => {
    if (!editorView) return
    command(editorView)
    editorView.focus()
  }, [editorView])

  const onCopyText = useCallback((text: string) => {
    if (!text) return
    if (!navigator.clipboard?.writeText) {
      onToast({ title: t('preview.could_not_copy'), tone: 'danger' })
      return
    }
    void navigator.clipboard.writeText(text).catch(() => onToast({ title: t('preview.could_not_copy'), tone: 'danger' }))
  }, [onToast])

  const onCut = useCallback(() => {
    const range = editorView?.state.selection.main
    if (!editorView || !range || range.empty) return
    const selected = editorView.state.sliceDoc(range.from, range.to)
    if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(selected)
    editorView.dispatch({ changes: { from: range.from, to: range.to, insert: '' }, selection: EditorSelection.cursor(range.from) })
    editorView.focus()
  }, [editorView])

  const onPaste = useCallback(async () => {
    if (!editorView || !navigator.clipboard?.readText) return
    try {
      const text = await navigator.clipboard.readText()
      if (!text) return
      const range = editorView.state.selection.main
      editorView.dispatch({
        changes: { from: range.from, to: range.to, insert: text },
        selection: EditorSelection.cursor(range.from + text.length),
        scrollIntoView: true,
      })
      editorView.focus()
    } catch {
      onToast({ title: t('preview.could_not_copy'), tone: 'warning' })
    }
  }, [editorView, onToast])

  const replaceTable = useCallback((previous: ParsedTable, next: ParsedTable) => {
    if (!editorView) return
    const doc = editorView.state.doc
    editorView.dispatch({
      changes: {
        from: doc.line(previous.startLine + 1).from,
        to: doc.line(previous.endLine + 1).to,
        insert: formatMarkdownTable(next).join('\n'),
      },
      scrollIntoView: true,
    })
    editorView.focus()
  }, [editorView])

  const modifyTable = useCallback((sourceLine: number, edit: (table: ParsedTable) => ParsedTable) => {
    const { lines, eol, trailingNewline } = splitLines(content)
    const table = parseMarkdownTable(lines, sourceLine)
    if (!table) return
    lines.splice(table.startLine, table.endLine - table.startLine + 1, ...formatMarkdownTable(edit(table)))
    onEditContent(joinLines(lines, eol, trailingNewline))
  }, [content, onEditContent])

  const ctx = useMemo<MenuCtx>(() => ({
    editorView,
    editor,
    preview,
    content,
    noteId,
    onEditContent,
    onJumpToLine: onJumpToLine,
    onCopyText,
    onCut,
    onPaste,
    onUndo: () => { if (editorView) runCommand(undo) },
    onRedo: () => { if (editorView) runCommand(redo) },
    canUndo: Boolean(editorView && !preview && undoDepth(editorView.state) > 0),
    canRedo: Boolean(editorView && !preview && redoDepth(editorView.state) > 0),
    runCommand,
    replaceTable,
    modifyTable,
    onPickImage: onPickImage,
    onPickFile: onPickFile,
    onSwitchLayout: onSwitchLayout,
    layout: layout,
    onExport: onExport,
    onPresent: onPresent,
    onOpenNote: onOpenNote,
    onCreateNote: onCreateNote,
    onOpenInSecondary: onOpenInSecondary,
    onToast: onToast,
    onLightbox: onLightbox,
    onBlockAction: onBlockAction,
    previewScroller: previewScroller,
  }), [
    editorView, editor, preview, content, noteId, onEditContent, onJumpToLine, onCopyText, onCut, onPaste,
    runCommand, replaceTable, modifyTable, onPickImage, onPickFile, onSwitchLayout, layout,
    onExport, onPresent, onOpenNote, onCreateNote, onOpenInSecondary, onToast,
    onLightbox, onBlockAction, previewScroller,
  ])

  const items = useMemo<MenuItem[]>(() => {
    const kind = editor?.kind ?? preview?.kind ?? 'empty'
    const own = (FENCE_BUILDERS as Partial<Record<ContextKind, (ctx: MenuCtx) => MenuItem[] | null>>)[kind]?.(ctx)
      ?? (kind === 'table' ? buildTableItems(ctx) : null)
      ?? buildInlineItems(kind, ctx)
      ?? null
    const canvas = buildCanvasItems(ctx)
    if (!own || own.length === 0) return canvas
    return [...own, ...canvas.map((item, index) => (index === 0 ? { ...item, separatorBefore: true } : item))]
  }, [ctx, editor, preview])

  return { ctx, items, toolbarCopy: () => copyTextFor(ctx) }
}

/** The kinds that are not a fenced block and not a table. */
function buildInlineItems(kind: ContextKind, ctx: MenuCtx): MenuItem[] | null {
  switch (kind) {
    case 'selection': return buildSelectionItems(ctx)
    case 'heading': return buildHeadingItems(ctx)
    case 'math': return buildMathItems(ctx)
    case 'image': return buildImageItems(ctx)
    case 'link': return buildLinkItems(ctx)
    case 'wikilink': return buildWikiLinkItems(ctx)
    case 'embed': return buildEmbedItems(ctx)
    case 'tag': return null
    case 'task': return buildTaskItems(ctx)
    case 'frontmatter': return buildFrontmatterItems(ctx)
    case 'container': return buildContainerItems(ctx)
    default: return null
  }
}
