/**
 * `<%+ … %>`: the commands a note asks its own preview to run.
 *
 * Upstream registers this as a Markdown *post-processor* — it walks the rendered DOM, finds the text that still
 * says `<%+ … %>`, runs each command, and puts the answer where the source was (`Templater.ts:463-535`). The
 * same shape is what fits this app: the note body itself is never rewritten, so a reader who reloads sees the
 * command again and it runs again, and the text they wrote stays theirs.
 *
 * Two deliberate differences from upstream, both of which are the plan's calls rather than mine:
 *
 * - Code is left alone. Upstream filters nothing, so a `<%+ … %>` inside a fenced block or an inline span is
 *   executed there too; this pass skips anything under `pre`, `code` or `textarea`, because quoting a command
 *   to talk about it is the common case in a note about templates.
 * - A failure stays local. Upstream logs a Notice and leaves the rest of the document unprocessed; here the
 *   failing command is marked in place, with its reason reachable by keyboard, and the other commands still
 *   run. Nothing is toasted, because the reader is looking at the sentence it happened in.
 *
 * What may run is decided by the `dynamic` capability profile — prompts yes, writes, network, clipboard and
 * the reader's scripts no — and by this file being mounted from one place: the note preview. The share page,
 * an export, a hover card and a chat answer never call it, so a `<%+ … %>` there stays the source text it is
 * in the file.
 */
import type { Note } from '@shared/types'
import { useNotes } from '../../store/notes'
import { DYNAMIC_COMMAND, hasDynamicCommand } from '../../lib/templater/detection'
import { renderDynamicCommand } from './run-shell'

/** The elements whose text is quoted rather than lived: a code fence, an inline span, a field. */
const QUOTED = 'pre, code, textarea'

/** How deep an embed may sit and still have its own commands run; `lib/markdown/embeds.ts` stops at 4. */
const MAX_EMBED_DEPTH = 4

/** What one pass did, as data — a caller that wants to say something about it can, and the tests read it. */
export interface DynamicCommandReport {
  found: number
  ran: number
  failed: number
  /** Commands left exactly as written, because the note they belong to cannot be named. */
  skipped: number
}

/** Nodes that already carry an answer, or already carry the reason there is none. */
const PROCESSED = '[data-templater-dynamic]'

function ownerOf(node: Node): { note: Note | null; depth: number } {
  let depth = 0
  for (let el = node.parentElement; el !== null; el = el.parentElement) {
    if (el.hasAttribute('data-embed-target')) depth += 1
  }
  if (depth === 0) return { note: null, depth }
  // The innermost embed is the note whose title a command inside it means. An embed of an embed keeps the
  // inner one, which is the same rule `resolveNoteEmbeds` reads the tree with.
  const target = innermostEmbed(node)
  return { note: target === null ? null : resolveEmbed(target), depth }
}

function innermostEmbed(node: Node): string | null {
  for (let el = node.parentElement; el !== null; el = el.parentElement) {
    const target = el.getAttribute('data-embed-target')
    if (target !== null && target !== '') return target
  }
  return null
}

/**
 * The note an embed target names, if this library still has it.
 *
 * Embed targets are link text — a title, with an optional `.md` and an optional `#heading` — so the match is
 * the same loose one the embed pass uses. `null` is not a failure to report: a command whose note cannot be
 * named has no `tp.file.title` to answer with, and printing the source is the honest answer.
 */
function resolveEmbed(target: string): Note | null {
  const wanted = target.split('#')[0]!.trim().replace(/\.md$/i, '').toLowerCase()
  if (wanted === '') return null
  const notes = useNotes.getState().notes
  for (const id of Object.keys(notes)) {
    const note = notes[id]!
    if (note.title.trim().toLowerCase() === wanted) return { ...note, content: '' } as Note
  }
  return null
}

/** The text nodes under `root` that are prose rather than quoted code, in document order. */
function candidateNodes(root: HTMLElement): Text[] {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const value = node.nodeValue
      if (value === null || !hasDynamicCommand(value)) return NodeFilter.FILTER_REJECT
      if (node.parentElement?.closest(`${QUOTED}, ${PROCESSED}`) !== null) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) nodes.push(node as Text)
  return nodes
}

/** Replace one matched range with a marked inline element, so the next pass cannot meet it again. */
function mark(node: Text, start: number, end: number, state: 'ok' | 'error' | 'skipped', text: string, reason?: string): HTMLSpanElement {
  const span = document.createElement('span')
  span.dataset.templaterDynamic = state
  const rest = node.nodeValue ?? ''
  const before = rest.slice(0, start)
  const after = rest.slice(end)
  span.textContent = text
  if (reason !== undefined) {
    // Reachable without a pointer: the title is the sighted reader's hover, the label is the screen reader's,
    // and the tab stop is what makes either of them arrive while reading the sentence top to bottom.
    span.title = reason
    span.setAttribute('role', 'note')
    span.setAttribute('aria-label', reason)
    span.tabIndex = 0
  }
  const parent = node.parentNode
  if (parent === null) return span
  const fragment = document.createDocumentFragment()
  if (before !== '') fragment.append(document.createTextNode(before))
  fragment.append(span)
  if (after !== '') fragment.append(document.createTextNode(after))
  parent.replaceChild(fragment, node)
  return span
}

/**
 * Run the dynamic commands of one rendered note.
 *
 * Sequential, like upstream: two commands in one paragraph share a note, a clock and any prompt the reader is
 * asked to answer, and interleaving them would let the second read a context the first is still holding.
 *
 * `note` is the note whose preview this is — the file every command outside an embed resolves against. A
 * command inside an embed is asked against the embedded note instead, and is left as written when that note
 * cannot be named.
 */
export async function processDynamicCommands(root: HTMLElement, note: Note | null): Promise<DynamicCommandReport> {
  const report: DynamicCommandReport = { found: 0, ran: 0, failed: 0, skipped: 0 }
  for (const node of candidateNodes(root)) {
    let current: Text = node
    for (;;) {
      const value = current.nodeValue ?? ''
      DYNAMIC_COMMAND.lastIndex = 0
      const match = DYNAMIC_COMMAND.exec(value)
      if (match === null) break
      report.found += 1
      const start = match.index
      const end = start + match[0].length
      const source = match[0]
      const command = `${match[1]}${match[2]}`
      const { note: embed, depth } = ownerOf(current)
      if (depth >= MAX_EMBED_DEPTH || (depth > 0 && embed === null)) {
        // No nameable note to answer `tp.file.title` with, or a note embedded deep enough that the embed pass
        // itself would have stopped rendering it. Either way the source is what the reader should see.
        report.skipped += 1
        const tail = mark(current, start, end, 'skipped', source).nextSibling
        if (tail === null || tail.nodeType !== Node.TEXT_NODE) break
        current = tail as Text
        continue
      }
      const answer = await renderDynamicCommand(command, embed ?? note)
      if (!current.isConnected) return report
      // A run may have opened a dialog, and a dialog may have re-rendered this preview: the node this match
      // lived in can be gone by the time the answer arrives, and writing into it would be writing into a
      // document the reader no longer looks at.
      if (!answer.ok) {
        report.failed += 1
        const tail = mark(current, start, end, 'error', source, answer.error).nextSibling
        if (tail === null || tail.nodeType !== Node.TEXT_NODE) break
        current = tail as Text
        continue
      }
      report.ran += 1
      const tail = mark(current, start, end, 'ok', answer.output).nextSibling
      if (tail === null || tail.nodeType !== Node.TEXT_NODE) break
      current = tail as Text
    }
  }
  return report
}
