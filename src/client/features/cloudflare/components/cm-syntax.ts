/**
 * Syntax colours for the embedded CodeMirror editors.
 *
 * The colours are the notebook's own `--syntax-*` tokens, so a Worker script pasted into a note and a
 * Worker script edited here read the same way, and both follow the theme.
 */
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'

export const codeHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword, tags.controlKeyword], color: 'var(--syntax-keyword)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--syntax-string)' },
  { tag: [tags.number, tags.integer, tags.float], color: 'var(--syntax-number)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--syntax-function)' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: 'var(--syntax-type)' },
  { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: 'var(--syntax-property)' },
  { tag: [tags.operator, tags.arithmeticOperator, tags.logicOperator, tags.compareOperator, tags.bitwiseOperator], color: 'var(--syntax-operator)' },
  { tag: [tags.bool, tags.null, tags.atom, tags.self, tags.constant(tags.variableName)], color: 'var(--syntax-constant)' },
  { tag: [tags.punctuation, tags.separator, tags.bracket, tags.brace, tags.paren, tags.squareBracket], color: 'var(--syntax-punctuation)' },
  { tag: [tags.variableName, tags.local(tags.variableName), tags.standard(tags.variableName)], color: 'var(--syntax-variable)' },
  { tag: tags.meta, color: 'var(--syntax-comment)' },
])

export const codeHighlighting = syntaxHighlighting(codeHighlightStyle)
