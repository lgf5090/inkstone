import { useEffect, useRef, useState } from 'react'
import { EditorState, StateField, Compartment, type Extension } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightActiveLine,
  placeholder as cmPlaceholder,
  showTooltip,
  Decoration,
  ViewPlugin,
  type Tooltip,
  type ViewUpdate,
} from '@codemirror/view'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands'
import {
  bracketMatching,
  foldGutter,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
  defaultHighlightStyle,
  syntaxTree,
} from '@codemirror/language'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  closeCompletion,
  completionKeymap,
  type Completion,
  type CompletionContext,
} from '@codemirror/autocomplete'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { sql, SQLite, schemaCompletionSource, keywordCompletionSource, type SQLNamespace } from '@codemirror/lang-sql'
import { RangeSet, RangeSetBuilder } from '@codemirror/state'
import { t } from '../../../lib/i18n'
import { findStatementRangeAt } from '@shared/development/database/sql-utils'
import { SQLITE_FUNCTIONS } from './sqlite-functions'

const FONT_SIZE_KEY = 'inkstone.development.database.editor-font'
const FONT_SIZE_MIN = 10
const FONT_SIZE_MAX = 24

function loadFontSize(): number {
  try {
    const value = Number.parseInt(localStorage.getItem(FONT_SIZE_KEY) ?? '', 10)
    if (Number.isFinite(value)) return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, value))
  } catch (error) {
    console.warn('[inkstone] Development database editor font size could not be read:', error)
  }
  return 13
}

function saveFontSize(value: number): void {
  try {
    localStorage.setItem(FONT_SIZE_KEY, String(value))
  } catch (error) {
    console.warn('[inkstone] Development database editor font size could not be saved:', error)
  }
}

type DecorationSet = RangeSet<Decoration>
const statementLine = Decoration.line({ class: 'cm-db-statement-line' })

function statementDecorations(state: EditorState): DecorationSet {
  const range = findStatementRangeAt(state.doc.toString(), state.selection.main.head)
  if (!range) return RangeSet.empty
  const builder = new RangeSetBuilder<Decoration>()
  const last = state.doc.lineAt(Math.min(range.to - 1, state.doc.length - 1))
  let line = state.doc.lineAt(range.from)
  for (;;) {
    builder.add(line.from, line.from, statementLine)
    if (line.number >= last.number) break
    line = state.doc.line(line.number + 1)
  }
  return builder.finish()
}

function statementHighlight(): Extension {
  return StateField.define<DecorationSet>({
    create: (state) => statementDecorations(state),
    update: (value, transaction) => {
      if (!transaction.docChanged && !transaction.selection) return value
      return statementDecorations(transaction.state)
    },
    provide: (field) => EditorView.decorations.from(field),
  })
}

const tableNameMark = Decoration.mark({ class: 'cm-db-table-name' })

function tableNameHighlight(tableNames: string[]): Extension {
  const names = new Set(tableNames.map((name) => name.toLowerCase()))
  if (names.size === 0) return []
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = computeTableDecorations(view, names)
      }
      update(update: ViewUpdate) {
        this.decorations = computeTableDecorations(update.view, names)
      }
    },
    { decorations: (value) => value.decorations },
  )
}

function computeTableDecorations(view: EditorView, names: Set<string>): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'Identifier') return
        const word = view.state.doc.sliceString(node.from, node.to).toLowerCase()
        if (!names.has(word)) return
        const previous = node.node.prevSibling
        if (previous && view.state.doc.sliceString(previous.from, previous.to) === '.') return
        builder.add(node.from, node.to, tableNameMark)
      },
    })
  }
  return builder.finish()
}

function functionOptions(): Completion[] {
  return SQLITE_FUNCTIONS.map((fn) => ({
    label: fn.name,
    type: 'function',
    detail: `(${fn.args})`,
    info: t(fn.descKey),
  }))
}

function functionCompletion(context: CompletionContext) {
  const word = context.matchBefore(/[\w$]*/)
  if (!word || (word.from === word.to && !context.explicit)) return null
  const before = context.state.sliceDoc(Math.max(0, word.from - 1), word.from)
  if (before === '.') return null
  return { from: word.from, options: functionOptions(), validFor: /^[\w$]*$/ }
}

function functionSignatureTooltip(state: EditorState): readonly Tooltip[] {
  const position = state.selection.main.head
  const line = state.doc.lineAt(position)
  const before = line.text.slice(0, position - line.from)
  const open = before.lastIndexOf('(')
  if (open < 0) return []
  const match = before.slice(0, open).trimEnd().match(/([A-Za-z_][A-Za-z0-9_]*)$/)
  if (!match) return []
  const fn = SQLITE_FUNCTIONS.find((entry) => entry.name.toUpperCase() === match[1]!.toUpperCase())
  if (!fn) return []
  const at = line.from + open + 1
  return [{
    pos: at,
    above: false,
    create: () => {
      const dom = document.createElement('div')
      dom.className = 'rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-overlay)] px-2.5 py-1.5 text-[length:var(--text-11)] shadow-[var(--shadow-pop)]'
      const head = document.createElement('div')
      head.className = 'font-mono font-semibold text-[var(--accent)]'
      head.textContent = `${fn.name}(${fn.args})`
      const description = document.createElement('div')
      description.className = 'mt-0.5 text-[var(--text-secondary)]'
      description.textContent = t(fn.descKey)
      dom.append(head, description)
      return { dom }
    },
  }]
}

function signatureTooltip(): Extension {
  return StateField.define<Tooltip | null>({
    create: () => null,
    update: (value, transaction) => {
      if (!transaction.docChanged && !transaction.selection) return value
      return functionSignatureTooltip(transaction.state)[0] ?? null
    },
    provide: (field) => showTooltip.from(field),
  })
}

export interface SqlEditorImplProps {
  value: string
  onChange: (value: string) => void
  schema: Record<string, string[]>
  onExecute: (sql: string) => void
  onFormat?: (sql: string) => void
  onCursorChange?: (line: number, column: number) => void
  placeholder?: string
  readOnly?: boolean
  ariaLabel?: string
  className?: string
}

export default function SqlEditorImpl({
  value,
  onChange,
  schema,
  onExecute,
  onFormat,
  onCursorChange,
  placeholder,
  readOnly = false,
  ariaLabel,
  className,
}: SqlEditorImplProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const [fontSize, setFontSize] = useState(loadFontSize)
  const themeCompartment = useRef(new Compartment())
  const languageCompartment = useRef(new Compartment())
  const callbacks = useRef({ onChange, onExecute, onFormat, onCursorChange })
  callbacks.current = { onChange, onExecute, onFormat, onCursorChange }

  const themeExtension = (size: number): Extension => EditorView.theme({
    '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--text-primary)' },
    '.cm-scroller': { fontFamily: 'var(--font-mono, ui-monospace, monospace)', lineHeight: '1.6' },
    '.cm-content': { paddingBlock: '6px', fontSize: `${size}px`, caretColor: 'var(--accent)' },
    '.cm-gutters': { backgroundColor: 'var(--bg-sunken)', color: 'var(--text-quaternary)', border: 'none', fontSize: `${size}px` },
    '.cm-activeLine': { backgroundColor: 'var(--bg-hover)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--bg-hover)', color: 'var(--text-secondary)' },
    '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--accent-soft)' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)' },
    '.cm-tooltip': { border: 'none', backgroundColor: 'transparent' },
    '.cm-db-statement-line': { backgroundColor: 'color-mix(in oklab, var(--warning) 8%, transparent)', borderLeft: '2px solid color-mix(in oklab, var(--warning) 50%, transparent)' },
    '.cm-db-table-name': { color: 'var(--accent)', fontWeight: '600' },
  })

  const languageExtension = (namespace: SQLNamespace): Extension => {
    const config = { dialect: SQLite, schema: namespace, upperCaseKeywords: true }
    return [
      sql(config),
      autocompletion({
        override: [
          keywordCompletionSource(SQLite, true),
          schemaCompletionSource(config),
          functionCompletion,
        ],
      }),
      signatureTooltip(),
      statementHighlight(),
      tableNameHighlight(Object.keys(namespace)),
    ]
  }

  useEffect(() => {
    if (!host.current) return
    const namespace: SQLNamespace = {}
    for (const [table, columns] of Object.entries(schema)) namespace[table] = columns
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        indentUnit.of('  '),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        bracketMatching(),
        closeBrackets(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        EditorView.lineWrapping,
        cmPlaceholder(placeholder ?? t('development.database.query.placeholder')),
        themeCompartment.current.of(themeExtension(fontSize)),
        languageCompartment.current.of(languageExtension(namespace)),
        keymap.of([
          { key: 'Mod-Enter', run: (target) => {
            closeCompletion(target)
            const state = target.state
            const doc = state.doc.toString()
            const selection = state.selection.main
            let source: string
            if (selection.from !== selection.to) {
              source = state.sliceDoc(selection.from, selection.to)
            } else {
              const range = findStatementRangeAt(doc, selection.from)
              source = range ? doc.slice(range.from, range.to) : doc.slice(doc.lastIndexOf(';') + 1)
            }
            callbacks.current.onExecute(source)
            return true
          } },
          { key: 'Mod-Shift-Enter', run: (target) => { closeCompletion(target); callbacks.current.onExecute(target.state.doc.toString()); return true } },
          {
            key: 'Mod-Shift-f',
            run: (target) => {
              closeCompletion(target)
              const text = target.state.doc.toString()
              const format = callbacks.current.onFormat
              if (format) format(text)
              else void import('./format-sql').then(({ formatSql }) => formatSql(text)).then((result) => {
                if (!result.ok || result.sql === text) return
                target.dispatch({ changes: { from: 0, to: text.length, insert: result.sql } })
              })
              return true
            },
          },
          {
            key: 'Mod-=',
            run: () => {
              setFontSize((current) => {
                const next = Math.min(FONT_SIZE_MAX, current + 1)
                saveFontSize(next)
                return next
              })
              return true
            },
          },
          {
            key: 'Mod--',
            run: () => {
              setFontSize((current) => {
                const next = Math.max(FONT_SIZE_MIN, current - 1)
                saveFontSize(next)
                return next
              })
              return true
            },
          },
          indentWithTab,
        ]),
        keymap.of([...defaultKeymap, ...historyKeymap, ...completionKeymap, ...closeBracketsKeymap, ...searchKeymap]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) callbacks.current.onChange(update.state.doc.toString())
          if (update.selectionSet || update.docChanged) {
            const head = update.state.selection.main.head
            const line = update.state.doc.lineAt(head)
            callbacks.current.onCursorChange?.(line.number, head - line.from)
          }
        }),
        EditorView.editable.of(!readOnly),
        EditorView.contentAttributes.of({
          role: 'textbox',
          'aria-multiline': 'true',
          ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
        }),
      ],
    })
    const editor = new EditorView({ state, parent: host.current })
    view.current = editor
    return () => {
      editor.destroy()
      view.current = null
    }
  }, [readOnly])

  useEffect(() => {
    const editor = view.current
    if (!editor) return
    const current = editor.state.doc.toString()
    if (current !== value) {
      editor.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    }
  }, [value])

  useEffect(() => {
    const editor = view.current
    if (!editor) return
    editor.dispatch({ effects: themeCompartment.current.reconfigure(themeExtension(fontSize)) })
  }, [fontSize])

  useEffect(() => {
    const editor = view.current
    if (!editor) return
    const namespace: SQLNamespace = {}
    for (const [table, columns] of Object.entries(schema)) namespace[table] = columns
    editor.dispatch({ effects: languageCompartment.current.reconfigure(languageExtension(namespace)) })
  }, [schema])

  return <div ref={host} className={className ?? 'h-full min-h-0'} data-testid="database-sql-editor" />
}
