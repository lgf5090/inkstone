import type { EditorView } from '@codemirror/view'
import type { EditorLayout } from '@shared/types'
import type { BlockToast } from '../../preview/block-overlay'
import type { ParsedTable } from '../../../lib/markdown/table-editor'

/**
 * The block the pointer landed on, as both halves of the editor agree on it.
 *
 * The note and the rendered document describe the same thing with different evidence — a character
 * offset and a line number on one side, an element and its `data-line` on the other — so each side
 * gets its own shape and the two share only the `kind`. A menu builder that has to branch on which
 * side it was opened from is the thing this split exists to prevent.
 */
export type ContextKind =
  | 'selection'
  | 'heading'
  | 'table'
  | 'codeblock'
  | 'example'
  | 'mermaid'
  | 'chart'
  | 'mindmap'
  | 'kanban'
  | 'math'
  | 'image'
  | 'link'
  | 'wikilink'
  | 'tag'
  | 'task'
  | 'frontmatter'
  | 'container'
  | 'embed'
  | 'empty'

/** A fenced block, told either from the note (offsets) or from the rendered element (a line). */
export interface FenceInfoData {
  /** The fence's language as the renderer reads it, lowercased and without its options. */
  language: string
  /** The whole info string, as written, so an edit can keep the options it did not touch. */
  info: string
  body: string
  /** Character span of the block, opening fence through closing line, when read from the note. */
  from?: number
  to?: number
  /** False when the note leaves the fence open and the block runs to its end. */
  closed?: boolean
  /** The 0-based line of the opening fence, when read from the rendered block's `data-line`. */
  line?: number
  title?: string
}

export interface EditorContext {
  kind: ContextKind
  pos: number
  /** 1-based, matching CodeMirror's own line numbering. */
  line: number
  selectedText?: string
  heading?: { level: number; text: string; from: number; to: number }
  table?: ParsedTable
  fence?: FenceInfoData
  math?: { formula: string; block: boolean; from: number; to: number }
  image?: { alt: string; url: string; raw: string; from: number; to: number }
  link?: { text: string; url: string; from: number; to: number }
  wikiLink?: { target: string; alias: string; from: number; to: number }
  embed?: { target: string; from: number; to: number }
  task?: { checked: boolean; text: string; from: number; to: number }
  container?: { directive: string; from: number; to: number }
}

export interface PreviewContext {
  kind: ContextKind
  /** The node the pointer was on. A diagram's shapes are SVG, so this is not always an `HTMLElement`. */
  target: Element
  selectedText?: string
  /** The 0-based source line the block was stamped with, or the note's first for front matter. */
  line?: number
  heading?: { level: number; text: string }
  table?: { rowIndex: number; colIndex: number }
  fence?: FenceInfoData
  math?: { formula: string; block: boolean }
  image?: { src: string; alt: string }
  link?: { text: string; url: string }
  wikiLink?: { target: string; alias: string }
  embed?: { target: string }
  tag?: { name: string }
  task?: { checked: boolean }
  container?: { directive: string }
}

/** The fence languages that get a menu of their own rather than the code block's. */
export const DIAGRAM_FENCES = {
  mermaid: ['mermaid'],
  chart: ['chart', 'chartjs'],
  mindmap: ['mindmap', 'mind-elixir'],
  kanban: ['kanban', 'notion-kanban', 'board'],
  example: ['md-example', 'markdown-example', 'javascript-example', 'js-example'],
} as const satisfies Record<string, readonly string[]>

export type DiagramFamily = keyof typeof DIAGRAM_FENCES

const FAMILY_BY_LANGUAGE = new Map<string, DiagramFamily>()
for (const [family, languages] of Object.entries(DIAGRAM_FENCES) as [DiagramFamily, readonly string[]][]) {
  for (const language of languages) FAMILY_BY_LANGUAGE.set(language, family)
}

export function diagramFamilyOf(language: string): DiagramFamily | null {
  return FAMILY_BY_LANGUAGE.get(language.toLowerCase()) ?? null
}

/** The context kind a fenced block answers to: its family when it has one, the plain code block otherwise. */
export function fenceContextKind(language: string): ContextKind {
  const family = diagramFamilyOf(language)
  if (family === 'example') return 'example'
  if (family) return family
  return 'codeblock'
}

/**
 * Everything a menu item can read or trigger, assembled once per menu and handed to the per-kind
 * builders so each of them stays a pure function of the menu's state.
 *
 * `editorView` is present only when the menu was opened on the note's own text. A split view has a
 * live editor while the pointer is in the preview pane, which is why the builders ask `preview`
 * first: running a CodeMirror command against the editor's cursor would edit whatever the cursor
 * happens to be on, not the block that was clicked.
 */
export interface MenuCtx {
  editorView: EditorView | null
  editor: EditorContext | null
  preview: PreviewContext | null
  content: string
  noteId: string | null
  onEditContent: (next: string) => void
  /** Move the editor's cursor to a 0-based source line and scroll it into view. */
  onJumpToLine: (line: number) => void
  onCopyText: (text: string) => void
  onCut: () => void
  onPaste: () => void
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  runCommand: (command: (target: EditorView) => boolean) => void
  /** Replace a table the editor is looking at, in one transaction. */
  replaceTable: (previous: ParsedTable, next: ParsedTable) => void
  /** Edit a table the preview is showing, by rewriting the note's lines. */
  modifyTable: (sourceLine: number, edit: (table: ParsedTable) => ParsedTable) => void
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
  /** The rendered block's own controls, when the preview pane has them wired up. */
  onBlockAction: (name: 'mindmap-fullscreen' | 'mindmap-theme' | 'kanban-fullscreen' | 'mermaid-rerender', target: HTMLElement) => void
  previewScroller: HTMLElement | null
}

/** True when the menu was opened on the note's text rather than on the rendered document. */
export function isSourceMenu(ctx: MenuCtx): boolean {
  return Boolean(ctx.editorView && !ctx.preview)
}

/** The fence the menu is acting on, from whichever side it was opened. */
export function menuFence(ctx: MenuCtx): FenceInfoData | null {
  return ctx.editor?.fence ?? ctx.preview?.fence ?? null
}

/** The 0-based source line of the block the menu is acting on, from either side. */
export function menuLine(ctx: MenuCtx): number | null {
  if (ctx.preview?.line !== undefined) return ctx.preview.line
  if (ctx.editor) return ctx.editor.line - 1
  return null
}

/**
 * What a host must offer for its note to have a context menu at all.
 *
 * The preview pane is drawn by share pages and pinned windows too, where there is no editor to jump
 * to and nobody holding the export and presentation commands. Those hosts simply pass nothing, and
 * the pane keeps the browser's own menu.
 */
export interface ContextMenuHost {
  /** Move the editor's cursor to a 0-based source line, and make the editor visible if it is not. */
  onJumpToLine: (line: number) => void
  onSwitchLayout: (layout: EditorLayout) => void
  layout: EditorLayout
  onExport: (format: 'md' | 'html' | 'pdf') => void
  onPresent: () => void
  onOpenInSecondary: (id: string) => void
  onPickImage: () => void
  onPickFile: () => void
  /** The clipboard and history strip above the rows. */
  showToolbar: boolean
  /** The filter box that narrows the rows to what the query matches. */
  searchable: boolean
}
