/**
 * The code surface a snippet file is edited and read in.
 *
 * CodeMirror is loaded when the surface mounts rather than with the app, so a reader who stays on the
 * list never downloads it. The language extension is chosen from the same catalogue the file name,
 * the icon and the served `Content-Type` come from; languages CodeMirror does not ship a package for
 * use a small stream tokenizer here, which is enough for shell, Python, YAML and Dockerfiles to read
 * as code rather than as prose.
 */
import { useEffect, useRef } from 'react'
import type { ScriptLanguageId } from '@shared/scriptshub/languages'
import { cn } from '../../lib/cn'

interface EditorBundle {
  view: import('@codemirror/view').EditorView
  destroy: () => void
}

const KEYWORDS: Record<string, readonly string[]> = {
  shell: ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'in', 'return', 'export', 'local', 'echo', 'cd', 'sudo', 'apt', 'dnf', 'pacman', 'brew', 'curl', 'wget'],
  python: ['def', 'class', 'import', 'from', 'return', 'if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'with', 'as', 'pass', 'raise', 'yield', 'lambda', 'and', 'or', 'not', 'in', 'is', 'None', 'True', 'False'],
  dockerfile: ['FROM', 'RUN', 'CMD', 'LABEL', 'EXPOSE', 'ENV', 'ADD', 'COPY', 'ENTRYPOINT', 'VOLUME', 'USER', 'WORKDIR', 'ARG', 'ONBUILD', 'HEALTHCHECK', 'SHELL'],
}

function streamLanguage(id: ScriptLanguageId, CodeMirrorLanguage: typeof import('@codemirror/language')) {
  const { StreamLanguage } = CodeMirrorLanguage
  const keywords = KEYWORDS[id] ?? []
  if (id === 'shell' || id === 'python' || id === 'dockerfile') {
    return StreamLanguage.define({
      token(stream) {
        if (stream.eatSpace()) return null
        if (stream.match(/#.*/)) return 'comment'
        if (stream.match(/"(?:[^"\\]|\\.)*"?/)) return 'string'
        if (stream.match(/'(?:[^'\\]|\\.)*'?/)) return 'string'
        if (stream.match(/^[$][A-Za-z_][A-Za-z0-9_]*/)) return 'variableName'
        if (stream.match(/^\d+(?:\.\d+)?/)) return 'number'
        const word = stream.match(/^[A-Za-z_][A-Za-z0-9_-]*/) as RegExpMatchArray | null
        if (word) return keywords.includes(word[0]) ? 'keyword' : 'variableName'
        stream.next()
        return null
      },
    })
  }
  if (id === 'yaml') {
    return StreamLanguage.define({
      token(stream) {
        if (stream.eatSpace()) return null
        if (stream.match(/#.*/)) return 'comment'
        if (stream.match(/^[^:#]+(?=:)/)) return 'propertyName'
        if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string'
        if (stream.match(/^'(?:[^'\\]|\\.)*'?/)) return 'string'
        if (stream.match(/^\d+(?:\.\d+)?/)) return 'number'
        stream.next()
        return null
      },
    })
  }
  if (id === 'json') {
    return StreamLanguage.define({
      token(stream) {
        if (stream.eatSpace()) return null
        if (stream.match(/^"(?:[^"\\]|\\.)*"/)) {
          const rest = stream.string.slice(stream.pos).trimStart()
          return rest.startsWith(':') ? 'propertyName' : 'string'
        }
        if (stream.match(/^\d+(?:\.\d+)?/)) return 'number'
        if (stream.match(/^(?:true|false|null)/)) return 'keyword'
        stream.next()
        return null
      },
    })
  }
  if (id === 'toml' || id === 'text') {
    return StreamLanguage.define({
      token(stream) {
        if (stream.eatSpace()) return null
        if (stream.match(/^#.*/)) return 'comment'
        if (stream.match(/^\[.*?\]/)) return 'keyword'
        if (stream.match(/^[^=]+(?==)/)) return 'propertyName'
        if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string'
        stream.next()
        return null
      },
    })
  }
  return []
}

async function languageExtension(id: ScriptLanguageId, name: string) {
  const [state, view, commands, language, javascript, sql, markdown] = await Promise.all([
    import('@codemirror/state'),
    import('@codemirror/view'),
    import('@codemirror/commands'),
    import('@codemirror/language'),
    import('@codemirror/lang-javascript'),
    import('@codemirror/lang-sql'),
    import('@codemirror/lang-markdown'),
  ])
  let extension: unknown = streamLanguage(id, language)
  if (id === 'javascript' && name.toLowerCase().endsWith('.ts')) extension = javascript.javascript({ typescript: true })
  else if (id === 'javascript') extension = javascript.javascript()
  else if (id === 'typescript') extension = javascript.javascript({ typescript: true })
  else if (id === 'sql') extension = sql.sql()
  else if (id === 'markdown') extension = markdown.markdown()
  return {
    state: state,
    view: view,
    commands: commands,
    language: language,
    extension: extension as import('@codemirror/state').Extension,
  }
}

export function ScriptCodeEditor({
  value,
  language,
  fileName,
  readOnly = false,
  ariaLabel,
  onChange,
  className,
  minHeight = 320,
}: {
  value: string
  language: ScriptLanguageId
  fileName: string
  readOnly?: boolean
  ariaLabel: string
  onChange?: (value: string) => void
  className?: string
  minHeight?: number
}) {
  const host = useRef<HTMLDivElement>(null)
  const bundle = useRef<EditorBundle | null>(null)
  const latest = useRef({ value, onChange })
  latest.current = { value, onChange }

  useEffect(() => {
    let cancelled = false
    const element = host.current
    if (!element) return
    void (async () => {
      const loaded = await languageExtension(language, fileName)
      if (cancelled || !host.current) return
      const theme = loaded.view.EditorView.theme({
        '&': {
          backgroundColor: 'var(--bg-inset)',
          color: 'var(--text-primary)',
          fontSize: '12.5px',
        },
        '.cm-content': {
          fontFamily: 'var(--font-mono)',
          padding: '10px 0',
          caretColor: 'var(--accent)',
        },
        '.cm-gutters': {
          backgroundColor: 'var(--bg-sunken)',
          color: 'var(--text-quaternary)',
          border: 'none',
          fontFamily: 'var(--font-mono)',
        },
        '.cm-activeLine': { backgroundColor: 'var(--bg-hover)' },
        '.cm-activeLineGutter': { backgroundColor: 'var(--bg-hover)' },
        '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--accent-soft)' },
        '.cm-scroller': { overflow: 'auto', lineHeight: '1.6' },
      })
      const state = loaded.state.EditorState.create({
        doc: latest.current.value,
        extensions: [
          loaded.view.lineNumbers(),
          loaded.language.foldGutter(),
          loaded.extension,
          loaded.commands.history(),
          loaded.view.keymap.of([...loaded.commands.defaultKeymap, ...loaded.commands.historyKeymap]),
          loaded.view.EditorView.lineWrapping,
          loaded.state.EditorState.readOnly.of(readOnly),
          loaded.view.EditorView.editable.of(!readOnly),
          loaded.view.EditorView.contentAttributes.of({ 'aria-label': ariaLabel, spellcheck: 'false' }),
          theme,
          loaded.view.EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange?.(update.state.doc.toString())
          }),
        ],
      })
      const view = new loaded.view.EditorView({ state, parent: host.current })
      bundle.current = { view, destroy: () => view.destroy() }
    })().catch((error: unknown) => {
      console.error('[inkstone] The script editor failed to load:', error)
    })
    return () => {
      cancelled = true
      bundle.current?.destroy()
      bundle.current = null
    }
  }, [ariaLabel, fileName, language, readOnly])

  useEffect(() => {
    const view = bundle.current?.view
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== value) view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])

  return <div ref={host} className={cn('overflow-hidden rounded-[var(--r-md)] border border-[var(--border-default)]', className)} style={{ minHeight }} />
}
