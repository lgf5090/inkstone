import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import { t, type MessageKey } from '../../lib/i18n'

export type MemoSlashId =
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bullet'
  | 'ordered'
  | 'task'
  | 'quote'
  | 'code'
  | 'divider'

interface MemoSlashAction {
  id: MemoSlashId
  labelKey: MessageKey
  params?: Record<string, string>
  keywords: string[]
}

export const MEMO_SLASH_ACTIONS: readonly MemoSlashAction[] = [
  { id: 'h1', labelKey: 'memos.composer.heading_level', params: { level: '1' }, keywords: ['h1', 'heading', 'title'] },
  { id: 'h2', labelKey: 'memos.composer.heading_level', params: { level: '2' }, keywords: ['h2', 'heading', 'subtitle'] },
  { id: 'h3', labelKey: 'memos.composer.heading_level', params: { level: '3' }, keywords: ['h3', 'heading'] },
  { id: 'bullet', labelKey: 'memos.composer.bullet_list', keywords: ['bullet', 'list', 'unordered'] },
  { id: 'ordered', labelKey: 'memos.composer.ordered_list', keywords: ['ordered', 'number', 'list'] },
  { id: 'task', labelKey: 'memos.composer.task_list', keywords: ['task', 'todo', 'checkbox'] },
  { id: 'quote', labelKey: 'memos.composer.quote', keywords: ['quote', 'blockquote'] },
  { id: 'code', labelKey: 'memos.composer.code_block', keywords: ['code', 'fence', 'block'] },
  { id: 'divider', labelKey: 'memos.composer.divider', keywords: ['divider', 'rule', 'separator'] },
]

const SLASH_TOKEN_RE = /\/[A-Za-z0-9]*$/
const WORD_BOUNDARY_RE = /[\s(\uFF08\u3010\u300C\u300E\uFF0C,\u3001;\uFF1B]/
const EXISTING_PREFIX_RE = /^(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|>\s+|\d+\.\s+)/

export interface MemoSlashEdit {
  text: string
  cursor: number
}

export function memoSlashEdit(
  line: string,
  slashStart: number,
  tokenEnd: number,
  id: MemoSlashId,
): MemoSlashEdit {
  const beforeToken = line.slice(0, slashStart)
  const leading = /^\s*/.exec(beforeToken)?.[0] ?? ''
  const remaining = beforeToken.slice(leading.length) + line.slice(tokenEnd)
  const body = remaining.replace(EXISTING_PREFIX_RE, '').replace(/^\s+/, '')

  if (id === 'code') {
    const text = `${leading}\`\`\`\n${body}\n\`\`\``
    return { text, cursor: leading.length + 4 }
  }
  if (id === 'divider') {
    const text = body ? `${leading}${body}\n\n---` : `${leading}---`
    return { text, cursor: text.length }
  }

  const prefix = id === 'h1' ? '# '
    : id === 'h2' ? '## '
      : id === 'h3' ? '### '
        : id === 'bullet' ? '- '
          : id === 'ordered' ? '1. '
            : id === 'task' ? '- [ ] '
              : '> '
  const text = `${leading}${prefix}${body}`
  return { text, cursor: leading.length + prefix.length + body.length }
}

export function memoSlashSource(context: CompletionContext): CompletionResult | null {
  const before = context.matchBefore(SLASH_TOKEN_RE)
  if (!before) return null
  const line = context.state.doc.lineAt(context.pos)
  if (before.from > line.from) {
    const previous = context.state.sliceDoc(before.from - 1, before.from)
    if (!WORD_BOUNDARY_RE.test(previous)) return null
  }
  const query = before.text.slice(1).toLowerCase()
  const options: Completion[] = MEMO_SLASH_ACTIONS
    .filter((action) => !query || action.keywords.some((keyword) => keyword.startsWith(query)))
    .map((action) => ({
      label: t(action.labelKey, action.params),
      detail: `/${action.id}`,
      type: 'keyword',
      apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
        const target = view.state.doc.lineAt(from)
        const edit = memoSlashEdit(target.text, from - target.from - 1, to - target.from, action.id)
        view.dispatch({
          changes: { from: target.from, to: target.to, insert: edit.text },
          selection: { anchor: target.from + edit.cursor },
          scrollIntoView: true,
          userEvent: 'input.complete',
        })
      },
    }))
  if (!options.length) return null
  return {
    from: before.from + 1,
    options,
    filter: false,
  }
}
