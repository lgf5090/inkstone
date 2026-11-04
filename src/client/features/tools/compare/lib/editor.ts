/**
 * The editor surface the text comparison draws.
 *
 * Both sides are read-only: a comparison is a reading of two documents, and an edit made here would
 * silently become a third version nobody saved. The colours are the notebook's own `--syntax-*`
 * tokens, so a diff of a script reads the same as the same script in the editor.
 */
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, drawSelection, lineNumbers } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { languageExtension } from './languages'
import type { CompareLanguage } from '../store'

const highlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword, tags.controlKeyword], color: 'var(--syntax-keyword)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--syntax-string)' },
  { tag: [tags.number, tags.integer, tags.float], color: 'var(--syntax-number)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--syntax-function)' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: 'var(--syntax-type)' },
  { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: 'var(--syntax-property)' },
  { tag: [tags.operator, tags.arithmeticOperator, tags.logicOperator, tags.compareOperator], color: 'var(--syntax-operator)' },
  { tag: [tags.bool, tags.null, tags.atom, tags.self], color: 'var(--syntax-constant)' },
  { tag: [tags.punctuation, tags.separator, tags.bracket, tags.brace, tags.paren], color: 'var(--syntax-punctuation)' },
  { tag: [tags.variableName, tags.local(tags.variableName)], color: 'var(--syntax-variable)' },
])

/**
 * The merge view's own scroll surface.
 *
 * `@codemirror/merge` makes `.cm-mergeView` the scroller so both editors move together; giving it
 * the height this host has is what turns "a very tall page" into "a window onto the change". The
 * changed-line tints are set here because the package's defaults are greys that do not belong to
 * this palette.
 */
const compareTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--bg-base)',
    color: 'var(--text-primary)',
    fontSize: 'var(--text-12)',
  },
  '.cm-mergeView': { height: '100%', overflow: 'auto', backgroundColor: 'var(--bg-base)' },
  '.cm-mergeViewEditors': { borderTop: '1px solid var(--border-subtle)' },
  '.cm-mergeViewEditor': { borderRight: '1px solid var(--border-subtle)' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', lineHeight: '1.55' },
  '.cm-content': { padding: '4px 0', caretColor: 'transparent' },
  '.cm-line': { padding: '0 10px' },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-sunken)',
    color: 'var(--text-quaternary)',
    border: 'none',
    borderRight: '1px solid var(--border-subtle)',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 8px', minWidth: '22px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-merge-a .cm-changedLine, .cm-deleteMarker': { backgroundColor: 'color-mix(in srgb, var(--danger) 10%, transparent)' },
  '.cm-merge-b .cm-changedLine, .cm-insertMarker': { backgroundColor: 'color-mix(in srgb, var(--success) 10%, transparent)' },
  '.cm-deletedChunk': { backgroundColor: 'color-mix(in srgb, var(--danger) 8%, transparent)' },
  '.cm-changedText': {
    background: 'color-mix(in srgb, var(--accent) 22%, transparent)',
    borderRadius: '2px',
  },
  '.cm-changedLineGutter': { backgroundColor: 'color-mix(in srgb, var(--accent) 18%, transparent)' },
})

/** Extensions both sides carry, in one place so they cannot drift apart. */
export function compareBaseExtensions(language: CompareLanguage, filename: string): Extension[] {
  return [
    lineNumbers(),
    drawSelection(),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorState.tabSize.of(4),
    syntaxHighlighting(highlightStyle),
    compareTheme,
    ...languageExtension(language, filename),
  ]
}

/** The inline (unified) view is a single editable-looking editor that is also read-only. */
export function compareSingleExtensions(language: CompareLanguage, filename: string): Extension[] {
  return compareBaseExtensions(language, filename)
}
