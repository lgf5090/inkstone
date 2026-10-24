/**
 * The support half of `note.renderInclude`: read the request, cut the subpath, build the child's context.
 *
 * The handler itself lives in `./page-host.ts`, beside every other method, because it needs the run's own
 * path resolution and its write overlay; this file holds the three pieces that can be understood without
 * any of that. Each one exists because the frozen contract made it a page-side job:
 *
 * - {@link parseRenderIncludeRequest} — the request is the template's argument, dumped out of the
 *   interpreter and cloned across the wire, so it is *data*, not a typed `RenderIncludeRequest`, until this
 *   reads it. Nothing is coerced: a shape that is not the contract's is refused with a tag, and the handler
 *   never has to re-check a field it got through here.
 * - {@link sliceIncludeSubpath} — a `#Heading` or `#^block` slice needs parse positions, and the snapshot
 *   deliberately carries no note body. Upstream cuts the span out of Obsidian's metadata cache
 *   (`resolveSubpath`, used at `InternalModuleFile.ts:199-211`); this app already cuts exactly these two
 *   shapes for note embeds, so the embed extractors are the answer rather than a second copy of the rules.
 *   An anchor that matches nothing refuses: handing back the whole note when the template asked for one
 *   heading is the plausible-looking wrong answer this layer exists to prevent — upstream slices only when
 *   the cache resolves the subpath and silently includes the whole file otherwise.
 * - {@link buildChildContext} — the two readings upstream keeps apart. `include` re-parses with the
 *   *parent's* own function object (`InternalModuleFile.ts:212-222`), so the child sees the parent's target,
 *   title and mode and prints the parent's `tp.file.title`; `create_new` gives the render a config of its
 *   own with the note being made as the target and `RunMode.CreateNewFromTemplate` (`Templater.ts:194-214`),
 *   so the child prints the new note's name. `asCreate` is the only difference, and it decides which
 *   reading the context carries.
 *
 * The registry below is the fourth thing, and the reason `MAX_TEMPLATE_DEPTH` can be the page's to enforce:
 * every nested run gets its own interpreter, whose counters see only its own stack. A run's absolute level
 * is recorded when this module starts it, and the handler adds the request's own depth to it — that is the
 * whole chain, and `childrenOf` is what lets a cancelled parent take its children down with it instead of
 * leaving them running.
 */
import { extractBlock, extractHeadingSection } from '../../markdown/embeds'
import { parseFrontMatter } from '@shared/markdown-utils'
import type { NoteIndexEntry, RenderIncludeRequest, RunNoteRef, TemplateRunContext } from '../protocol'

/**
 * Why one request could not be read, as a machine tag.
 *
 * `shape` is "not an object", and the rest name the field that broke, so the detail the reader gets says
 * which half of `RenderIncludeRequest` the template mis-assembled rather than repeating the whole object.
 */
export type RenderRequestIssue = 'shape' | 'source' | 'depth' | 'create'

export type ParsedRenderRequest = { ok: true; request: RenderIncludeRequest } | { ok: false; issue: RenderRequestIssue }

/** The subpath half of a note source, spelled out because the contract types `source` as a union. */
type IncludeSubpath = { kind: 'heading' | 'block'; text: string } | null

/** The `asCreate` half, spelled out for the same reason. */
type CreateTarget = { path: string; title: string; templatePath?: string } | null

/**
 * The template's argument, checked against the contract rather than helped.
 *
 * Path *syntax* is not checked here — that is `validateNotePath`'s job in the handler, so a traversal gets
 * `path-invalid` with the same reason every other method gives it. This answers only "is this a request at
 * all", which nothing on the worker side promises: the prelude builds this object in a VM that can run
 * anything a template writes into it.
 */
export function parseRenderIncludeRequest(value: unknown): ParsedRenderRequest {
  const record = asRecord(value)
  if (record === null) return { ok: false, issue: 'shape' }
  const source = parseSource(record.source)
  if (source === undefined) return { ok: false, issue: 'source' }
  const depth = record.depth
  if (typeof depth !== 'number' || !Number.isSafeInteger(depth) || depth < 1) return { ok: false, issue: 'depth' }
  const asCreate = parseAsCreate(record.asCreate)
  if (asCreate === false) return { ok: false, issue: 'create' }
  return { ok: true, request: { source, depth, asCreate } }
}

/** `undefined` means the field is not a source; `null` is not a legal one and also fails. */
function parseSource(value: unknown): RenderIncludeRequest['source'] | undefined {
  const record = asRecord(value)
  if (record === null) return undefined
  if (record.kind === 'text') {
    return typeof record.text === 'string' ? { kind: 'text', text: record.text } : undefined
  }
  if (record.kind !== 'note') return undefined
  if (typeof record.path !== 'string' || record.path.trim() === '') return undefined
  const subpath = parseSubpath(record.subpath)
  if (subpath === false) return undefined
  return { kind: 'note', path: record.path, subpath }
}

/** `false` is a malformed subpath; `null` and `undefined` both mean "the whole note" and pass through. */
function parseSubpath(value: unknown): IncludeSubpath | false {
  if (value === undefined || value === null) return null
  const record = asRecord(value)
  if (record === null) return false
  if (record.kind !== 'heading' && record.kind !== 'block') return false
  if (typeof record.text !== 'string' || record.text === '') return false
  return { kind: record.kind, text: record.text }
}

/** `false` is a malformed create; `null` and `undefined` both mean "this is an `include`, not a create". */
function parseAsCreate(value: unknown): CreateTarget | false {
  if (value === undefined || value === null) return null
  const record = asRecord(value)
  if (record === null) return false
  if (typeof record.path !== 'string' || record.path.trim() === '') return false
  if (typeof record.title !== 'string' || record.title === '') return false
  if (record.templatePath !== undefined && (typeof record.templatePath !== 'string' || record.templatePath.trim() === '')) {
    return false
  }
  return { path: record.path, title: record.title, templatePath: record.templatePath }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * The heading or block a subpath names, cut the way this app's own embeds cut it.
 *
 * Derived from Templater 2.26.0 (AGPL-3.0-only) src/core/functions/internal_functions/file/
 * InternalModuleFile.ts (`generate_include`, the `resolveSubpath` branch), with Inkstone adaptations: the
 * slice comes from the embed extractors over the body `parseFrontMatter` separates — Obsidian hands
 * `resolveSubpath` cached positions and this app hands text ranges, which is the same answer for a heading
 * or a block that exists, and a refusal for one that does not.
 */
export function sliceIncludeSubpath(
  content: string,
  subpath: { kind: 'heading' | 'block'; text: string },
): { ok: true; text: string } | { ok: false } {
  const body = parseFrontMatter(content).body
  const text = subpath.kind === 'heading'
    ? extractHeadingSection(body, subpath.text)
    : extractBlock(body, subpath.text)
  return text === null ? { ok: false } : { ok: true, text }
}

export interface ChildContextInput {
  parent: TemplateRunContext
  /** The nested run's own id, from `createTemplateRunId`. */
  runId: string
  /** Present only for the `create_new` render; `null` is the `include` reading. */
  asCreate: RenderIncludeRequest['asCreate']
  /** The source row when the render reads a note or a library template; `null` for raw text. */
  sourceEntry: NoteIndexEntry | null
  /** The source's raw text, which is what `tp.config.template_file` carries for a file-sourced create. */
  sourceContent: string
}

/** The id the note-being-created answers under until the store makes a real one. */
function pendingNoteId(path: string): string {
  // The `templater:` prefix is the same convention `context/file-wrapper.ts` gives the virtual templates
  // folder: real ids are ksuids or `<prefix>-<hex>`, so none of them can collide with this.
  return `templater:pending:${path}`
}

/**
 * The context one nested render starts with.
 *
 * Both readings are upstream's and neither widens the run: the child keeps the parent's capability
 * *profile name*, and a child whose target is a note that does not exist yet still cannot reach anything
 * the parent could not. `startedAt`, `locale` and `selection` are carried unchanged because the contract
 * freezes them for the whole run, not per interpreter.
 */
export function buildChildContext(input: ChildContextInput): TemplateRunContext {
  const { parent, runId } = input
  if (!input.asCreate) {
    // Upstream re-parses an `include` with the parent's function object, so every fact the template reads
    // off `tp.file.*` or `tp.config.*` is the parent's — an included note prints the parent's title.
    return { ...parent, runId }
  }
  const asCreate = input.asCreate
  const folderId = folderIdForPath(parent, parentPathOf(asCreate.path))
  const known = parent.index.find((entry) => entry.path === asCreate.path)
  const id = known?.id ?? pendingNoteId(asCreate.path)
  const createdAt = known?.createdAt ?? parent.startedAt
  const target: RunNoteRef = {
    id,
    title: asCreate.title,
    content: '',
    folderId: known?.folderId ?? folderId,
    tagNames: [],
    frontmatter: {},
    // Upstream creates the empty file before rendering it, so its times are the run's own instant; the
    // row this render is filling does not exist yet, and `startedAt` is the closest honest answer.
    createdAt,
    updatedAt: createdAt,
    isEmpty: true,
  }
  return {
    ...parent,
    runId,
    mode: 'create-new',
    // Same profile name, never a wider one: see the header note above.
    capabilities: parent.capabilities,
    target,
    active: target,
    frozenTitle: asCreate.title,
    // The note being created is addressable in its own run, the way `buildRunSnapshot` makes the three rows
    // a run is about addressable — otherwise `tp.file.exists(tp.file.path(true))` would be false for the
    // very note the template is filling.
    index: known === undefined ? [...parent.index, { id, title: asCreate.title, folderId, path: asCreate.path, createdAt, updatedAt: createdAt }] : parent.index,
    template: input.sourceEntry
      ? { id: input.sourceEntry.id, name: input.sourceEntry.title, content: input.sourceContent }
      : null,
  }
}

function parentPathOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

function folderIdForPath(context: TemplateRunContext, path: string): string | null {
  if (path === '') return null
  return context.folders.find((folder) => folder.path === path)?.id ?? null
}

/**
 * Which nested render sits at which level, and which parent to take down with it.
 *
 * One entry per outstanding child; the handler adds it before the render starts and removes it in its
 * `finally`, and `page-host.ts` walks `childrenOf` when a run ends early. The level a child was started at
 * is what its own requests count from, which is the only way `MAX_TEMPLATE_DEPTH` can hold across several
 * interpreters.
 */
export class NestedRunRegistry {
  private readonly levels = new Map<string, number>()
  private readonly children = new Map<string, Set<string>>()

  /** The level `runId` itself sits at; `0` for the run the reader started. */
  offsetOf(runId: string): number {
    return this.levels.get(runId) ?? 0
  }

  add(childRunId: string, parentRunId: string, level: number): void {
    this.levels.set(childRunId, level)
    const siblings = this.children.get(parentRunId)
    if (siblings) siblings.add(childRunId)
    else this.children.set(parentRunId, new Set([childRunId]))
  }

  remove(childRunId: string): void {
    const level = this.levels.get(childRunId)
    if (level === undefined) return
    this.levels.delete(childRunId)
    const parentRunId = this.parentOf(childRunId)
    if (parentRunId === null) return
    const siblings = this.children.get(parentRunId)
    if (siblings === undefined) return
    siblings.delete(childRunId)
    if (siblings.size === 0) this.children.delete(parentRunId)
  }

  /** A snapshot, because the caller removes entries while iterating. */
  childrenOf(parentRunId: string): string[] {
    const siblings = this.children.get(parentRunId)
    return siblings === undefined ? [] : [...siblings]
  }

  private parentOf(runId: string): string | null {
    for (const [parentRunId, siblings] of this.children) {
      if (siblings.has(runId)) return parentRunId
    }
    return null
  }
}
