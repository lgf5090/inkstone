/**
 * The template editor surface.
 *
 * A builtin template is prompt text with `{{name}}` placeholders, so the editor is CodeMirror rather
 * than a plain textarea: it gets line numbers, undo history and a mark on every placeholder. The
 * decoration is a view plugin over the same regex the renderer's variables use, not a new parser.
 */

import { useEffect, useRef } from 'react'
import { EditorState, RangeSetBuilder } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, drawSelection, highlightActiveLine, keymap, lineNumbers, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'

const PLACEHOLDER = /\{\{\{?[^{}]+\}?\}\}/g

const placeholderMark = Decoration.mark({ class: 'cm-template-variable' })

function placeholderDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const visible of view.visibleRanges) {
    const text = view.state.doc.sliceString(visible.from, visible.to)
    PLACEHOLDER.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = PLACEHOLDER.exec(text)) !== null) {
      builder.add(visible.from + match.index, visible.from + match.index + match[0].length, placeholderMark)
    }
  }
  return builder.finish()
}

const placeholderHighlighter = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) {
    this.decorations = placeholderDecorations(view)
  }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) this.decorations = placeholderDecorations(update.view)
  }
}, {
  decorations: (plugin) => plugin.decorations,
})

const theme = EditorView.theme({
  '&': {
    minHeight: '320px',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-md)',
    backgroundColor: 'var(--bg-base)',
    color: 'var(--text-primary)',
    fontSize: 'var(--text-12)',
  },
  '.cm-scroller': {
    maxHeight: '520px',
    overflow: 'auto',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    lineHeight: '1.55',
  },
  '.cm-content': { padding: '6px 0' },
  '.cm-line': { padding: '0 10px' },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-sunken)',
    color: 'var(--text-quaternary)',
    border: 'none',
    borderRight: '1px solid var(--border-subtle)',
  },
  '&.cm-focused': { outline: '1px solid var(--accent)' },
})

const highlight = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--syntax-comment)' },
  { tag: [tags.keyword, tags.controlKeyword], color: 'var(--syntax-keyword)' },
])

const variableStyle = EditorView.baseTheme({
  '.cm-template-variable': {
    color: 'var(--accent)',
    backgroundColor: 'color-mix(in srgb, var(--accent) 14%, transparent)',
    borderRadius: '3px',
    padding: '0 1px',
  },
})

export function TemplateEditor({ value, onChange, ariaLabel }: {
  value: string
  onChange: (value: string) => void
  ariaLabel: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          drawSelection(),
          highlightActiveLine(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          syntaxHighlighting(highlight),
          theme,
          variableStyle,
          placeholderHighlighter,
          EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString())
          }),
        ],
      }),
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // The editor is created once; external value changes are applied by the effect below.
  }, [ariaLabel])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (value !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
    }
  }, [value])

  return <div ref={hostRef} className="w-full" />
}
