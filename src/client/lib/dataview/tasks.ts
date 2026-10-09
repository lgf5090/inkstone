/**
 * Rewriting a task line in a note the reader is not currently editing.
 *
 * A query result is a picture of another note's line, so ticking its checkbox has to edit that line and
 * nothing else. The reference plugin does the same, and the rules that matter are the safety checks: the
 * line must still be the list item the result was built from, its text must still match, and the bullet
 * character and indentation belong to the author rather than to this code.
 *
 * Everything here is pure over a string so the rewrite can be tested without a store or a DOM.
 */

const LIST_ITEM_RE = /^([ \t]*(?:>\s*)*)(?:(\d+)[.)]|([-+*]))\s+\[([^\]])\]\s?(.*)$/
const BLOCK_ID_RE = /(\s*\^[\w-]+\s*)$/

export interface TaskCompletionSettings {
    /** Add or remove the completion marker whenever a task changes state. */
    tracked: boolean
    /** Write `✅ YYYY-MM-DD` rather than `[completion:: YYYY-MM-DD]`. */
    emojiShorthand: boolean
    /** The inline field name the marker uses when it is not the emoji. */
    key: string
    /** Pattern for the date, in the same token language the query language uses. */
    dateFormat: string
    /** Carry the change down to the task's own sub-tasks. */
    recursive: boolean
}

export interface TaskTarget {
    /** Zero-based line index the result was extracted from. */
    line: number
    /** The task's text as the reader saw it, used to refuse a stale line. */
    text: string
}

/** Rewrite one task line to `completed`, plus its completion marker and (optionally) its children. */
export function rewriteTask(source: string, target: TaskTarget, completed: boolean, settings: TaskCompletionSettings, now: Date): string | null {
    const eol = source.includes('\r\n') ? '\r\n' : '\n'
    const lines = source.split(/\r?\n/u)
    if (lines.length <= target.line) return null
    const first = rewriteLine(lines[target.line]!, completed, settings, now, target.text)
    if (first === null) return null
    lines[target.line] = first
    if (settings.recursive) cascade(lines, target.line, completed, settings, now)
    return lines.join(eol)
}

/**
 * The lines below `index` that belong to it: deeper indentation, until something shallow enough or a
 * blank-then-shallow run ends the subtree. Sub-tasks of a sub-task go too, which is what "recursive"
 * means to a reader who just ticked a parent.
 */
function cascade(lines: string[], index: number, completed: boolean, settings: TaskCompletionSettings, now: Date): void {
    const base = indentOf(lines[index]!)
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
        const line = lines[cursor]!
        if (!line.trim()) continue
        if (indentOf(line) <= base) break
        const rewritten = rewriteLine(line, completed, settings, now)
        if (rewritten !== null) lines[cursor] = rewritten
    }
}

/** One line's status, its completion marker, and nothing else about it. */
function rewriteLine(line: string, completed: boolean, settings: TaskCompletionSettings, now: Date, expect?: string): string | null {
    const match = LIST_ITEM_RE.exec(line)
    if (!match) return null
    const [, spacing, ordered, bullet, , text] = match
    if (expect !== undefined && normalizeText(text ?? '') !== normalizeText(expect)) return null
    const symbol = ordered ? `${ordered}${line.includes(`${ordered}.`) ? '.' : ')'}` : bullet!
    const blockId = BLOCK_ID_RE.exec(text ?? '')?.[1] ?? ''
    const body = blockId ? (text ?? '').slice(0, (text ?? '').length - blockId.length) : (text ?? '')
    let next = `${spacing}${symbol} [${completed ? 'x' : ' '}] ${body}`.trimEnd()
    if (settings.tracked) next = applyCompletion(next, completed, settings, now)
    return `${blockId ? `${next} ${blockId.trim()}` : next}`
}

/** Add today's date to the completion marker, or take it away. */
function applyCompletion(line: string, completed: boolean, settings: TaskCompletionSettings, now: Date): string {
    const date = formatDate(now, settings.dateFormat)
    if (settings.emojiShorthand) {
        const stripped = line.replace(/\s*✅\s*\d{4}-\d{2}-\d{2}/gu, '')
        return completed ? `${stripped} ✅ ${date}` : stripped
    }
    const key = settings.key.trim() || 'completion'
    const stripped = setInlineField(line, key)
    return completed ? setInlineField(stripped, key, date) : stripped
}

/**
 * Replace, append or remove one `[key:: value]` on a line. Removal is what un-ticking a task means, and
 * it has to leave the rest of the line's prose exactly as the author wrote it.
 */
export function setInlineField(line: string, key: string, value?: string): string {
    const pattern = new RegExp(`\\[\\s*${escapeRegExp(key)}\\s*::[^\\]]*\\]\\s*`, 'iu')
    const without = line.replace(pattern, '')
    if (value === undefined) return without.trimEnd()
    const gap = without.length && !/\s$/.test(without) ? ' ' : ''
    return `${without}${gap}[${key}:: ${value}]`
}

function indentOf(line: string): number {
    const lead = /^[ \t]*/.exec(line)?.[0] ?? ''
    return lead.replace(/\t/g, '    ').length
}

function normalizeText(text: string): string {
    return text.trim().replace(/\s+/gu, ' ')
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function formatDate(date: Date, pattern: string): string {
    const pad = (value: number) => String(value).padStart(2, '0')
    return pattern
        .replace(/yyyy/gu, String(date.getFullYear()))
        .replace(/MM/gu, pad(date.getMonth() + 1))
        .replace(/dd/gu, pad(date.getDate()))
}
