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
  target: HTMLElement
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
