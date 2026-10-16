/**
 * The composer's inline triggers: `@` cites a note, `/` picks a tool, `#` narrows the knowledge base.
 *
 * A trigger is a sigil that opens a token — at the caret's start or after whitespace — followed by the
 * words typed since. It ends at the next whitespace, so `[[a]] @no` reads `no` as the query and leaves
 * the rest of the message alone. Detection is a pure function of the text and the caret because both the
 * panel and the keyboard handler need the same answer, and a drift between them shows up as a panel that
 * filters one string while replacing another.
 */
import { useEffect, useMemo, useRef } from 'react'
import { Check, FileText, Folder, Hash, Wrench, X } from 'lucide-react'
import { ASSISTANT_TOOL_SPECS, type AssistantTurnScope } from '@shared/assistant'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'

export type TriggerSigil = '@' | '/' | '#'

export interface ActiveTrigger {
  sigil: '@' | '/' | '#'
  query: string
  /** Where the token starts in the text, so picking a row can splice exactly it out. */
  start: number
}

/** The characters a trigger may be preceded by. Anything else makes it part of a word, not a trigger. */
const TRIGGER_BOUNDARY = /(^|\s)$/

export function detectTrigger(text: string, caret: number): ActiveTrigger | null {
  const before = text.slice(0, caret)
  const match = /([@/#])([^\s]*)$/.exec(before)
  if (!match) return null
  const sigil = match[1] as TriggerSigil
  const start = caret - match[0].length
  // `a@b` is an email fragment and `//` is a path: only a sigil that opens a token triggers.
  if (!TRIGGER_BOUNDARY.test(text.slice(0, start))) return null
  // A doubled sigil is the reader typing punctuation, not looking for a note or a tool.
  if ((match[2] ?? '').startsWith(sigil)) return null
  return { sigil, query: match[2] ?? '', start }
}

export interface TriggerRow {
  id: string
  label: string
  hint?: string
  /** A destructive tool says so before the reader finds out from an approval card. */
  danger?: boolean
  /** Which kind a `#` row is, so picking one does not have to guess from its words. */
  kind?: 'tag' | 'folder'
}

export const TOOL_TRIGGER_ROWS: TriggerRow[] = ASSISTANT_TOOL_SPECS.map((spec) => ({
  id: spec.name,
  label: t(spec.labelKey),
  hint: t(spec.permission === 'read' ? 'assistant.trigger.read' : spec.permission === 'write' ? 'assistant.trigger.write' : 'assistant.trigger.destructive'),
  danger: spec.permission === 'destructive',
}))

export function filterRows(rows: TriggerRow[], query: string): TriggerRow[] {
  const needle = query.toLocaleLowerCase()
  if (!needle) return rows.slice(0, TRIGGER_LIMIT)
  return rows.filter((row) => row.label.toLocaleLowerCase().includes(needle) || row.id.toLocaleLowerCase().includes(needle))
    .slice(0, TRIGGER_LIMIT)
}

/** Enough rows to scan at a glance; a longer list is a search, not a picker. */
const TRIGGER_LIMIT = 8

export function triggerIcon(sigil: TriggerSigil) {
  if (sigil === '@') return FileText
  if (sigil === '/') return Wrench
  return Hash
}

export function TriggerPanel({
  sigil,
  rows,
  activeIndex,
  busy,
  onHover,
  onPick,
}: {
  sigil: TriggerSigil
  rows: TriggerRow[]
  activeIndex: number
  busy: boolean
  onHover: (index: number) => void
  onPick: (row: TriggerRow) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const Icon = useMemo(() => triggerIcon(sigil), [sigil])
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-row="${activeIndex}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])
  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={t(sigil === '@' ? 'assistant.trigger.notes' : sigil === '/' ? 'assistant.trigger.tools' : 'assistant.trigger.scopes')}
      className="max-h-64 overflow-y-auto rounded-t-[var(--r-xl)] border-x border-t border-[var(--border-default)] bg-[var(--bg-surface)] p-1 pb-1.5 shadow-[var(--shadow-sm)]"
    >
      <p className="mb-0.5 flex items-center gap-1.5 px-2.5 py-1.5 text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">
        <Icon size={11} />
        {t('assistant.trigger.hint')}
      </p>
      {busy && <p className="px-2.5 py-2 text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('common.loading')}</p>}
      {!busy && !rows.length && <p className="px-2.5 py-2 text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('assistant.trigger.none')}</p>}
      {rows.map((row, index) => (
        <button
          key={row.id}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          data-row={index}
          onMouseEnter={() => onHover(index)}
          onClick={() => onPick(row)}
          className={cn(
            'flex w-full items-center gap-2 rounded-[var(--r-md)] px-2.5 py-1.5 text-left text-[length:var(--text-12-5)]',
            'transition-colors duration-[var(--dur-fast)]',
            index === activeIndex
              ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
          )}
        >
          <span className="min-w-0 flex-1 truncate">{row.label}</span>
          {row.hint && (
            <span className={cn('shrink-0 text-[length:var(--text-10-5)]', row.danger ? 'text-[var(--warning)]' : 'text-[var(--text-quaternary)]')}>{row.hint}</span>
          )}
          {index === activeIndex && <Check size={12} className="shrink-0" />}
        </button>
      ))}
    </div>
  )
}

export function scopeIcon(kind: 'tag' | 'folder') {
  return kind === 'folder' ? Folder : Hash
}

/**
 * What `/` and `#` added to this turn, where the reader can still see and undo it.
 *
 * A pin that left no trace would read as a hidden instruction to the model: the chips name the tools and
 * the scopes, and the X is the only way to take them back off.
 */
export function TurnPinRow({
  tools,
  scopes,
  onDropTool,
  onDropScope,
}: {
  tools: string[]
  scopes: AssistantTurnScope[]
  onDropTool: (name: string) => void
  onDropScope: (id: string) => void
}) {
  if (!tools.length && !scopes.length) return null
  const chip = (key: string, Icon: typeof Wrench, label: string, onDrop: () => void, dropLabel: string) => (
    <span key={key} className="flex max-w-full items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-default)] bg-[var(--bg-sunken)] py-[1px] pl-1.5 pr-0.5 text-[length:var(--text-11)] text-[var(--text-secondary)]">
      <Icon size={11} className="shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
      <button type="button" onClick={onDrop} aria-label={dropLabel} className="flex size-4 shrink-0 items-center justify-center rounded-full hover:text-[var(--danger)]">
        <X size={9} />
      </button>
    </span>
  )
  return (
    <div className="flex flex-wrap gap-1 px-1.5 pb-1">
      {tools.map((name) => chip(`tool-${name}`, Wrench, name, () => onDropTool(name), t('assistant.trigger.drop_tool', { name })))}
      {scopes.map((entry) => chip(
        `scope-${entry.id}`,
        entry.kind === 'folder' ? Folder : entry.kind === 'note' ? FileText : Hash,
        entry.name,
        () => onDropScope(entry.id),
        t('assistant.trigger.drop_scope', { name: entry.name }),
      ))}
    </div>
  )
}
