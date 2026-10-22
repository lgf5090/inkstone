import {
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
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
  ChevronsDownUp,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Image,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  MessageSquareQuote,
  Minus,
  Plus,
  Quote,
  Sigma,
  Strikethrough,
  Table,
} from 'lucide-react'
import { emojiSource, tagSource } from '../../../editor/completion'
import { editorTheme } from '../../../editor/theme'
import { Field, Input, Segmented } from '../../../components/form'
import { Menu, Modal, type MenuItem } from '../../../components/overlay'
import { Button, IconButton } from '../../../components/primitives'
import { cn } from '../../../lib/cn'
import { t, type MessageKey } from '../../../lib/i18n'
import { codeMirrorKey } from '../../../lib/shortcuts'
import { memoSlashSource } from '../memo-slash'
import { applyMemoFormat, insertMemoSnippet, MEMO_ANY_LIST_PREFIX, MEMO_LIST_PATTERNS, type MemoFormatAction } from './memo-editor-format'

const externalValueUpdate = Annotation.define<boolean>()
const MEMO_EDITOR_MIN_HEIGHT = '6rem'
const TABLE_SNIPPET = '| Column | Column |\n| --- | --- |\n| Cell | Cell |\n'
const CALLOUT_SNIPPET = '> [!note]\n> '
const TOGGLE_CALLOUT_SNIPPET = '> [!note]- Title\n> '
const MATH_SNIPPET = '$$\n\n$$\n'
const CODE_SNIPPET = '```ts\n\n```\n'
const DIVIDER_SNIPPET = '---\n'
const CODE_CURSOR = '```ts\n'.length
const MATH_CURSOR = '$$\n'.length
const MAX_IMAGE_DIMENSION = 10_000

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

export type MemoImageAlignment = 'left' | 'center' | 'right'

export interface MemoImageInput {
  url: string
  alt: string
  width: string
  height: string
  align: MemoImageAlignment
}

function isValidImageUrl(value: string): boolean {
  if (!value || /\s/.test(value)) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return /^https?:\/\//i.test(value)
  return true
}

function isValidDimension(value: string): boolean {
  if (!value) return true
  if (!/^\d+$/.test(value)) return false
  const size = Number(value)
  return size > 0 && size <= MAX_IMAGE_DIMENSION
}

export function memoImageMarkdown({ url, alt, width, height, align }: MemoImageInput): string {
  const label = alt.trim().replace(/\\/g, '\\\\').replace(/[[\]|]/g, '\\$&')
  const trimmedWidth = width.trim()
  const trimmedHeight = trimmedWidth ? height.trim() : ''
  const size = trimmedWidth ? `|${trimmedWidth}${trimmedHeight ? `x${trimmedHeight}` : ''}` : ''
  const destination = url.trim().replace(/\\/g, '\\\\').replace(/[()]/g, '\\$&')
  const image = `![${label}${size}](${destination})`
  return align === 'left' ? image : `::: ${align}\n${image}\n:::\n`
}

function MemoImageDialog({ open, onClose, onInsert }: {
  open: boolean
  onClose: () => void
  onInsert: (markdown: string) => void
}): ReactElement {
  const [url, setUrl] = useState('')
  const [alt, setAlt] = useState('')
  const [width, setWidth] = useState('')
  const [height, setHeight] = useState('')
  const [align, setAlign] = useState<MemoImageAlignment>('left')
  const [error, setError] = useState<string | null>(null)
  const formId = useId()
  const errorId = useId()

  useEffect(() => {
    if (!open) return
    setUrl('')
    setAlt('')
    setWidth('')
    setHeight('')
    setAlign('left')
    setError(null)
  }, [open])

  const submit = (): void => {
    const destination = url.trim()
    if (!destination) {
      setError(t('memos.composer.image_url_required'))
      return
    }
    if (!isValidImageUrl(destination)) {
      setError(t('memos.composer.image_url_invalid'))
      return
    }
    const trimmedWidth = width.trim()
    const trimmedHeight = height.trim()
    if (!isValidDimension(trimmedWidth) || !isValidDimension(trimmedHeight) || (!trimmedWidth && trimmedHeight)) {
      setError(t('memos.composer.image_size_invalid'))
      return
    }
    setError(null)
    onInsert(memoImageMarkdown({
      url: destination,
      alt,
      width: trimmedWidth,
      height: trimmedHeight,
      align,
    }))
  }

  const footer = (
    <div className="flex items-center justify-end gap-2">
      <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
      <Button size="sm" variant="primary" type="submit" form={formId}>{t('memos.composer.insert')}</Button>
    </div>
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('memos.composer.image_title')}
      description={t('memos.composer.image_description')}
      width={460}
      footer={footer}
    >
      <form
        id={formId}
        className="space-y-3 pt-1"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <Field label={t('memos.composer.image_url')} required>
          <Input
            value={url}
            data-autofocus
            placeholder="https://example.com/image.png"
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => setUrl(event.target.value)}
          />
        </Field>
        <Field label={t('memos.composer.image_alt')}>
          <Input value={alt} onChange={(event) => setAlt(event.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('memos.composer.image_width')}>
            <Input
              value={width}
              inputMode="numeric"
              placeholder={t('memos.composer.image_size_auto')}
              onChange={(event) => setWidth(event.target.value)}
            />
          </Field>
          <Field label={t('memos.composer.image_height')}>
            <Input
              value={height}
              inputMode="numeric"
              placeholder={t('memos.composer.image_size_auto')}
              onChange={(event) => setHeight(event.target.value)}
            />
          </Field>
        </div>
        <Segmented
          value={align}
          label={t('memos.composer.image_align')}
          options={[
            { value: 'left', label: t('memos.composer.image_align_left') },
            { value: 'center', label: t('memos.composer.image_align_center') },
            { value: 'right', label: t('memos.composer.image_align_right') },
          ]}
          onChange={setAlign}
        />
      </form>
      {error ? (
        <p id={errorId} role="alert" className="mt-2 text-[length:var(--text-11-5)] text-[var(--danger)]">
          {error}
        </p>
      ) : null}
    </Modal>
  )
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
  const insertButtonRef = useRef<HTMLButtonElement>(null)
  const insertPanelId = useId()
  const [insertOpen, setInsertOpen] = useState(false)
  const [imageOpen, setImageOpen] = useState(false)

  const insertText = (text: string, cursorOffset?: number): void => {
    const view = viewRef.current
    if (!view) return
    const range = view.state.selection.main
    const source = view.state.doc.toString()
    const result = insertMemoSnippet(source, range.from, range.to, text, cursorOffset)
    view.dispatch({
      changes: { from: 0, to: source.length, insert: result.text },
      selection: EditorSelection.cursor(result.from),
      scrollIntoView: true,
      userEvent: 'input.insert',
    })
    view.focus()
  }

  useImperativeHandle(ref, () => ({
    insert(text: string) {
      insertText(text)
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
  const insertItems: MenuItem[] = [
    {
      id: 'table',
      label: t('memos.composer.table'),
      icon: <Table size={14} />,
      onSelect: () => insertText(TABLE_SNIPPET),
    },
    {
      id: 'callout',
      label: t('memos.composer.callout'),
      icon: <MessageSquareQuote size={14} />,
      onSelect: () => insertText(CALLOUT_SNIPPET),
    },
    {
      id: 'callout-toggle',
      label: t('memos.composer.callout_toggle'),
      icon: <ChevronsDownUp size={14} />,
      onSelect: () => insertText(TOGGLE_CALLOUT_SNIPPET),
    },
    {
      id: 'math',
      label: t('memos.composer.math_block'),
      icon: <Sigma size={14} />,
      onSelect: () => insertText(MATH_SNIPPET, MATH_CURSOR),
    },
    {
      id: 'code-block',
      label: t('memos.composer.code_block'),
      icon: <Code size={14} />,
      onSelect: () => insertText(CODE_SNIPPET, CODE_CURSOR),
    },
    {
      id: 'divider',
      label: t('memos.composer.divider'),
      icon: <Minus size={14} />,
      onSelect: () => insertText(DIVIDER_SNIPPET),
    },
    {
      id: 'image',
      label: t('memos.composer.image'),
      icon: <Image size={14} />,
      separatorBefore: true,
      onSelect: () => setImageOpen(true),
    },
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
        <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-[var(--border-subtle)]" />
        <IconButton
          ref={insertButtonRef}
          label={t('memos.composer.insert')}
          size="sm"
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={insertOpen}
          aria-controls={insertPanelId}
          onClick={() => setInsertOpen((open) => !open)}
        >
          <Plus size={14} />
        </IconButton>
      </div>
      <div ref={hostRef} data-memo-editor="" className="mt-1.5 min-w-0" />
      <Menu
        anchor={insertButtonRef}
        open={insertOpen}
        onClose={() => setInsertOpen(false)}
        items={insertItems}
        panelId={insertPanelId}
        label={t('memos.composer.insert_menu')}
        width={232}
      />
      <MemoImageDialog
        open={imageOpen}
        onClose={() => setImageOpen(false)}
        onInsert={(markdown) => {
          insertText(markdown)
          setImageOpen(false)
        }}
      />
    </div>
  )
}
