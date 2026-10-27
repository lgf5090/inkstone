/**
 * A plain code editor for values that are code.
 *
 * CodeMirror is loaded on demand: a reader who never opens a deploy dialog should not download an
 * editor. Escape is left to the dialog that owns this surface — the editor binds no global keys —
 * and Tab keeps its default (indent) because the surface is a code box rather than a form field.
 */
import { useEffect, useRef } from 'react'
import { cn } from '../../../lib/cn'

type EditorBundle = {
  view: import('@codemirror/view').EditorView
  destroy: () => void
}

export function CodeEditor({
  value,
  onChange,
  readOnly = false,
  ariaLabel,
  minHeight = 200,
  className,
}: {
  value: string
  onChange?: (value: string) => void
  readOnly?: boolean
  ariaLabel: string
  minHeight?: number
  className?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const bundle = useRef<EditorBundle | null>(null)
  const latest = useRef({ value, onChange, readOnly })

  latest.current = { value, onChange, readOnly }

  useEffect(() => {
    let cancelled = false
    const element = host.current
    if (!element) return
    void (async () => {
      const [{ EditorState }, { EditorView, keymap, lineNumbers }, { defaultKeymap, history, historyKeymap }, { javascript }, { codeHighlighting }] = await Promise.all([
        import('@codemirror/state'),
        import('@codemirror/view'),
        import('@codemirror/commands'),
        import('@codemirror/lang-javascript'),
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
      })
      const state = EditorState.create({
        doc: latest.current.value,
        extensions: [
          lineNumbers(),
          javascript(),
          codeHighlighting,
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          theme,
          EditorView.editable.of(!latest.current.readOnly),
          EditorView.contentAttributes.of({ 'aria-label': ariaLabel, spellcheck: 'false' }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange?.(update.state.doc.toString())
          }),
        ],
      })
      const view = new EditorView({ state, parent: host.current })
      bundle.current = { view, destroy: () => view.destroy() }
    })().catch((error: unknown) => {
      console.error('[inkstone] The code editor failed to load:', error)
    })
    return () => {
      cancelled = true
      bundle.current?.destroy()
      bundle.current = null
    }
  }, [ariaLabel, readOnly])

  useEffect(() => {
    const view = bundle.current?.view
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== value) view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])

  return <div ref={host} className={cn('overflow-hidden', className)} style={{ minHeight }} />
}
