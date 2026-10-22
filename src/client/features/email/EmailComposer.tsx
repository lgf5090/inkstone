import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { editorTheme } from '../../editor/theme'

export function EmailComposer({ value, onChange, onReady, placeholder, label }: {
  value: string
  onChange: (value: string) => void
  onReady?: (view: EditorView | null) => void
  placeholder?: string
  label?: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          markdown(),
          EditorView.lineWrapping,
          editorTheme(),
          ...(label ? [EditorView.contentAttributes.of({ 'aria-label': label })] : []),
          placeholderExt(placeholder ?? ''),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChange(update.state.doc.toString())
          }),
        ],
      }),
    })
    viewRef.current = view
    onReady?.(view)
    return () => {
      onReady?.(null)
      view.destroy()
      viewRef.current = null
    }
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])

  return (
    <div
      ref={hostRef}
      data-placeholder={placeholder}
      className="min-h-[180px] flex-1 overflow-auto text-[length:var(--text-13)] [&_.cm-editor]:min-h-[180px] [&_.cm-editor]:outline-none [&_.cm-scroller]:min-h-[180px]"
    />
  )
}
