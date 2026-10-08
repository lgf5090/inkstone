import type Token from 'markdown-it/lib/token.mjs'
import type { MessageKey } from '../i18n'
import { t } from '../i18n'

/**
 * Names a block can carry, and the numbers those names resolve to.
 *
 * pandoc-crossref's spelling is what an author arrives with: a block is named once — `{#eq:name}` for an
 * equation, `{#tbl:name}` for a table, `{#fig:name}` for a picture, or TeX's own `\label{}` — and every
 * later `@eq:name` says the number that name was given, in the order the document was written.
 *
 * The registry is filled while the document is being *tokenised*, before a single inline run is parsed,
 * so a reference above the thing it points at resolves just as well as one below it. Numbers are per kind:
 * the third table is number 3 of the tables whatever the figures did, and a name claimed twice keeps the
 * number it was given first, because moving a number out from under a reference that already points at it
 * is the worse error.
 */

export type CrossrefKind = 'fig' | 'eq' | 'tbl';

export interface CrossrefEntry {
  kind: CrossrefKind;
  name: string;
  number: number;
}

export interface CrossrefRegistry {
  /** How many blocks of each kind this document has numbered so far. */
  sequence: Record<CrossrefKind, number>;
  entries: Map<string, CrossrefEntry>;
}

const LABEL_KEYS: Record<CrossrefKind, MessageKey> = {
  fig: 'markdown.figure',
  eq: 'markdown.equation',
  tbl: 'markdown.table',
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const KIND_PREFIX = /^(fig|eq|tbl):(.*)$/
const BRACED_LINE = /^\{\s*#([^{}\n]*)\s*\}$/
const LATEX_LABEL = /\\label\{([^{}\n]*)\}/

export function emptyCrossrefRegistry(): CrossrefRegistry {
  return { sequence: { fig: 0, eq: 0, tbl: 0 }, entries: new Map() }
}

export function crossrefKey(kind: CrossrefKind, name: string): string {
  return `${kind}:${name}`;
}

/** The id the jump mechanism already knows how to reach, and the `data-block-id` beside it. */
export function crossrefAnchor(kind: CrossrefKind, name: string): string {
  return `${kind}-${name}`;
}

export function readCrossrefName(value: string): string | null {
  const name = value.trim();
  return NAME_PATTERN.test(name) ? name : null;
}

export function nextCrossrefNumber(registry: CrossrefRegistry, kind: CrossrefKind): number {
  const number = registry.sequence[kind] + 1;
  registry.sequence[kind] = number;
  return number;
}

/** Ties a name to a number the block already took, so a numbered picture and its reference agree. */
export function attachCrossrefName(registry: CrossrefRegistry, kind: CrossrefKind, name: string, number: number): CrossrefEntry | null {
  const clean = readCrossrefName(name);
  if (clean === null) return null;
  const key = crossrefKey(kind, clean);
  const seen = registry.entries.get(key);
  if (seen) return seen;
  const entry: CrossrefEntry = { kind, name: clean, number };
  registry.entries.set(key, entry);
  return entry;
}

export function registerCrossref(registry: CrossrefRegistry, kind: CrossrefKind, name: string): CrossrefEntry | null {
  const seen = lookupCrossref(registry, kind, name);
  if (seen) return seen;
  return attachCrossrefName(registry, kind, name, nextCrossrefNumber(registry, kind));
}

export function lookupCrossref(registry: CrossrefRegistry, kind: CrossrefKind, name: string): CrossrefEntry | null {
  const clean = readCrossrefName(name);
  if (clean === null) return null;
  return registry.entries.get(crossrefKey(kind, clean)) ?? null;
}

/** A prefix in the marker is the author naming the kind; it may not contradict the block carrying it. */
function crossrefNameIn(inner: string, kind: CrossrefKind): string | null {
  const text = inner.trim();
  const prefixed = KIND_PREFIX.exec(text);
  if (prefixed) return prefixed[1] === kind ? readCrossrefName(prefixed[2]!) : null;
  return readCrossrefName(text);
}

/** The name a whole line states for a block of this kind — `{#tbl:results}`, or `{#results}`. */
export function readCrossrefLine(text: string, kind: CrossrefKind): string | null {
  const marker = BRACED_LINE.exec(text.trim());
  if (!marker) return null;
  return crossrefNameIn(marker[1]!, kind);
}

/** TeX's own `\label{}`: the name comes out of the body, so KaTeX never has to look at it. */
export function takeCrossrefLabel(content: string, kind: CrossrefKind): { body: string, name: string | null } {
  const match = LATEX_LABEL.exec(content);
  if (!match) return { body: content, name: null };
  const name = crossrefNameIn(match[1]!, kind);
  if (name === null) return { body: content, name: null };
  return { body: content.replace(match[0]!, '').trim(), name };
}

/** A `{#…}` written after a block’s own closer belongs to the block, not to its contents. */
export function splitCrossrefTail(text: string): { body: string, marker: string | null } {
  const tail = /[ \t]\{#([^{}\n]{1,70})\}[ \t]*$/.exec(text);
  if (!tail) return { body: text, marker: null };
  return { body: text.slice(0, tail.index), marker: tail[0].trim() };
}

/** A `{#…}` trailing on the block's last line, taken off the body the same way. */
export function takeCrossrefSuffix(content: string, kind: CrossrefKind): { body: string, name: string | null } {
  const lines = content.split('\n');
  const last = lines[lines.length - 1]?.trimEnd() ?? '';
  const marker = /\{\s*#([^{}\n]*)\s*\}[ \t]*$/.exec(last);
  if (!marker) return { body: content, name: null };
  const name = crossrefNameIn(marker[1]!, kind);
  if (name === null) return { body: content, name: null };
  lines[lines.length - 1] = last.slice(0, marker.index).trimEnd();
  return { body: lines.join('\n').trim(), name };
}

export function crossrefLabel(entry: CrossrefEntry): string {
  return `${t(LABEL_KEYS[entry.kind])} ${entry.number}`;
}

/** What a named block carries into its renderer rule. */
export interface CrossrefTokenMeta {
  crossref?: CrossrefEntry;
}

function matchingTokenEnd(tokens: Token[], start: number, openType: string, closeType: string): number {
  let depth = 0;
  for (let index = start; index < tokens.length; index++) {
    const type = tokens[index]!.type;
    if (type === openType) depth++;
    else if (type === closeType) {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** The name a `{#…}`-only paragraph states at `at`, and how many tokens that paragraph holds. */
function crossrefParagraph(tokens: Token[], at: number, kind: CrossrefKind): { name: string, length: number } | null {
  if (tokens[at]?.type !== 'paragraph_open' || tokens[at + 1]?.type !== 'inline' || tokens[at + 2]?.type !== 'paragraph_close') return null;
  const name = readCrossrefLine(tokens[at + 1]!.content, kind);
  return name === null ? null : { name, length: 3 };
}

/**
 * Names every equation and table in a finished token stream.
 *
 * This runs after the block rules and before any inline is parsed, which is the only moment both halves of
 * the job are possible: a table's name lives on the line *below* the table, so the paragraph has to be
 * taken out of the stream rather than read while the table was made, and a reference has to be able to
 * resolve a name that appears later in the note.
 */
export function nameCrossrefBlocks(tokens: Token[], registry: CrossrefRegistry): void {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.type === 'math_block') {
      const labelled = takeCrossrefLabel(token.content, 'eq');
      const named = labelled.name === null ? takeCrossrefSuffix(labelled.body, 'eq') : labelled;
      if (named.name === null) continue;
      token.content = named.body;
      const entry = registerCrossref(registry, 'eq', named.name);
      if (entry) token.meta = { ...token.meta, crossref: entry } satisfies CrossrefTokenMeta;
      continue;
    }
    if (token.type !== 'table_open') continue;
    const end = matchingTokenEnd(tokens, index, 'table_open', 'table_close');
    if (end < 0) continue;
    const marker = crossrefParagraph(tokens, end + 1, 'tbl');
    if (!marker) continue;
    const entry = registerCrossref(registry, 'tbl', marker.name);
    const paragraph = tokens[end + 1]!;
    tokens.splice(end + 1, marker.length);
    // The line the name was written on belongs to the table now, so the live editor draws it inside the
    // table's own block instead of leaving the marker standing there as source.
    if (token.map && paragraph.map) token.map = [token.map[0], paragraph.map[1]];
    if (entry) token.meta = { ...token.meta, crossref: entry } satisfies CrossrefTokenMeta;
  }
}
