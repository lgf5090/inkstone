import { useEffect, useRef } from 'react'
import { cn } from '../../lib/cn'

type EditorViewType = import('@codemirror/view').EditorView

interface EditorBundle {
  view: EditorViewType
  destroy: () => void
}

export type FileEditorLanguage = 'javascript' | 'json' | 'markdown' | 'sql' | 'plain'

export function fileEditorLanguage(name: string): FileEditorLanguage {
  const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : ''
  if (extension === 'js' || extension === 'jsx' || extension === 'ts' || extension === 'tsx' || extension === 'mjs' || extension === 'cjs') {
    return 'javascript'
  }
  if (extension === 'json' || extension === 'jsonc') return 'json'
  if (extension === 'md' || extension === 'markdown' || extension === 'mdx') return 'markdown'
  if (extension === 'sql') return 'sql'
  return 'plain'
}

function languageExtension(language: FileEditorLanguage): Promise<import('@codemirror/state').Extension> {
  if (language === 'javascript') {
    return import('@codemirror/lang-javascript').then((module) => module.javascript({ typescript: true }))
  }
  if (language === 'json') {
    return import('@codemirror/lang-json').then((module) => module.json())
  }
  if (language === 'markdown') {
    return import('@codemirror/lang-markdown').then((module) => module.markdown())
  }
  if (language === 'sql') {
    return import('@codemirror/lang-sql').then((module) => module.sql())
  }
  return Promise.resolve([])
}

export function SftpCodeEditor({
  value,
  onChange,
  language,
  ariaLabel,
  className,
}: {
  value: string
  onChange: (value: string) => void
  language: FileEditorLanguage
  ariaLabel: string
  className?: string
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const bundleRef = useRef<EditorBundle | null>(null)
  const latestRef = useRef({ value, onChange })
  latestRef.current = { value, onChange }

  useEffect(() => {
    let cancelled = false
    const host = hostRef.current
    if (!host) return undefined
    void (async () => {
      const [{ EditorState }, { EditorView, keymap, lineNumbers }, { defaultKeymap, history, historyKeymap }, { codeHighlighting }, languageSupport] = await Promise.all([
        import('@codemirror/state'),
        import('@codemirror/view'),
        import('@codemirror/commands'),
        import('../../components/cm-syntax'),
        languageExtension(language),
      ])
      if (cancelled || !hostRef.current) return
      const theme = EditorView.theme({
        '&': {
          fontSize: '12px',
          height: '100%',
          backgroundColor: 'var(--bg-editor)',
          color: 'var(--text-primary)',
        },
        '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
        '.cm-content': { padding: '8px 0' },
        '.cm-gutters': { backgroundColor: 'var(--bg-sunken)', color: 'var(--text-quaternary)', border: 'none' },
        '.cm-activeLine': { backgroundColor: 'var(--bg-hover)' },
        '.cm-activeLineGutter': { backgroundColor: 'var(--bg-hover)' },
        '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--accent-soft)' },
      })
      const state = EditorState.create({
        doc: latestRef.current.value,
        extensions: [
          lineNumbers(),
          history(),
          EditorView.lineWrapping,
          languageSupport,
          codeHighlighting,
          keymap.of([...defaultKeymap, ...historyKeymap]),
          theme,
          EditorView.contentAttributes.of({ 'aria-label': ariaLabel, spellcheck: 'false' }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latestRef.current.onChange(update.state.doc.toString())
          }),
        ],
      })
      const view = new EditorView({ state, parent: hostRef.current })
      bundleRef.current = { view, destroy: () => view.destroy() }
    })().catch((error: unknown) => {
      console.error('[inkstone] The WebSSH file editor failed to load:', error)
    })
    return () => {
      cancelled = true
      bundleRef.current?.destroy()
      bundleRef.current = null
    }
  }, [ariaLabel, language])

  useEffect(() => {
    const view = bundleRef.current?.view
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])

  return (
    <div
      ref={hostRef}
      className={cn(
        'h-[46vh] min-h-[220px] overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-editor)]',
        className,
      )}
    />
  )
}
