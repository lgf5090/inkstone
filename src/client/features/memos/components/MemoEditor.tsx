import {
  useEffect,
  useImperativeHandle,
  useRef,
  type ReactElement,
  type Ref,
} from 'react'
import { Annotation, Compartment, EditorSelection, EditorState, Prec, type Extension } from '@codemirror/state'
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import {
  EditorView,
  drawSelection,
  dropCursor,
  keymap,
  placeholder as placeholderExtension,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { search, searchKeymap } from '@codemirror/search'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  Strikethrough,
} from 'lucide-react'
import { emojiSource, tagSource } from '../../../editor/completion'
import { editorTheme } from '../../../editor/theme'
import { IconButton } from '../../../components/primitives'
import { cn } from '../../../lib/cn'
import { t, type MessageKey } from '../../../lib/i18n'
import { codeMirrorKey } from '../../../lib/shortcuts'
import { memoSlashSource } from '../memo-slash'
import { applyMemoFormat, insertMemoSnippet, MEMO_ANY_LIST_PREFIX, MEMO_LIST_PATTERNS, type MemoFormatAction } from './memo-editor-format'

const externalValueUpdate = Annotation.define<boolean>()
const MEMO_EDITOR_MIN_HEIGHT = '6rem'

const memoEditorTheme = EditorView.theme({
  '&': {
    height: 'auto',
    backgroundColor: 'transparent',
    color: 'var(--text-primary)',
    fontSize: 'var(--text-13)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.65', overflow: 'auto' },
  '.cm-content': { padding: '0', minHeight: MEMO_EDITOR_MIN_HEIGHT, caretColor: 'var(--accent)' },
  '.cm-line': { paddingInline: '0' },
  '.cm-placeholder': { color: 'var(--text-quaternary)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '.cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--accent-soft)' },
  '.cm-panels': { backgroundColor: 'var(--bg-raised)', color: 'var(--text-primary)' },
  '.cm-tooltip': {
    border: '1px solid var(--border-default)',
    backgroundColor: 'var(--bg-overlay)',
    color: 'var(--text-primary)',
  },
})

const FORMAT_KEYMAP = [
  { key: codeMirrorKey('mod+b'), run: formatKey({ kind: 'inline', open: '**' }) },
  { key: codeMirrorKey('mod+i'), run: formatKey({ kind: 'inline', open: '*' }) },
  { key: codeMirrorKey('mod+shift+x'), run: formatKey({ kind: 'inline', open: '~~' }) },
  { key: codeMirrorKey('mod+e'), run: formatKey({ kind: 'inline', open: '`' }) },
  { key: codeMirrorKey('mod+k'), run: formatKey({ kind: 'link' }) },
  { key: codeMirrorKey('mod+shift+.'), run: formatKey({ kind: 'line', prefix: '> ', pattern: MEMO_LIST_PATTERNS.quote }) },
  { key: codeMirrorKey('mod+shift+8'), run: formatKey({ kind: 'line', prefix: '- ', pattern: MEMO_LIST_PATTERNS.bullet, replacement: MEMO_ANY_LIST_PREFIX }) },
  { key: codeMirrorKey('mod+shift+7'), run: formatKey({ kind: 'line', prefix: '1. ', pattern: MEMO_LIST_PATTERNS.ordered, replacement: MEMO_ANY_LIST_PREFIX }) },
  { key: codeMirrorKey('mod+shift+9'), run: formatKey({ kind: 'line', prefix: '- [ ] ', pattern: MEMO_LIST_PATTERNS.task, replacement: MEMO_ANY_LIST_PREFIX }) },
  { key: codeMirrorKey('mod+alt+1'), run: formatKey({ kind: 'heading', level: 1 }) },
  { key: codeMirrorKey('mod+alt+2'), run: formatKey({ kind: 'heading', level: 2 }) },
  { key: codeMirrorKey('mod+alt+3'), run: formatKey({ kind: 'heading', level: 3 }) },
  { key: codeMirrorKey('mod+alt+0'), run: formatKey({ kind: 'heading', level: 0 }) },
]

function formatKey(action: MemoFormatAction) {
  return (view: EditorView): boolean => {
    runMemoFormat(view, action)
    return true
  }
}

function runMemoFormat(view: EditorView, action: MemoFormatAction): boolean {
  const range = view.state.selection.main
  const source = view.state.doc.toString()
  const result = applyMemoFormat(source, range.from, range.to, action)
  if (result.text === source && result.from === range.from && result.to === range.to) return false
  view.dispatch({
    changes: { from: 0, to: source.length, insert: result.text },
    selection: EditorSelection.range(result.from, result.to),
    scrollIntoView: true,
    userEvent: 'input.format',
  })
  return true
}

function filesFromTransfer(transfer: DataTransfer | null): File[] {
  if (!transfer) return []
  if (transfer.files.length > 0) return Array.from(transfer.files)
  return Array.from(transfer.items).flatMap((item) => {
    if (item.kind !== 'file') return []
    const file = item.getAsFile()
    return file ? [file] : []
  })
}

export interface MemoEditorHandle {
  insert: (text: string) => void
  focus: () => void
}

export interface MemoEditorProps {
  value: string
  label: string
  placeholder: string
  onChange: (value: string) => void
  onSubmit?: () => void
  onFiles?: (files: File[]) => void
  onDragActiveChange?: (active: boolean) => void
  getTags?: () => { name: string; count: number }[]
  autoFocus?: boolean
  disabled?: boolean
  className?: string
  ref?: Ref<MemoEditorHandle>
}

export function MemoEditor({
  value,
  label,
  placeholder,
  onChange,
  onSubmit,
  onFiles,
  onDragActiveChange,
  getTags,
  autoFocus = false,
  disabled = false,
  className,
  ref,
}: MemoEditorProps): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const callbacks = useRef({ onChange, onSubmit, onFiles, onDragActiveChange })
  callbacks.current = { onChange, onSubmit, onFiles, onDragActiveChange }
  const tagsRef = useRef(getTags)
  tagsRef.current = getTags
  const placeholderCompartment = useRef(new Compartment())
  const editableCompartment = useRef(new Compartment())

  useImperativeHandle(ref, () => ({
    insert(text: string) {
      const view = viewRef.current
      if (!view) return
      const range = view.state.selection.main
      const source = view.state.doc.toString()
      const result = insertMemoSnippet(source, range.from, range.to, text)
      view.dispatch({
        changes: { from: 0, to: source.length, insert: result.text },
        selection: EditorSelection.cursor(result.from),
        scrollIntoView: true,
        userEvent: 'input.insert',
      })
      view.focus()
    },
    focus() {
      viewRef.current?.focus()
    },
  }), [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const extensions: Extension[] = [
      history(),
      drawSelection(),
      dropCursor(),
      EditorView.lineWrapping,
      EditorState.tabSize.of(2),
      search({ top: true }),
      markdown({ base: markdownLanguage, addKeymap: false }),
      editorTheme(),
      memoEditorTheme,
      editableCompartment.current.of(EditorView.editable.of(!disabled)),
      placeholderCompartment.current.of([
        placeholderExtension(placeholder),
        EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'true' }),
      ]),
      keymap.of([
        ...FORMAT_KEYMAP,
        {
          key: 'Mod-Enter',
          run: (view) => {
            if (view.composing) return false
            callbacks.current.onSubmit?.()
            return true
          },
        },
      ]),
      autocompletion({
        override: [
          emojiSource,
          tagSource(() => ({
            notes: () => [],
            tags: () => tagsRef.current?.() ?? [],
          })),
          memoSlashSource,
        ],
      }),
      keymap.of([...completionKeymap]),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      EditorView.updateListener.of((update) => {
        const external = update.transactions.some((transaction) => transaction.annotation(externalValueUpdate))
        if (update.docChanged && !external) callbacks.current.onChange(update.state.doc.toString())
      }),
      Prec.high(EditorView.domEventHandlers({
        paste(event) {
          const files = filesFromTransfer(event.clipboardData)
          if (!files.length) return false
          event.preventDefault()
          callbacks.current.onFiles?.(files)
          return true
        },
        drop(event) {
          callbacks.current.onDragActiveChange?.(false)
          const files = filesFromTransfer(event.dataTransfer)
          if (!files.length) return false
          event.preventDefault()
          callbacks.current.onFiles?.(files)
          return true
        },
        dragover(event) {
          if (!event.dataTransfer?.types.includes('Files')) return false
          event.preventDefault()
          callbacks.current.onDragActiveChange?.(true)
          return false
        },
        dragleave() {
          callbacks.current.onDragActiveChange?.(false)
          return false
        },
      })),
    ]
    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: host,
    })
    viewRef.current = view
    return () => {
      callbacks.current.onDragActiveChange?.(false)
      view.destroy()
      viewRef.current = null
    }
  }, [])

  useEffect(() => {
    if (autoFocus) viewRef.current?.focus()
  }, [autoFocus])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: editableCompartment.current.reconfigure(EditorView.editable.of(!disabled)),
    })
  }, [disabled])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: placeholderCompartment.current.reconfigure([
        placeholderExtension(placeholder),
        EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'true' }),
      ]),
    })
  }, [label, placeholder])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: EditorSelection.cursor(Math.min(view.state.selection.main.head, value.length)),
      annotations: externalValueUpdate.of(true),
    })
  }, [value])

  const buttons: { id: string; label: MessageKey; action: MemoFormatAction; icon: ReactElement }[] = [
    { id: 'bold', label: 'memos.composer.bold', action: { kind: 'inline', open: '**' }, icon: <Bold size={14} /> },
    { id: 'italic', label: 'memos.composer.italic', action: { kind: 'inline', open: '*' }, icon: <Italic size={14} /> },
    { id: 'strike', label: 'memos.composer.strikethrough', action: { kind: 'inline', open: '~~' }, icon: <Strikethrough size={14} /> },
    { id: 'code', label: 'memos.composer.inline_code', action: { kind: 'inline', open: '`' }, icon: <Code size={14} /> },
    { id: 'quote', label: 'memos.composer.quote', action: { kind: 'line', prefix: '> ', pattern: MEMO_LIST_PATTERNS.quote }, icon: <Quote size={14} /> },
    { id: 'bullet', label: 'memos.composer.bullet_list', action: { kind: 'line', prefix: '- ', pattern: MEMO_LIST_PATTERNS.bullet, replacement: MEMO_ANY_LIST_PREFIX }, icon: <List size={14} /> },
    { id: 'ordered', label: 'memos.composer.ordered_list', action: { kind: 'line', prefix: '1. ', pattern: MEMO_LIST_PATTERNS.ordered, replacement: MEMO_ANY_LIST_PREFIX }, icon: <ListOrdered size={14} /> },
    { id: 'task', label: 'memos.composer.task_list', action: { kind: 'line', prefix: '- [ ] ', pattern: MEMO_LIST_PATTERNS.task, replacement: MEMO_ANY_LIST_PREFIX }, icon: <ListTodo size={14} /> },
    { id: 'link', label: 'memos.composer.link', action: { kind: 'link' }, icon: <Link2 size={14} /> },
    { id: 'h1', label: 'memos.composer.heading_level', action: { kind: 'heading', level: 1 }, icon: <Heading1 size={14} /> },
    { id: 'h2', label: 'memos.composer.heading_level', action: { kind: 'heading', level: 2 }, icon: <Heading2 size={14} /> },
    { id: 'h3', label: 'memos.composer.heading_level', action: { kind: 'heading', level: 3 }, icon: <Heading3 size={14} /> },
  ]

  return (
    <div className={cn('flex min-w-0 flex-col', className)}>
      <div
        role="toolbar"
        aria-label={t('memos.composer.formatting')}
        className="flex flex-wrap items-center gap-0.5 border-b border-[var(--border-subtle)] pb-1"
      >
        {buttons.map((button) => (
          <IconButton
            key={button.id}
            label={t(button.label, button.id.startsWith('h') ? { level: button.id.slice(1) } : undefined)}
            size="sm"
            disabled={disabled}
            onClick={() => {
              const view = viewRef.current
              if (!view) return
              runMemoFormat(view, button.action)
              view.focus()
            }}
          >
            {button.icon}
          </IconButton>
        ))}
      </div>
      <div ref={hostRef} data-memo-editor="" className="mt-1.5 min-w-0" />
    </div>
  )
}
