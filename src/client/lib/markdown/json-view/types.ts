/**
 * The document model behind the JSON preview.
 *
 * A node keeps the source text it was parsed from, so an untouched part of the note comes back out byte
 * for byte: `1.0` stays `1.0`, a twenty-digit integer keeps its digits, and the `//` comments an author
 * wrote stay where they were. That rules out the obvious shortcut of handing the body to `JSON.parse`
 * and the result to `JSON.stringify`, which silently rewrites every scalar it passes through — the same
 * reason `lib/markdown/code-formatter/json.ts` re-emits tokens instead of values.
 */
export type JsonKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export interface JsonNode {
  kind: JsonKind;
  /** Decoded object key. Null for array elements and for the document root. */
  key: string | null;
  /** Leaf payload; a container carries its members in `children` instead. */
  value: string | number | boolean | null;
  /** The value's own source text, kept so a number displays exactly as written. */
  literal: string | null;
  children: JsonNode[] | null;
  /**
   * This entry's own text — key, colon and value, exactly as written, and without the whitespace or the
   * comment that introduces it. While every descendant is unedited the writer emits this slice rather
   * than rebuilding the entry, which is what keeps a large, partly-edited document's untouched branches
   * byte-identical.
   */
  raw: string | null;
  /** A leaf's value on its own, so an edit to the key next to it does not retype the value. */
  valueRaw: string | null;
  /**
   * The whitespace and comments between the separator before this entry and the entry itself — where an
   * author's note about the line below it lives. The separators are not stored: the writer generates
   * them, so adding or removing a member cannot leave a stray comma behind. Null on a node the reader
   * created, which has no line of its own to keep.
   */
  lead: string | null;
  /**
   * The rest of the line after this entry, which is where a trailing comment sits. Splitting the trivia
   * between two entries this way is what keeps `// first` attached to the value it was typed beside when
   * either of them moves.
   */
  trail: string;
  /**
   * A container's trivia before its closer, which is where a closing comment lives. Null for a container
   * the reader built.
   */
  tail: string | null;
  /** Set once what is on screen no longer matches {@link JsonNode.raw}. */
  stale: boolean;
  collapsed: boolean;
}

/** A tolerant parse's deviation from strict JSON, for the badge the view shows. */
export type JsonRepair = 'comment' | 'single-quote' | 'unquoted-key' | 'trailing-comma' | 'bare-value' | 'loose-number';

export interface JsonDocument {
  root: JsonNode;
  /** The indent the body was written with, so a rewrite does not reflow the whole block. */
  indent: string;
  /** Where the body came from, kept for the write-back's comparison. */
  source: string;
  /**
   * Whatever followed the closing bracket — normally a newline, which markdown-it hands over inside the
   * fence body and which the note has to keep.
   */
  trailer: string;
  repairs: JsonRepair[];
}

export interface JsonFailure {
  /** One of the `preview.json_error_*` message keys, so the copy is localized at the call site. */
  reason: string;
  line: number;
  column: number;
  /** Extra detail for the parse failures, which can name what the scanner found. */
  detail?: string;
}

export interface JsonParseOutcome {
  ok: boolean;
  document: JsonDocument | null;
  failure: JsonFailure | null;
}

/** One thing the reader can say about the document without changing it. */
export interface JsonIssue {
  /** Where it is, as a path the view can scroll to and open. */
  path: JsonPath;
  messageKey: string;
  detail?: string;
}

export interface JsonParseLimits {
  maxDepth?: number;
  maxNodes?: number;
  /**
   * Accept a body that is one scalar. The view declines those — a fence already shows `42`, and a
   * one-row tree is a worse answer than the source — but the value editor parses a typed value with the
   * same reader, and `42` is what the user wrote.
   */
  allowScalar?: boolean;
}

/**
 * Depth and breadth ceilings. Both exist for the same reason: every consumer below walks the tree with
 * recursion or a per-node DOM element, so a body that parses is not by itself proof that rendering it
 * is cheap. A note that exceeds either ceiling keeps its source view and says why.
 */
export const JSON_VIEW_MAX_DEPTH = 200;
export const JSON_VIEW_MAX_NODES = 20000;
export const JSON_VIEW_BODY_LIMIT_BYTES = 512 * 1024;
/** Nodes the mind map lays out before it declines: that view draws every uncollapsed node at once. */
export const JSON_VIEW_MAX_MAP_NODES = 2000;

export function isContainer(node: JsonNode): boolean {
  return node.kind === 'object' || node.kind === 'array';
}

export function childCount(node: JsonNode): number {
  return node.children?.length ?? 0;
}

/** A fresh entry is one the serializer may emit straight from its source slice. */
export function isFresh(node: JsonNode): boolean {
  if (node.stale || node.raw === null)
    return false;
  return node.children === null || node.children.every(isFresh);
}

export type JsonPathSegment = string | number;
export type JsonPath = JsonPathSegment[];

/**
 * A node's stable identity across a re-parse. `JSON.stringify` over the segments keeps a key that
 * contains a dot or a quote from colliding with its neighbour, which a joined path string would do.
 */
export function pathKey(path: JsonPath): string {
  return JSON.stringify(path);
}

export function formatJsonPath(path: JsonPath): string {
  if (path.length === 0)
    return '$';
  let out = '$';
  for (const segment of path) {
    if (typeof segment === 'number')
      out += `[${segment}]`;
    else if (/^[A-Za-z_$][\w$]*$/.test(segment))
      out += `.${segment}`;
    else
      out += `[${JSON.stringify(segment)}]`;
  }
  return out;
}

/**
 * A fresh object for `Object.prototype`-shaped keys.
 *
 * A note may hold `{"__proto__": …}`; writing that key with `=` would retype the object it lands on
 * instead of adding a member, and the value would vanish from every later read. `defineProperty` is the
 * one assignment that cannot touch the prototype chain.
 */
export function defineMember(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}
