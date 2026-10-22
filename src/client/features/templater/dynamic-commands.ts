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
import { renderDynamicCommands } from './run-shell'

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

/** One command read out of a text node, and where in that text it sat. */
interface Found {
  start: number
  end: number
  /** The source as written, which is what stays on screen when the answer is a refusal. */
  source: string
  /** The tag and its body, which is what the engine is handed. */
  command: string
}

/** What one found command ends up showing, and the reason a reader can reach for it. */
interface Marked {
  state: 'ok' | 'error' | 'skipped'
  text: string
  reason?: string
}

/** One text node, the note its commands are asked against, and everything found inside it. */
interface Site {
  node: Text
  owner: Note | null
  founds: Found[]
}

/** Every `<%+ … %>` in one text run, in the order they appear. */
function foundIn(value: string): Found[] {
  const founds: Found[] = []
  DYNAMIC_COMMAND.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = DYNAMIC_COMMAND.exec(value)) !== null) {
    founds.push({
      start: match.index,
      end: match.index + match[0].length,
      source: match[0],
      command: `${match[1]}${match[2]}`,
    })
  }
  DYNAMIC_COMMAND.lastIndex = 0
  return founds
}

/**
 * Write the answers back into one text node, right to left.
 *
 * `mark` replaces the node it is given, so a second write into the same node has to go into the text that
 * survived to the left of the first. Working from the last command backwards is what keeps every earlier
 * offset measured in the text it was found in — working forwards would shift each one by the width of the
 * answer that replaced it.
 */
function write(node: Text, founds: Found[], marks: Marked[]): void {
  let current: Text | null = node
  for (let index = founds.length - 1; index >= 0 && current !== null; index -= 1) {
    const found = founds[index]!
    const entry = marks[index]!
    const span = mark(current, found.start, found.end, entry.state, entry.text, entry.reason)
    const before = span.previousSibling
    current = before !== null && before.nodeType === Node.TEXT_NODE ? before as Text : null
  }
}

/**
 * Run the dynamic commands of one rendered note.
 *
 * Two passes rather than one walk that asks as it goes: the commands are collected first, a note's worth of
 * them goes to the engine in one run, and the answers are written back afterwards. Asking while walking paid
 * a worker round-trip per command, which is one parse, one compiled program and one interpreter context per
 * sentence — and a paragraph that asks the same clock three times is one paragraph, not three.
 *
 * Order is kept where it matters: commands are handed over in document order, one run per note the commands
 * belong to, so two commands in one paragraph still share a clock and any prompt the reader is asked to
 * answer. A run may open a dialog, and a dialog may re-render this preview — a node that has gone by the
 * time the answers arrive is left alone, because the document the reader is looking at no longer has it.
 *
 * `note` is the note whose preview this is — the file every command outside an embed resolves against. A
 * command inside an embed is asked against the embedded note instead, and is left as written when that note
 * cannot be named.
 */
export async function processDynamicCommands(root: HTMLElement, note: Note | null): Promise<DynamicCommandReport> {
  const report: DynamicCommandReport = { found: 0, ran: 0, failed: 0, skipped: 0 }
  const sites: Site[] = []
  for (const node of candidateNodes(root)) {
    const founds = foundIn(node.nodeValue ?? '')
    if (founds.length === 0) continue
    report.found += founds.length
    const { note: embed, depth } = ownerOf(node)
    if (depth >= MAX_EMBED_DEPTH || (depth > 0 && embed === null)) {
      // No nameable note to answer `tp.file.title` with, or a note embedded deep enough that the embed pass
      // itself would have stopped rendering it. Either way the source is what the reader should see.
      report.skipped += founds.length
      write(node, founds, founds.map((one): Marked => ({ state: 'skipped', text: one.source })))
      continue
    }
    sites.push({ node, owner: embed ?? note, founds })
  }
  // One batch per note the commands belong to: an embedded note's commands are asked against that note, and
  // the map keeps the first site seen for each owner so the groups stay in document order.
  const groups = new Map<Note | null, Site[]>()
  for (const site of sites) {
    const existing = groups.get(site.owner)
    if (existing) existing.push(site)
    else groups.set(site.owner, [site])
  }
  const marks = new Map<Site, Marked[]>()
  for (const [owner, group] of groups) {
    const commands = group.flatMap((site) => site.founds.map((found) => found.command))
    const answers = await renderDynamicCommands(commands, owner)
    let cursor = 0
    for (const site of group) {
      marks.set(site, site.founds.map((found): Marked => {
        const answer = answers[cursor++]
        if (answer === undefined) {
          // The batch came back with fewer answers than it was handed. Nothing is guessed from that: the
          // command keeps its source on screen, the way a command with no note behind it does.
          return { state: 'skipped', text: found.source }
        }
        if (!answer.ok) return { state: 'error', text: found.source, reason: answer.error }
        return { state: 'ok', text: answer.output }
      }))
    }
  }
  for (const site of sites) {
    const entry = marks.get(site)
    if (entry === undefined) continue
    // A run may have opened a dialog, and a dialog may have re-rendered this preview. The document the
    // reader is looking at is then a different one and will be walked again, so nothing here is written —
    // and nothing here is counted as having run.
    if (!site.node.isConnected) continue
    for (const one of entry) {
      if (one.state === 'ok') report.ran += 1
      else if (one.state === 'error') report.failed += 1
      else report.skipped += 1
    }
    write(site.node, site.founds, entry)
  }
  return report
}
