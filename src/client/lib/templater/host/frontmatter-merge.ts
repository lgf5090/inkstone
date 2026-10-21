/**
 * The front matter half of putting a rendered template into a note.
 *
 * Two jobs, both of them about not damaging what the reader already wrote: split rendered text into its
 * `---` block and its body, then merge the block's keys into the note's existing block. The rules are
 * Templater 2.26.0's — `get_frontmatter_and_content` and `merge_objects` in `src/utils/Utils.ts`, and
 * the primitives / lists / duplicate-values / mixed-types cases of its `test/specs/templater.e2e.ts`
 * (AGPL-3.0-only) are the oracle — while the implementation is this repo's own, written against the
 * `yaml` Document API. Every branch that deliberately does something other than upstream says so.
 *
 * The Document API is not a stylistic preference. Rebuilding a block from
 * `{ ...existing, ...incoming }` would also rewrite the reader's quoting style, delete their comments
 * and turn `tags: [a, b]` into three lines, on every template insert. The properties panel made the
 * same choice for the same reason (`parseFrontMatter`, `setFrontMatterValue`, `appendFrontMatterTag` in
 * `@shared/markdown-utils`), and the two writers must agree byte for byte where they can, because they
 * write the same notes.
 */
import { isMap, isNode, isSeq, parseDocument, type Pair, type YAMLMap } from 'yaml'
import { parseFrontMatter } from '@shared/markdown-utils'

/**
 * Rendered template text, cut into the two halves a write needs.
 *
 * The offsets are what make this usable without a second pass: `bodyStart` is where the body begins
 * inside the string that was handed in, so a caller holding marker positions measured in the rendered
 * text can move them into body coordinates by subtracting it and knows that anything ahead of it is
 * inside the block.
 */
export interface RenderedSplit {
  /** The `---` block exactly as written, fence lines included; empty when there is no usable block. */
  block: string
  /** The YAML inside the block, fence lines excluded; empty when there is no block. */
  raw: string
  /** The block's values; empty when there is no block or when it did not parse. */
  frontmatter: Record<string, unknown>
  /** Everything after the block — or the whole text, when the block is not usable. */
  body: string
  /** Where `body` begins inside the text that was given. */
  bodyStart: number
  /** Whether a block was present but is not a mapping that can be merged. */
  invalid: boolean
  /** The parser's own messages, for a log or a diagnostic; never a reader-facing sentence. */
  errors: string[]
}

/**
 * Split rendered output into front matter and body.
 *
 * The interesting case is the one that has to be decided rather than copied: a block whose content is
 * not valid YAML. Upstream keeps the whole text as body (`get_frontmatter_and_content` returns
 * `{ frontmatter: {}, content }` from its `catch`) rather than discarding the unparsable lines, and its
 * `append_template_to_active_file inserts % directive template into note with valid YAML` spec pins the
 * result — the template's `---\naliases:\n- %\n---` appears verbatim in the note's prose. This does the
 * same, and reports it through `invalid` so the caller can say why nothing was merged.
 *
 * The block and the body are cut out of the text the caller gave rather than taken from
 * `parseFrontMatter`, for two fidelity reasons: that function rejoins its body with `\n`, which would
 * rewrite a CRLF note line for line, and it drops a leading BOM, which is part of the stored file. The
 * line *count* is still its, so the two halves always meet exactly at `bodyStart`.
 */
export function splitRendered(content: string): RenderedSplit {
  const parsed = parseFrontMatter(content)
  const invalid = parsed.errors.length > 0
  const lines = content.split('\n')
  const found = parsed.lineOffset > 0
  const body = invalid || !found ? content : lines.slice(parsed.lineOffset).join('\n')
  const block = invalid || !found ? '' : lines.slice(0, parsed.lineOffset).join('\n')
  return {
    block,
    // Kept even for a block that does not parse: it is the text the caller must not rewrite.
    raw: found ? parsed.raw : '',
    frontmatter: parsed.data,
    body,
    bodyStart: content.length - body.length,
    invalid,
    errors: parsed.errors,
  }
}

/**
 * What happened to one key of the note's front matter.
 *
 * `shape-replaced` is separated from `overwritten` on purpose: it is the case where the template's
 * value has a different *type* than the property the reader chose, so a list becomes a scalar or a
 * scalar becomes a list, and a page that wants to warn about that has to be able to see it.
 */
export type FrontMatterChangeAction = 'added' | 'merged' | 'overwritten' | 'shape-replaced' | 'kept'

export interface FrontMatterChange {
  key: string
  action: FrontMatterChangeAction
}

/** `note-invalid` is the refusal: the block was left exactly as the reader wrote it. */
export type FrontMatterMergeStatus = 'merged' | 'unchanged' | 'note-invalid'

export interface FrontMatterMerge {
  /** The block's YAML after the merge, fences excluded; `existing` verbatim unless `changed`. */
  yaml: string
  /** Whether anything at all was written, which is the caller's test for touching the note. */
  changed: boolean
  status: FrontMatterMergeStatus
  /** One entry per key the template carried, at the top level of the block. */
  changes: FrontMatterChange[]
}

/**
 * Merge a template's front matter into the note's own block, key by key.
 *
 * `existing` is the YAML text between the note's fences — `''` when the note has no block — and
 * `incoming` is the parsed block of the rendered output. The note's document is the thing that is
 * modified, so every part of it the merge does not need to change keeps its original token: quoting,
 * comments, block-versus-flow style, and the order the reader put their properties in. What is *not*
 * guaranteed is the whitespace between a key and its colon — a pair the writer re-emits is re-emitted
 * with one space, which is what `@shared/markdown-utils` does for a property edit too.
 *
 * The rules, each pinned by a test named after the upstream spec that states it:
 * - a key only in the template is appended at the end, never sorted into the middle;
 * - a key in both, with two scalars: the template wins, unless its value is empty;
 * - a key in both, with two lists: concatenated, then de-duplicated first-wins;
 * - a key in both, with two mappings: merged by the same rules;
 * - a key in both whose types differ: the template's shape replaces the reader's (see the branch);
 * - nothing is written when the merge changed nothing, so an insert that adds no property leaves the
 *   note's bytes alone instead of re-emitting them.
 */
export function mergeFrontMatter(existing: string, incoming: Record<string, unknown>): FrontMatterMerge {
  const document = parseDocument(existing, { prettyErrors: false, uniqueKeys: true })
  // A block this module cannot read is a block this module must not rewrite. Repairing it, or replacing
  // it with the template's block, would delete the reader's unparsable lines — which are their data
  // until proven otherwise — so the text comes back untouched and the caller reports the refusal.
  // `uniqueKeys` makes a duplicated key an error here too: merging into an ambiguous block would pick
  // one of the reader's two spellings without telling them which.
  const contents = document.contents
  if (document.errors.length > 0) return { yaml: existing, changed: false, status: 'note-invalid', changes: [] }
  if (contents !== null && !isMap(contents)) {
    return { yaml: existing, changed: false, status: 'note-invalid', changes: [] }
  }
  const keys = Object.keys(incoming)
  if (keys.length === 0) return { yaml: existing, changed: false, status: 'unchanged', changes: [] }

  // A note with no block has nothing to merge *into*, so every template key is an addition and there is
  // no reader formatting to preserve. `Document.set` also builds the mapping `parseDocument('')` left
  // missing, which printing a null document would otherwise turn into the word `null`.
  if (contents === null) {
    const changes = keys.map((key): FrontMatterChange => {
      document.set(key, incoming[key])
      return { key, action: 'added' }
    })
    return { yaml: printed(document), changed: true, status: 'merged', changes }
  }

  const merged = mergeInto(document, contents, incoming)
  const changed = merged.touched
  return {
    yaml: changed ? printed(document) : existing,
    changed,
    status: changed ? 'merged' : 'unchanged',
    changes: merged.changes,
  }
}

interface NestedMerge {
  changes: FrontMatterChange[]
  touched: boolean
}

/** The recursion over one mapping. Only the top level's keys are reported; a nested write is the parent key's `merged`. */
function mergeInto(
  document: ReturnType<typeof parseDocument>,
  target: YAMLMap,
  source: Record<string, unknown>,
): NestedMerge {
  const changes: FrontMatterChange[] = []
  let touched = false
  for (const key of Object.keys(source)) {
    const value = source[key]
    const pair = pairOf(target, key)
    if (!pair) {
      // A new key goes at the end, the way upstream appends it. Sorting or grouping properties would
      // reorder a note the reader arranged on purpose.
      target.set(key, document.createNode(value))
      changes.push({ key, action: 'added' })
      touched = true
      continue
    }
    // Upstream's `sourceValue !== undefined && !== null && !== ''` guard, extended to the empty
    // container: a template that rendered `tags: ` to nothing must not clear the reader's list.
    if (isEmptyValue(value)) {
      changes.push({ key, action: 'kept' })
      continue
    }
    const action = applyPair(document, pair, value)
    changes.push({ key, action })
    if (action !== 'kept') touched = true
  }
  return { changes, touched }
}

/** One existing key against one template value. */
function applyPair(
  document: ReturnType<typeof parseDocument>,
  pair: Pair,
  value: unknown,
): FrontMatterChangeAction {
  const current = pair.value
  const incomingList = Array.isArray(value)
  const incomingMap = isPlainRecord(value)
  const existingList = isSeq(current)
  const existingMap = isMap(current)

  if (incomingList && isSeq(current)) {
    const items = uniqueItems(document, current.items, value)
    // Written only if the item list itself is different, node by node. Length alone would not do it:
    // two items in, two items out is also what a collision that drops the reader's repeat and adds one
    // of the template's looks like, and upstream's `duplicates_pre_merge` case is exactly that.
    const same = items.length === current.items.length
      && items.every((item, index) => item === current.items[index])
    if (same) return 'kept'
    current.items = items
    return 'merged'
  }
  if (incomingMap && isMap(current)) {
    return mergeInto(document, current, value).touched ? 'merged' : 'kept'
  }
  if (incomingList !== existingList || incomingMap !== existingMap) {
    // Same key, different shape. The template's shape wins, which is upstream's `insertProperties`
    // behaviour and what its `handles mixed data types for same key` spec expects. It is said out loud
    // because it is the destructive rule: the reader wrote `list_to_string` as a list of their own, and
    // this turns it into a scalar, losing items rather than adding to them. Upstream's other merge
    // (`merge_objects`) would instead coerce the scalar into a one-item list and concatenate; that
    // reading was not chosen, because a property panel shows the coerced list as if the reader had
    // typed it, and a second key collision then duplicates every item.
    pair.value = document.createNode(value)
    return 'shape-replaced'
  }
  if (sameValue(plain(current), value)) return 'kept'
  pair.value = document.createNode(value)
  return 'overwritten'
}

/**
 * The existing items, then the template's, with repeats removed first-wins.
 *
 * De-duplication runs over the *concatenation*, which is why a list that already repeats itself keeps
 * its repeats right up to the moment the same key appears in the template as well: upstream's
 * `preserves duplicate values in YAML lists that do not match` and
 * `de-duplicates duplicate values in matching YAML lists` specs are the two halves of that, and
 * `merge_objects` only ever calls `unique()` inside the branch where the key exists on both sides.
 * Values are compared the way Obsidian's `unique()` does — a `Set`, so primitives by value and objects
 * by identity. Two mapping items therefore both survive, because a parsed object is never the same
 * object twice, and inventing a deep comparison here would silently drop a reader's row.
 */
function uniqueItems(
  document: ReturnType<typeof parseDocument>,
  existing: readonly unknown[],
  incoming: readonly unknown[],
): unknown[] {
  const seen = new Set<unknown>()
  const items: unknown[] = []
  const push = (node: unknown, value: unknown): void => {
    if (seen.has(value)) return
    seen.add(value)
    items.push(node)
  }
  for (const item of existing) push(item, plain(item))
  for (const value of incoming) push(document.createNode(value), value)
  return items
}

/**
 * The pair whose key reads as this name, found by comparing resolved keys instead of by `Map.has`.
 *
 * `has('123')` does not match a `123:` key, because YAML resolved that one to a number, and Obsidian
 * parsed both sides into string-keyed objects, so upstream merges them. Comparing the resolved text
 * keeps that behaviour, and returning the pair rather than the value is what lets the merge write the
 * new value *in place* — position, key spelling and attached comments all survive.
 */
function pairOf(map: YAMLMap, key: string): Pair | null {
  for (const pair of map.items) {
    if (String(plain(pair.key)) === key) return pair
  }
  return null
}

/** A node's plain JavaScript value, or the value itself when it is not a node. */
function plain(value: unknown): unknown {
  return isNode(value) ? value.toJSON() : value
}

function printed(document: ReturnType<typeof parseDocument>): string {
  // `flowCollectionPadding: false` is the same guard the properties panel applies, so a round trip does
  // not widen `tags: [a, b]` into `tags: [ a, b ]`. The interior is joined with `\n`, which is what
  // `@shared/markdown-utils` already writes for a property edit on a CRLF note; the fences and the body
  // keep whatever line ending the note had. Blank lines the reader left at the top of the block do not
  // come back, again exactly as the properties panel leaves them.
  return document
    .toString({ flowCollectionPadding: false })
    .replace(/\r?\n$/, '')
}

/** Empty as upstream means it: nothing to carry over, so the note's value stands. */
function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true
  if (Array.isArray(value)) return value.length === 0
  if (isPlainRecord(value)) return Object.keys(value).length === 0
  return false
}

/** The same `isPlainRecord` rule `@shared/markdown-utils` applies to a parsed block, so both agree on what a mapping is. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  // Set semantics again: `NaN` is the value it is, and two dates that point at the same instant are not,
  // because YAML hands back objects and upstream compares those by identity too.
  return typeof left === 'number' && typeof right === 'number' && Number.isNaN(left) && Number.isNaN(right)
}
