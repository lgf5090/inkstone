/**
 * The D1 query editor.
 *
 * SQLite syntax comes from `@codemirror/lang-sql`; the completions add the function list and the
 * tables/columns of the database currently open, because a query editor that only knows keywords
 * makes a reader memorise their own schema. The document is controlled by React, and the imperative
 * handle exists for the three commands a toolbar offers: run all, run selection, run the line the
 * caret is on.
 */
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import { cn } from '../../../lib/cn'
import { SQLITE_FUNCTIONS } from '../lib/sqlite-functions'

export interface SqlSchemaTable {
  name: string
  columns: readonly string[]
}

export interface SqlEditorHandle {
  selection(): string
  cursorLine(): string
  insertText(text: string): void
  focus(): void
}

type EditorBundle = {
  view: import('@codemirror/view').EditorView
  destroy: () => void
}

const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'LIMIT', 'OFFSET', 'INSERT INTO', 'VALUES',
  'UPDATE', 'SET', 'DELETE FROM', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'CREATE INDEX',
  'DROP INDEX', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'ON', 'AS', 'AND', 'OR', 'NOT', 'NULL',
  'PRIMARY KEY', 'FOREIGN KEY', 'DEFAULT', 'UNIQUE', 'IF NOT EXISTS', 'RETURNING', 'WITH',
]

function completionSource(schema: readonly SqlSchemaTable[]) {
  return (context: import('@codemirror/autocomplete').CompletionContext) => {
    const word = context.matchBefore(/[\w$]*/)
    if (!word || (word.from === word.to && !context.explicit)) return null
    const options: import('@codemirror/autocomplete').Completion[] = [
      ...SQLITE_FUNCTIONS.map((fn) => ({
        label: fn.name,
        detail: fn.args,
        info: fn.desc,
        type: 'function',
        apply: `${fn.name}(`,
      })),
      ...SQL_KEYWORDS.map((keyword) => ({ label: keyword, type: 'keyword' })),
      ...schema.flatMap((table) => [
        { label: table.name, type: 'class', detail: 'table' },
        ...table.columns.map((column) => ({ label: column, type: 'property', detail: table.name })),
      ]),
    ]
    return { from: word.from, options }
  }
}

export function SqlEditor({
  value,
  onChange,
  schema,
  ariaLabel,
  readOnly = false,
  minHeight = 220,
  className,
  ref,
}: {
  value: string
  onChange: (value: string) => void
  schema: readonly SqlSchemaTable[]
  ariaLabel: string
  readOnly?: boolean
  minHeight?: number
  className?: string
  ref?: Ref<SqlEditorHandle>
}) {
  const host = useRef<HTMLDivElement>(null)
  const bundle = useRef<EditorBundle | null>(null)
  const latest = useRef({ value, onChange, readOnly })
  const schemaRef = useRef(schema)
  latest.current = { value, onChange, readOnly }
  schemaRef.current = schema

  useImperativeHandle(ref, () => ({
    selection() {
      const view = bundle.current?.view
      if (!view) return ''
      const { from, to } = view.state.selection.main
      return view.state.sliceDoc(from, to)
    },
    cursorLine() {
      const view = bundle.current?.view
      if (!view) return ''
      const line = view.state.doc.lineAt(view.state.selection.main.head)
      return line.text
    },
    insertText(text: string) {
      const view = bundle.current?.view
      if (!view) return
      const { from, to } = view.state.selection.main
      view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } })
      view.focus()
    },
    focus() {
      bundle.current?.view.focus()
    },
  }), [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [{ EditorState }, { EditorView, keymap, lineNumbers }, { defaultKeymap, history, historyKeymap }, { sql, SQLite }, { autocompletion, completionKeymap }, { closeBrackets, closeBracketsKeymap }, { codeHighlighting }] = await Promise.all([
        import('@codemirror/state'),
        import('@codemirror/view'),
        import('@codemirror/commands'),
        import('@codemirror/lang-sql'),
        import('@codemirror/autocomplete'),
        import('@codemirror/autocomplete'),
        import('./cm-syntax'),
      ])
      if (cancelled || !host.current) return
      const theme = EditorView.theme({
        '&': {
          fontSize: '12px',
          backgroundColor: 'var(--bg-raised)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--r-md)',
        },
        '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', padding: '8px 0' },
        '.cm-gutters': { backgroundColor: 'var(--bg-sunken)', color: 'var(--text-quaternary)', border: 'none' },
        '.cm-activeLine': { backgroundColor: 'var(--bg-hover)' },
        '.cm-activeLineGutter': { backgroundColor: 'var(--bg-hover)' },
        '.cm-tooltip': { backgroundColor: 'var(--bg-overlay)', border: '1px solid var(--border-default)' },
      })
      const language = sql({
        dialect: SQLite,
        schema: Object.fromEntries(schemaRef.current.map((table) => [table.name, [...table.columns]])),
      })
      const state = EditorState.create({
        doc: latest.current.value,
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, ...completionKeymap, ...closeBracketsKeymap]),
          language,
          codeHighlighting,
          autocompletion({ override: [completionSource(schemaRef.current)] }),
          closeBrackets(),
          theme,
          EditorView.editable.of(!latest.current.readOnly),
          EditorView.contentAttributes.of({ 'aria-label': ariaLabel, spellcheck: 'false' }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange(update.state.doc.toString())
          }),
        ],
      })
      const view = new EditorView({ state, parent: host.current })
      bundle.current = { view, destroy: () => view.destroy() }
    })().catch((error: unknown) => {
      console.error('[inkstone] The SQL editor failed to load:', error)
    })
    return () => {
      cancelled = true
      bundle.current?.destroy()
      bundle.current = null
    }
  }, [ariaLabel])

  useEffect(() => {
    const view = bundle.current?.view
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== value) view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])

  return <div ref={host} className={cn('overflow-hidden', className)} style={{ minHeight }} />
}
