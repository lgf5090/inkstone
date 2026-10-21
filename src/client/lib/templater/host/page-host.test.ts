import { describe, expect, it, vi } from 'vitest'
import type { Folder, Note, NoteTemplate } from '@shared/types'
import { HOST_METHOD_CAPABILITY, HOST_METHODS, capabilitiesFor, type CapabilityProfile, type HostResult, type ProgramSource, type RenderIncludeRequest, type TemplateRunContext } from '../protocol'
import { MAX_HOST_ARG_CHARS, MAX_OUTPUT_CHARS } from '../limits'
import { buildRunSnapshot, type RunSnapshotInput } from '../context/snapshot'
import { createNoteIndexCache } from './note-index-cache'
import { createPageHost, MAX_TRACKED_RUNS, OWNED_METHODS, type NestedRenderOutcome, type PageHost, type PageHostDeps } from './page-host'

/**
 * The page host is the module that lets someone else's code touch the reader's notes, so these read as a
 * list of things that must never happen quietly: a write that went to the note the template did not name,
 * a traversal path that was normalised instead of refused, a capability assumed from the worker's gate, a
 * store refusal reported as success, a missing row guessed into existence.
 *
 * The contexts are built by `buildRunSnapshot`, the same call the page makes before a template runs, rather
 * than by a hand-written index: half of what this host does is resolve paths against that index, and a
 * fixture index could drift from the one a run really carries without any test noticing. The data layer is
 * the fake in {@link fakeStores}, and every assertion that a refusal cost nothing is an assertion about the
 * entry points it recorded reaching.
 */

const PROFILES: CapabilityProfile[] = ['local', 'community', 'preview', 'dynamic', 'startup']

/** The folder the second note is filed in, so a path with a segment in it names a real place. */
const NOTES_FOLDER: Folder = {
  id: 'folder-notes',
  parentId: null,
  name: 'Notes',
  icon: null,
  color: null,
  position: 0,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
}

function noteRow(id: string, title: string, folderId: string | null, content: string, overrides: Partial<Note> = {}): Note {
  return {
    id,
    title,
    excerpt: '',
    content,
    folderId,
    tags: [],
    isPinned: false,
    isStarred: false,
    isArchived: false,
    wordCount: 1,
    charCount: content.length,
    rev: 1,
    position: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    deletedAt: null,
    ...overrides,
  }
}

function templateRow(id: string, name: string, content: string): NoteTemplate {
  return {
    id,
    categoryId: null,
    name,
    description: '',
    content,
    builtin: false,
    isPinned: false,
    isStarred: false,
    tags: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  }
}

/** The rows one test's run is built over: the note a template is applied to, one filed away, one template. */
function rows() {
  return {
    notes: [
      noteRow('note-target', 'Target', null, 'target text'),
      noteRow('note-secret', 'Secret', NOTES_FOLDER.id, 'secret text'),
    ],
    folders: [{ ...NOTES_FOLDER }],
    templates: [templateRow('template-daily', 'Daily', 'daily template text')],
  }
}

interface FakeStore {
  deps: PageHostDeps
  notes: Map<string, Note>
  folders: Folder[]
  templates: NoteTemplate[]
  /** Every store entry point this host reached, in order — the evidence behind the "reached nothing" tests. */
  calls: string[]
  /** Simulate a write landing between the host's read and its patch, which is what `note-conflict` means. */
  raceNextWrite: boolean
  /** What `editor.open` answers; a pane that cannot show the note is the `no-leaf` case. */
  openAnswer: boolean
  /** What `editor.appendAtCursor` answers; `false` is "no live editor", upstream's do-nothing branch. */
  appendAnswer: boolean
  /** Every text the editor was asked to put at the caret, in order. */
  appended: string[]
  /** Every nested render the host started, in order — the context and program the door was handed. */
  renders: { program: ProgramSource; context: TemplateRunContext; deadlineMs: number }[]
  /** Nested runs the host cancelled because their parent went away. */
  cancelled: string[]
  /** What the next `nested.render` resolves with; replace it to script a failure. */
  nextRenderOutcome: NestedRenderOutcome
  /** When true, each `nested.render` stays open until the test resolves `resolveRenders`. */
  renderHold: boolean
  /** The pending renders' resolvers, one per held render. */
  resolveRenders: ((outcome: NestedRenderOutcome) => void)[]
}

function fakeStores(input = rows()): FakeStore {
  const notes = new Map(input.notes.map((note) => [note.id, note]))
  const folders = [...input.folders]
  const templates = [...input.templates]
  const calls: string[] = []
  const store: FakeStore = {
    deps: {
      notes: {
        async read(id) {
          calls.push('notes.read')
          const row = notes.get(id)
          // A trashed note has no readable body: the app's own route answers it as missing.
          return row && row.deletedAt === null ? row : null
        },
        async write(id, content, expected) {
          calls.push('notes.write')
          const current = notes.get(id)
          if (!current) return { ok: false, reason: 'not-found' }
          const raced = store.raceNextWrite || current.rev !== expected.rev || current.content !== expected.content
          store.raceNextWrite = false
          if (raced) return { ok: false, reason: 'conflict' }
          const next = { ...current, content, rev: current.rev + 1 }
          notes.set(id, next)
          return { ok: true, note: next }
        },
        async update(id, changes, expected) {
          calls.push('notes.update')
          const current = notes.get(id)
          if (!current) return { ok: false, reason: 'not-found' }
          if (store.raceNextWrite || current.rev !== expected.rev) {
            store.raceNextWrite = false
            return { ok: false, reason: 'conflict' }
          }
          const next = { ...current, ...changes, rev: current.rev + 1 }
          notes.set(id, next)
          return { ok: true, note: next }
        },
        async create({ title, content, folderId }) {
          calls.push('notes.create')
          const id = `note-created-${notes.size + 1}`
          const created = noteRow(id, title, folderId, content)
          notes.set(id, created)
          return { ok: true, note: created }
        },
        async remove(id) {
          calls.push('notes.remove')
          const current = notes.get(id)
          if (!current) return { ok: false, reason: 'not-found' }
          const trashed = { ...current, deletedAt: 1_700_000_000_001 }
          notes.set(id, trashed)
          return { ok: true, note: trashed }
        },
      },
      folders: {
        list() {
          calls.push('folders.list')
          return folders.map((folder) => ({ ...folder }))
        },
        async create({ name, parentId }) {
          calls.push('folders.create')
          if (folders.some((folder) => folder.parentId === parentId && folder.name === name)) return null
          const id = `folder-created-${folders.length + 1}`
          folders.push({ id, parentId, name, icon: null, color: null, position: 0, createdAt: 1, updatedAt: 1 })
          return id
        },
      },
      templates: {
        async byName(name) {
          calls.push('templates.byName')
          const wanted = name.trim().toLowerCase()
          return templates.find((template) => template.name.trim().toLowerCase() === wanted) ?? null
        },
      },
      editor: {
        async open(id) {
          calls.push('editor.open')
          void id
          return store.openAnswer
        },
        appendAtCursor(text) {
          calls.push('editor.append')
          store.appended.push(text)
          return store.appendAnswer
        },
      },
      nested: {
        render({ program, context, deadlineMs }) {
          calls.push('nested.render')
          store.renders.push({ program, context, deadlineMs })
          // A held render stays open until the test resolves it, which is the only way to observe what the
          // host does with a child run that is still rendering when its parent goes away.
          if (store.renderHold) {
            return new Promise<NestedRenderOutcome>((resolve) => {
              store.resolveRenders.push(resolve)
            })
          }
          return Promise.resolve(store.nextRenderOutcome)
        },
        cancel(runId) {
          calls.push('nested.cancel')
          store.cancelled.push(runId)
        },
      },
      // The same cache the app's wiring hands the page host, so every case above is also a case about it: a
      // store that moves between two runs has to move the index too, or the run answers from a tree it never
      // saw. A host built over bare `deps` instead still takes the plain per-run rebuild.
      indexCache: createNoteIndexCache(),
    },
    notes,
    folders,
    templates,
    calls,
    raceNextWrite: false,
    openAnswer: true,
    appendAnswer: true,
    appended: [],
    renders: [],
    cancelled: [],
    nextRenderOutcome: { ok: true, output: 'rendered text', durationMs: 1 },
    renderHold: false,
    resolveRenders: [],
  }
  return store
}

function contextFor(store: FakeStore, profile: CapabilityProfile, overrides: Partial<RunSnapshotInput> = {}): TemplateRunContext {
  const notes = [...store.notes.values()]
  const target = notes.find((note) => note.id === 'note-target') ?? null
  return buildRunSnapshot({
    runId: 'run-1',
    notes,
    folders: store.folders,
    templates: store.templates,
    target,
    active: target,
    template: null,
    mode: 'overwrite-active',
    capabilities: profile,
    locale: 'en-US',
    startedAt: 1_700_000_000_000,
    ...overrides,
  })
}

/** A host over a fresh fake store and a fresh run, which is how the page uses it. */
function started(profile: CapabilityProfile = 'local', overrides: Partial<RunSnapshotInput> = {}): {
  host: PageHost
  store: FakeStore
  context: TemplateRunContext
} {
  const store = fakeStores()
  const host = createPageHost(store.deps)
  const context = contextFor(store, profile, overrides)
  host.beginRun(context)
  return { host, store, context }
}

/** A host whose store reaches nothing but the entry point named here. */
function overDeps(deps: PageHostDeps, context: TemplateRunContext): PageHost {
  const host = createPageHost(deps)
  host.beginRun(context)
  return host
}

function ask(host: PageHost, method: string, args: unknown[] = [], runId = 'run-1'): Promise<HostResult> {
  return host({ runId, callId: 'c1', method, args })
}

/** A value, or a failing test that says which code refused it. */
function answered(result: HostResult): unknown {
  if (!result.ok) throw new Error(`refused: ${result.code} ${result.detail ?? ''}`)
  return result.value
}

function refused(result: HostResult): { code: string; detail: string | undefined } {
  if (result.ok) throw new Error(`answered ${JSON.stringify(result.value)} instead of refusing`)
  return { code: result.code, detail: result.detail }
}

describe('capability gate', () => {
  it('refuses every method the run has no right to, before the store is reached', async () => {
    for (const profile of PROFILES) {
      const { host, store } = started(profile)
      const capabilities = capabilitiesFor(profile)
      for (const method of HOST_METHODS) {
        if (capabilities[HOST_METHOD_CAPABILITY[method]]) continue
        const before = store.calls.length
        expect(refused(await ask(host, method)), `${profile}/${method}`).toEqual({ code: 'capability-blocked', detail: method })
        expect(store.calls.length, `${profile}/${method} reached the data layer`).toBe(before)
      }
    }
  })

  it('answers the methods this host does not own as a named refusal', async () => {
    const { host, store } = started('local')
    for (const method of HOST_METHODS) {
      if (OWNED_METHODS.includes(method)) continue
      expect(refused(await ask(host, method)), method).toEqual({ code: 'not-supported', detail: method })
    }
    // The boundary is a refusal, not a half-implementation: it must not read a note to answer one.
    expect(store.calls).toEqual([])
  })

  it('refuses a name the allowlist never carried, without implying it could be allowed', async () => {
    const { host } = started('local')
    expect(refused(await ask(host, 'fs.unlink'))).toEqual({ code: 'not-supported', detail: 'fs.unlink' })
    expect(refused(await ask(host, 42 as unknown as string))).toEqual({ code: 'not-supported', detail: 'unnamed' })
  })

  it('keeps a community run from reading the note beside the one it is writing', async () => {
    const { host, store } = started('community')
    expect(refused(await ask(host, 'note.read', ['Notes/Secret.md']))).toEqual({ code: 'capability-blocked', detail: 'note.read' })
    expect(refused(await ask(host, 'note.write', ['Notes/Secret.md', 'mine'])).code).toBe('capability-blocked')
    expect(store.calls).toEqual([])
  })

  it('lets an unattended run write and create, and refuses it asking anything', async () => {
    const { host } = started('startup')
    for (const method of ['system.prompt', 'system.suggester', 'system.clipboard', 'web.request']) {
      expect(refused(await ask(host, method)), method).toEqual({ code: 'capability-blocked', detail: method })
    }
    expect(await ask(host, 'note.exists', ['Target.md'])).toMatchObject({ ok: true, value: true })
  })

  it('refuses a call for a run the page never registered', async () => {
    const { host, store } = started('local')
    expect(refused(await ask(host, 'note.read', ['Target.md'], 'run-elsewhere'))).toEqual({ code: 'render-failed', detail: 'run:run-elsewhere' })
    expect(store.calls).toEqual([])
  })

  it('stops answering a run the page has released', async () => {
    const { host, store } = started('local')
    expect(host.liveRuns()).toBe(1)
    host.endRun('run-1')
    expect(host.liveRuns()).toBe(0)
    expect(refused(await ask(host, 'note.read', ['Target.md']))).toEqual({ code: 'render-failed', detail: 'run:run-1' })
    expect(store.calls).toEqual([])
  })

  it('releases the oldest run when the page has lost more than the bound', async () => {
    const { store, context } = started('local')
    const host = createPageHost(store.deps)
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    host.beginRun(context)
    const ids = [context.runId]
    for (let index = 1; index <= MAX_TRACKED_RUNS; index += 1) {
      const runId = `extra-${index}`
      ids.push(runId)
      host.beginRun(contextFor(store, 'local', { runId }))
    }
    // The first registration is the one a page that forgot to release has held longest, so it is the one
    // that goes — and it goes saying so rather than quietly answering the next batch with stale rights.
    expect(host.liveRuns()).toBe(MAX_TRACKED_RUNS)
    expect(refused(await ask(host, 'note.exists', ['Target.md'], ids[0]!))).toEqual({ code: 'render-failed', detail: `run:${ids[0]}` })
    expect(answered(await ask(host, 'note.exists', ['Target.md'], ids[ids.length - 1]!))).toBe(true)
    expect(warned).toHaveBeenCalledWith('[inkstone] templater host dropped a run the page never released', ids[0])
    warned.mockRestore()
  })

  it('refuses an oversized argument instead of shortening it', async () => {
    const { host, store } = started('local')
    const result = await ask(host, 'note.write', ['Target.md', 'x'.repeat(MAX_HOST_ARG_CHARS + 1)])
    expect(refused(result)).toEqual({ code: 'template-output-too-large', detail: `host-args:${MAX_HOST_ARG_CHARS}` })
    expect(store.calls).toEqual([])
  })

  it('refuses an argument it cannot measure instead of walking into it', async () => {
    const { host, store } = started('local')
    // A structured clone carries a cycle, and a guard that recursed through one would answer a size
    // question with a stack overflow. The budget is the answer, as it is for a plain oversized body.
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(refused(await ask(host, 'note.write', ['Target.md', cycle])))
      .toEqual({ code: 'template-output-too-large', detail: `host-args:${MAX_HOST_ARG_CHARS}` })
    expect(store.calls).toEqual([])
  })

  it('takes the argument budget from the shared limits rather than the shape of one method', async () => {
    const { host } = started('local')
    // A call whose arguments add up to exactly the ceiling is not a size refusal: the limit is the
    // note-sized one the worker enforces too, not a shorter guess made here. The answer it gets is the one
    // about the note, which proves the size gate opened.
    const path = 'Notes/Gone.md'
    const body = 'x'.repeat(MAX_HOST_ARG_CHARS - path.length)
    expect(refused(await ask(host, 'note.write', [path, body])))
      .toEqual({ code: 'note-not-found', detail: path })
  })
})

describe('note.read', () => {
  it('reads a note by its virtual path, as an object the run can take content off', async () => {
    const { host } = started('local')
    expect(answered(await ask(host, 'note.read', ['Notes/Secret.md']))).toEqual({ content: 'secret text' })
    expect(answered(await ask(host, 'note.read', ['Target.md']))).toEqual({ content: 'target text' })
  })

  it('reads a library template through the template half, not the note table', async () => {
    const { host, store } = started('local')
    expect(answered(await ask(host, 'note.read', ['Templates/Daily.md']))).toEqual({ content: 'daily template text' })
    expect(store.calls).toEqual(['templates.byName'])
  })

  it('refuses a path the tree has no row for', async () => {
    const { host } = started('local')
    expect(refused(await ask(host, 'note.read', ['Notes/Gone.md']))).toEqual({ code: 'note-not-found', detail: 'Notes/Gone.md' })
  })

  it('refuses a path that escaped the tree, whatever it was wearing', async () => {
    const { host, store } = started('local')
    const cases: [string, string][] = [
      ['Notes/../../Escape.md', 'escape'],
      ['..\\..\\Escape.md', 'escape'],
      ['C:/Windows/Notes.md', 'drive'],
      ['\\\\server\\share\\Note.md', 'absolute'],
      ['Notes/a<b.md', 'reserved'],
      ['Notes/Trailing./Note.md', 'trailing'],
    ]
    for (const [path, reason] of cases) {
      expect(refused(await ask(host, 'note.read', [path])), path).toEqual({ code: 'path-invalid', detail: reason })
    }
    expect(store.calls).toEqual([])
  })

  it('refuses an argument that is not a path at all', async () => {
    const { host, store } = started('local')
    expect(refused(await ask(host, 'note.read'))).toEqual({ code: 'path-invalid', detail: 'arg:0:type' })
    expect(refused(await ask(host, 'note.read', [7]))).toEqual({ code: 'path-invalid', detail: 'arg:0:type' })
    expect(refused(await ask(host, 'note.read', ['   ']))).toEqual({ code: 'path-invalid', detail: 'arg:0:empty' })
    expect(refused(await ask(host, 'note.read', [null]))).toEqual({ code: 'path-invalid', detail: 'arg:0:type' })
    expect(store.calls).toEqual([])
  })

  it('refuses a row the index still lists and the store no longer has', async () => {
    const { host, store } = started('local')
    store.notes.delete('note-secret')
    expect(refused(await ask(host, 'note.read', ['Notes/Secret.md']))).toEqual({ code: 'note-not-found', detail: 'Notes/Secret.md' })
  })

  it('turns a store function that threw into a code, and keeps the cause on the console', async () => {
    const { store, context } = started('local')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const host = overDeps({
      ...store.deps,
      notes: { ...store.deps.notes, read: async () => { throw new Error('the route said something in English') } },
    }, context)
    expect(refused(await ask(host, 'note.read', ['Notes/Secret.md']))).toEqual({ code: 'render-failed', detail: 'throw:note.read' })
    // The answer the template gets is a code; the reason is not thrown away with it.
    expect(logged).toHaveBeenCalledWith('[inkstone] templater host call failed', 'note.read', expect.any(Error))
    logged.mockRestore()
  })

  it('answers the note the run is writing from its own store read, not from a cached body', async () => {
    const { host, store } = started('local')
    store.notes.set('note-target', noteRow('note-target', 'Target', null, 'edited elsewhere', { rev: 4 }))
    expect(answered(await ask(host, 'note.read', ['Target.md']))).toEqual({ content: 'edited elsewhere' })
  })
})

describe('note.exists', () => {
  it('answers the same thing the run\'s own index answers', async () => {
    const { host, store } = started('local')
    expect(answered(await ask(host, 'note.exists', ['Target.md']))).toBe(true)
    expect(answered(await ask(host, 'note.exists', ['Templates/Daily.md']))).toBe(true)
    // No extension, no match — upstream's rule, kept by `note-index.ts`.
    expect(answered(await ask(host, 'note.exists', ['Notes/Secret']))).toBe(false)
    expect(answered(await ask(host, 'note.exists', ['Notes/Secret.md']))).toBe(true)
    // A path lookup answers from the run's index, the way `tp.file.find_tfile` does, so it costs no read.
    expect(store.calls).toEqual([])
  })

  it('refuses a traversal path rather than reporting what it points at', async () => {
    const { host } = started('local')
    expect(refused(await ask(host, 'note.exists', ['../Notes/Secret.md']))).toEqual({ code: 'path-invalid', detail: 'escape' })
  })
})

describe('note.write', () => {
  it('replaces the body and answers with the row the note is now', async () => {
    const { host, store } = started('local')
    const value = answered(await ask(host, 'note.write', ['Notes/Secret.md', 'rewritten'])) as { path: string; id: string }
    expect(value).toMatchObject({ path: 'Notes/Secret.md', id: 'note-secret' })
    expect(store.notes.get('note-secret')).toMatchObject({ content: 'rewritten', rev: 2 })
    expect(store.calls).toEqual(['notes.read', 'notes.write'])
  })

  it('guards the write with the row it just read', async () => {
    const { store, context } = started('local')
    const seen: Note[] = []
    const host = overDeps({
      ...store.deps,
      notes: {
        ...store.deps.notes,
        write: async (id, content, expected) => {
          seen.push(expected)
          return store.deps.notes.write(id, content, expected)
        },
      },
    }, context)
    answered(await ask(host, 'note.write', ['Notes/Secret.md', 'rewritten']))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ id: 'note-secret', content: 'secret text', rev: 1 })
  })

  it('answers note-conflict when the note moved under the run', async () => {
    const { host, store } = started('local')
    store.raceNextWrite = true
    expect(refused(await ask(host, 'note.write', ['Notes/Secret.md', 'rewritten']))).toEqual({ code: 'note-conflict', detail: 'Notes/Secret.md' })
    expect(store.notes.get('note-secret')?.content).toBe('secret text')
  })

  it('refuses a note that is not there, and a template row this method cannot write', async () => {
    const { host } = started('local')
    expect(refused(await ask(host, 'note.write', ['Notes/Gone.md', 'x']))).toEqual({ code: 'note-not-found', detail: 'Notes/Gone.md' })
    expect(refused(await ask(host, 'note.write', ['Templates/Daily.md', 'x']))).toEqual({ code: 'not-supported', detail: 'note.write:template-row' })
  })

  it('refuses a body that is not text, without reading the note first', async () => {
    const { host, store } = started('local')
    expect(refused(await ask(host, 'note.write', ['Target.md']))).toEqual({ code: 'render-failed', detail: 'note.write:arg:1:type' })
    expect(refused(await ask(host, 'note.write', ['Target.md', { text: 'x' }]))).toEqual({ code: 'render-failed', detail: 'note.write:arg:1:type' })
    expect(store.calls).toEqual([])
  })

  it('refuses to choose between two rows that claim one path', async () => {
    const store = fakeStores({
      ...rows(),
      notes: [
        noteRow('note-a', 'Same', null, 'first'),
        noteRow('note-b', 'Same', null, 'second'),
      ],
    })
    const host = overDeps(store.deps, contextFor(store, 'local'))
    expect(refused(await ask(host, 'note.write', ['Same.md', 'mine']))).toEqual({ code: 'note-conflict', detail: 'Same.md' })
    // A read still answers, with the deterministic winner: that is what `tp.file.find_tfile` reports, and a
    // template that only wanted text should not lose its run over the reader's duplicate.
    expect(answered(await ask(host, 'note.read', ['Same.md']))).toEqual({ content: 'first' })
  })

  it('answers a store refusal with the operation that stopped, not a bare path', async () => {
    const { store, context } = started('local')
    const host = overDeps({ ...store.deps, notes: { ...store.deps.notes, write: async () => ({ ok: false, reason: 'failed' }) } }, context)
    expect(refused(await ask(host, 'note.write', ['Notes/Secret.md', 'x']))).toEqual({ code: 'render-failed', detail: 'write:Notes/Secret.md' })
  })
})

describe('note.create', () => {
  it('creates the folders a path names on the way in, then the note', async () => {
    const { host, store } = started('local')
    const value = answered(await ask(host, 'note.create', ['Journal/2026/Today.md', 'new body'])) as { path: string; title: string }
    expect(value).toMatchObject({ path: 'Journal/2026/Today.md', title: 'Today' })
    expect(store.folders.map((folder) => folder.name)).toEqual(['Notes', 'Journal', '2026'])
    const created = [...store.notes.values()].find((note) => note.title === 'Today')
    expect(created).toMatchObject({ content: 'new body' })
    expect(store.folders.find((folder) => folder.name === '2026')?.parentId).toBe('folder-created-2')
    expect(created?.folderId).toBe('folder-created-3')
  })

  it('makes a note it just created readable and listable in the same run', async () => {
    const { host } = started('local')
    answered(await ask(host, 'note.create', ['Fresh.md', 'hello']))
    expect(answered(await ask(host, 'note.exists', ['Fresh.md']))).toBe(true)
    expect(answered(await ask(host, 'note.read', ['Fresh.md']))).toEqual({ content: 'hello' })
  })

  it('refuses a path that is already taken instead of inventing a second name', async () => {
    const { host, store } = started('local')
    // Upstream asks Obsidian for a free name and quietly writes `Secret 1.md`; two rows reading as one path
    // is the state the index then has to report as ambiguous, so this refuses and says what was taken.
    expect(refused(await ask(host, 'note.create', ['Notes/Secret.md', 'x']))).toEqual({ code: 'note-conflict', detail: 'Notes/Secret.md' })
    expect(store.calls).toEqual([])
  })

  it('refuses a title the app would have to shorten', async () => {
    const { host, store } = started('local')
    expect(refused(await ask(host, 'note.create', [`${'a'.repeat(600)}.md`, 'x']))).toEqual({ code: 'path-invalid', detail: 'title-max:512' })
    expect(store.calls).toEqual([])
  })

  it('files a note with no folder in it at the root', async () => {
    const { host, store } = started('local')
    answered(await ask(host, 'note.create', ['Root.md', 'x']))
    expect([...store.notes.values()].find((note) => note.title === 'Root')?.folderId).toBeNull()
  })

  it('refuses a folder the app gave a different name', async () => {
    const { store, context } = started('local')
    // The app suffixes a folder name a sibling already holds. The row that came back therefore names a
    // folder beside the one the template asked for, and filing into it would be a note in the wrong place.
    const host = overDeps({
      ...store.deps,
      folders: {
        list: () => store.folders,
        create: async ({ name, parentId }) => {
          store.folders.push({ id: 'folder-suffixed', parentId, name: `${name} 2`, icon: null, color: null, position: 0, createdAt: 1, updatedAt: 1 })
          return 'folder-suffixed'
        },
      },
    }, context)
    expect(refused(await ask(host, 'note.create', ['Journal/Today.md', 'x']))).toEqual({ code: 'note-conflict', detail: 'folder:Journal' })
  })
})

describe('note.move and note.rename', () => {
  it('moves the folder and the title together, the way upstream\'s single rename call does', async () => {
    const { host, store } = started('local')
    const value = answered(await ask(host, 'note.move', ['Target.md', 'Notes/Moved.md'])) as { path: string }
    expect(value.path).toBe('Notes/Moved.md')
    expect(store.notes.get('note-target')).toMatchObject({ title: 'Moved', folderId: NOTES_FOLDER.id })
    expect(refused(await ask(host, 'note.read', ['Target.md']))).toEqual({ code: 'note-not-found', detail: 'Target.md' })
    expect(answered(await ask(host, 'note.exists', ['Notes/Moved.md']))).toBe(true)
  })

  it('renames inside the folder the note is already in', async () => {
    const { host, store } = started('local')
    const value = answered(await ask(host, 'note.rename', ['Notes/Secret.md', 'Renamed'])) as { path: string; title: string }
    expect(value).toMatchObject({ path: 'Notes/Renamed.md', title: 'Renamed' })
    expect(store.notes.get('note-secret')?.folderId).toBe(NOTES_FOLDER.id)
  })

  it('moves the path the run made, not only the ones the snapshot knew', async () => {
    const { host } = started('local')
    answered(await ask(host, 'note.create', ['Fresh.md', 'hello']))
    answered(await ask(host, 'note.rename', ['Fresh.md', 'Later']))
    expect(answered(await ask(host, 'note.exists', ['Later.md']))).toBe(true)
    expect(answered(await ask(host, 'note.exists', ['Fresh.md']))).toBe(false)
  })

  it('refuses a new name that is a path, an empty segment, or nothing', async () => {
    const { host, store } = started('local')
    expect(refused(await ask(host, 'note.rename', ['Target.md', 'Sub/Name']))).toEqual({ code: 'path-invalid', detail: 'name-segment' })
    expect(refused(await ask(host, 'note.rename', ['Target.md', '..']))).toEqual({ code: 'path-invalid', detail: 'escape' })
    expect(refused(await ask(host, 'note.rename', ['Target.md', '.md']))).toEqual({ code: 'path-invalid', detail: 'name-empty' })
    expect(refused(await ask(host, 'note.rename', ['Target.md']))).toEqual({ code: 'render-failed', detail: 'note.rename:arg:1:type' })
    expect(store.calls).toEqual([])
  })

  it('refuses a move onto a path that is taken, and one onto nothing', async () => {
    const { host } = started('local')
    expect(refused(await ask(host, 'note.move', ['Target.md', 'Notes/Secret.md']))).toEqual({ code: 'note-conflict', detail: 'Notes/Secret.md' })
    expect(refused(await ask(host, 'note.move', ['Notes/Gone.md', 'Elsewhere.md']))).toEqual({ code: 'note-not-found', detail: 'Notes/Gone.md' })
  })

  it('answers the row unchanged when the note is already where the template asked', async () => {
    const { host, store } = started('local')
    const value = answered(await ask(host, 'note.move', ['Notes/Secret.md', 'Notes/Secret.md'])) as { path: string }
    expect(value.path).toBe('Notes/Secret.md')
    // No patch, and therefore no revision bump the reader did not ask for.
    expect(store.calls).toEqual(['notes.read', 'folders.list'])
  })

  it('answers note-conflict when the row moved under the run', async () => {
    const { host, store } = started('local')
    store.raceNextWrite = true
    expect(refused(await ask(host, 'note.rename', ['Target.md', 'Later']))).toEqual({ code: 'note-conflict', detail: 'Later.md' })
    expect(store.notes.get('note-target')?.title).toBe('Target')
  })

  it('refuses to move a template row', async () => {
    const { host } = started('local')
    expect(refused(await ask(host, 'note.move', ['Templates/Daily.md', 'Everywhere/Daily.md'])))
      .toEqual({ code: 'not-supported', detail: 'note.move:template-row' })
  })
})

describe('note.delete', () => {
  it('takes the note to the trash and closes the path for the rest of the run', async () => {
    const { host, store } = started('local')
    expect(await ask(host, 'note.delete', ['Notes/Secret.md'])).toMatchObject({ ok: true })
    expect(store.notes.get('note-secret')?.deletedAt).not.toBeNull()
    expect(answered(await ask(host, 'note.exists', ['Notes/Secret.md']))).toBe(false)
    expect(refused(await ask(host, 'note.read', ['Notes/Secret.md']))).toEqual({ code: 'note-not-found', detail: 'Notes/Secret.md' })
  })

  it('refuses a note that is not there and a template row it cannot trash', async () => {
    const { host } = started('local')
    expect(refused(await ask(host, 'note.delete', ['Notes/Gone.md']))).toEqual({ code: 'note-not-found', detail: 'Notes/Gone.md' })
    expect(refused(await ask(host, 'note.delete', ['Templates/Daily.md']))).toEqual({ code: 'not-supported', detail: 'note.delete:template-row' })
  })

  it('answers note-not-found when the row went in the moment the write was attempted', async () => {
    const { store, context } = started('local')
    const host = overDeps({ ...store.deps, notes: { ...store.deps.notes, remove: async () => ({ ok: false, reason: 'not-found' }) } }, context)
    expect(refused(await ask(host, 'note.delete', ['Target.md']))).toEqual({ code: 'note-not-found', detail: 'Target.md' })
  })
})

describe('folder.list and folder.create', () => {
  it('lists the tree with the paths the run reads, and the library folder beside it', async () => {
    const { host } = started('local')
    const folders = answered(await ask(host, 'folder.list')) as { id: string; path: string; parentId: string | null }[]
    expect(folders.map((folder) => [folder.id, folder.path, folder.parentId])).toEqual([
      ['folder-notes', 'Notes', null],
      ['templater:templates', 'Templates', null],
    ])
  })

  it('refuses to make a folder in the name the library is read through', async () => {
    const { host, store } = started('local')
    // `Templates/<name>.md` is a projection of the library table, and a real folder with that name would
    // give two tables one path — the ambiguity this host already refuses to write into.
    expect(refused(await ask(host, 'folder.create', ['Templates'])))
      .toEqual({ code: 'path-invalid', detail: 'reserved:Templates' })
    expect(refused(await ask(host, 'note.create', ['Templates/Note.md', 'x'])))
      .toEqual({ code: 'path-invalid', detail: 'reserved:Templates' })
    expect(store.calls).toEqual([])
  })

  it('creates each level once and answers the folder the path names', async () => {
    const { host, store } = started('local')
    const first = answered(await ask(host, 'folder.create', ['Deep/Deeper'])) as { id: string; path: string }
    expect(first).toMatchObject({ path: 'Deep/Deeper' })
    const again = answered(await ask(host, 'folder.create', ['Deep/Deeper'])) as { id: string }
    // The second call is the same folder, not a `Deeper 2` beside it: the run knows its own creations.
    expect(again.id).toBe(first.id)
    expect(store.folders.filter((folder) => folder.name === 'Deeper')).toHaveLength(1)
  })

  it('refuses a folder path that escapes, and one the app would not make', async () => {
    const { host, store, context } = started('local')
    expect(refused(await ask(host, 'folder.create', ['../Outside']))).toEqual({ code: 'path-invalid', detail: 'escape' })
    const refusedCreate = overDeps({ ...store.deps, folders: { list: () => store.folders, create: async () => null } }, context)
    expect(refused(await ask(refusedCreate, 'folder.create', ['Blocked']))).toEqual({ code: 'render-failed', detail: 'folder:Blocked' })
  })

  it('refuses a folder call that names no folder', async () => {
    const { host, store } = started('local')
    expect(refused(await ask(host, 'folder.create'))).toEqual({ code: 'path-invalid', detail: 'arg:0:type' })
    expect(refused(await ask(host, 'folder.create', ['']))).toEqual({ code: 'path-invalid', detail: 'arg:0:empty' })
    expect(store.calls).toEqual([])
  })
})

describe('template.read', () => {
  it('answers a library template by the name the gallery gives it', async () => {
    const { host } = started('local')
    expect(answered(await ask(host, 'template.read', ['Daily']))).toEqual({ content: 'daily template text' })
  })

  it('answers the template the run is executing even when the library has never heard of it', async () => {
    const gallery = templateRow('template-gallery', 'From gallery', 'gallery text')
    const { host } = started('local', { template: gallery })
    expect(answered(await ask(host, 'template.read', ['From gallery']))).toEqual({ content: 'gallery text' })
  })

  it('refuses a name the library and the run both lack', async () => {
    const { host } = started('local')
    expect(refused(await ask(host, 'template.read', ['Nope']))).toEqual({ code: 'note-not-found', detail: 'template:Nope' })
  })

  it('refuses an argument that is not a name, and reads nothing for it', async () => {
    const { host, store } = started('local')
    expect(refused(await ask(host, 'template.read'))).toEqual({ code: 'render-failed', detail: 'template.read:arg:0:type' })
    expect(refused(await ask(host, 'template.read', [{ name: 'Daily' }]))).toEqual({ code: 'render-failed', detail: 'template.read:arg:0:type' })
    expect(store.calls).toEqual([])
  })

  it('refuses to read a template under a profile that may not read another note', async () => {
    const { host, store } = started('community')
    expect(refused(await ask(host, 'template.read', ['Daily']))).toEqual({ code: 'capability-blocked', detail: 'template.read' })
    expect(store.calls).toEqual([])
  })
})

describe('note.renderInclude', () => {
  /** A `RenderIncludeRequest` as the prelude builds one: a source, this run's stack level, maybe a create. */
  function includeRequest(source: RenderIncludeRequest['source'], depth = 1, asCreate?: RenderIncludeRequest['asCreate']): RenderIncludeRequest {
    return asCreate === undefined ? { source, depth } : { source, depth, asCreate }
  }

  const noteSource = (path: string): RenderIncludeRequest['source'] => ({ kind: 'note', path, subpath: null })

  /** Wait until the fake door has recorded `count` renders; the host reaches it through microtasks only. */
  async function awaitRenders(store: FakeStore, count: number): Promise<void> {
    while (store.renders.length < count) await Promise.resolve()
  }

  it('renders a note and answers its finished text', async () => {
    const { host, store, context } = started('local')
    expect(answered(await ask(host, 'note.renderInclude', [includeRequest({ kind: 'note', path: 'Notes/Secret.md', subpath: null })])))
      .toEqual({ content: 'rendered text' })
    expect(store.calls).toEqual(['notes.read', 'nested.render'])
    const render = store.renders[0]!
    expect(render.context.runId).not.toBe(context.runId)
    expect(render.context.runId.startsWith('include-')).toBe(true)
    // The `include` reading of upstream (`InternalModuleFile.ts:212-222` re-parses with the parent's own
    // function object): every fact the child can read about the run is the parent's — same capabilities,
    // same instant, same selection, same index — and the only difference is the run id. An included note
    // therefore prints the *parent's* `tp.file.title`.
    expect({ ...render.context, runId: context.runId }).toEqual(context)
    expect(render.context.frozenTitle).toBe('Target')
    expect(render.context.target?.id).toBe('note-target')
    // `deadlineMs: 0` is the engine default, not an absence: the nested run has no page-chosen budget.
    expect(render.deadlineMs).toBe(0)
  })

  it('registers the nested run with the host while it renders and releases it after', async () => {
    const { host, store } = started('local')
    store.renderHold = true
    const call = ask(host, 'note.renderInclude', [includeRequest(noteSource('Notes/Secret.md'))])
    await awaitRenders(store, 1)
    expect(host.liveRuns()).toBe(2)
    store.resolveRenders?.forEach((resolve) => resolve({ ok: true, output: 'done', durationMs: 1 }))
    await call
    expect(host.liveRuns()).toBe(1)
  })

  it('renders raw text as the template it is', async () => {
    const { host, store } = started('local')
    expect(answered(await ask(host, 'note.renderInclude', [includeRequest({ kind: 'text', text: 'Total: <% 1 + 1 %>' })])))
      .toEqual({ content: 'rendered text' })
    // No read preceded it, and the program was compiled from exactly the text the request carried.
    expect(store.calls).toEqual(['nested.render'])
    expect(store.renders[0]!.program.template).toBe('Total: <% 1 + 1 %>')
  })

  it('reads a library template row through the template half, like every other read', async () => {
    const { host, store } = started('local')
    answered(await ask(host, 'note.renderInclude', [includeRequest(noteSource('Templates/Daily.md'))]))
    expect(store.calls).toEqual(['templates.byName', 'nested.render'])
    expect(store.renders[0]!.program.template).toBe('daily template text')
  })

  it('cuts a heading subpath the way the app cuts it for an embed, front matter and the next section gone', async () => {
    const { host, store } = started('local')
    store.notes.set('note-secret', noteRow('note-secret', 'Secret', NOTES_FOLDER.id,
      '---\ntitle: s\n---\n\n# Top\n\ninside text\n\n# Other\n\noutside text'))
    answered(await ask(host, 'note.renderInclude', [includeRequest({ kind: 'note', path: 'Notes/Secret.md', subpath: { kind: 'heading', text: 'Top' } })]))
    expect(store.renders[0]!.program.template).toBe('# Top\n\ninside text')
  })

  it('cuts a block subpath with its anchor stripped', async () => {
    const { host, store } = started('local')
    store.notes.set('note-secret', noteRow('note-secret', 'Secret', NOTES_FOLDER.id, 'first paragraph ^abc123\nsecond paragraph'))
    answered(await ask(host, 'note.renderInclude', [includeRequest({ kind: 'note', path: 'Notes/Secret.md', subpath: { kind: 'block', text: 'abc123' } })]))
    expect(store.renders[0]!.program.template).toBe('first paragraph')
  })

  it('refuses an anchor that matches nothing instead of handing back the whole note', async () => {
    const { host, store } = started('local')
    expect(refused(await ask(host, 'note.renderInclude', [includeRequest({ kind: 'note', path: 'Notes/Secret.md', subpath: { kind: 'heading', text: 'Missing' } })])))
      .toEqual({ code: 'note-not-found', detail: 'subpath:heading:Missing' })
    expect(refused(await ask(host, 'note.renderInclude', [includeRequest({ kind: 'note', path: 'Notes/Secret.md', subpath: { kind: 'block', text: 'nope1' } })])))
      .toEqual({ code: 'note-not-found', detail: 'subpath:block:nope1' })
    // Returning the full note for an anchor that is not there would print more than the template asked for.
    expect(store.calls).toEqual(['notes.read', 'notes.read'])
    expect(store.renders).toHaveLength(0)
  })

  it('refuses a note the run cannot see and a path that escapes the tree', async () => {
    const { host, store } = started('local')
    expect(refused(await ask(host, 'note.renderInclude', [includeRequest(noteSource('Notes/Gone.md'))])))
      .toEqual({ code: 'note-not-found', detail: 'Notes/Gone.md' })
    expect(refused(await ask(host, 'note.renderInclude', [includeRequest(noteSource('../Escape.md'))])))
      .toEqual({ code: 'path-invalid', detail: 'escape' })
    expect(store.calls).toEqual([])
  })

  it('refuses a parse failure with the parser code, at the position the reader wrote', async () => {
    const { host } = started('local')
    const result = await ask(host, 'note.renderInclude', [includeRequest({ kind: 'text', text: '<%~ x %>' })])
    expect(refused(result)).toEqual({ code: 'parse-invalid', detail: 'line:1:1' })
    const unclosed = await ask(host, 'note.renderInclude', [includeRequest({ kind: 'text', text: 'a\n<% x' })])
    expect(refused(unclosed).code).toBe('parse-unclosed')
  })

  it('maps the nested run own failure onto the answer, naming the child run', async () => {
    const { host, store } = started('local')
    store.nextRenderOutcome = { ok: false, code: 'sandbox-timeout', detail: 'cpu:2000' }
    const result = await ask(host, 'note.renderInclude', [includeRequest(noteSource('Notes/Secret.md'))])
    const childRunId = store.renders[0]!.context.runId
    expect(refused(result)).toEqual({ code: 'sandbox-timeout', detail: `include:${childRunId}:cpu:2000` })
  })

  it('refuses an oversized render at the size that broke, not at the write that never came', async () => {
    const { host, store } = started('local')
    store.nextRenderOutcome = { ok: true, output: 'x'.repeat(MAX_OUTPUT_CHARS + 1), durationMs: 1 }
    expect(refused(await ask(host, 'note.renderInclude', [includeRequest(noteSource('Notes/Secret.md'))])).code)
      .toBe('template-output-too-large')
  })

  it('holds the depth across nested levels: the child counts from the level it was started at', async () => {
    const { host, store } = started('local')
    store.renderHold = true
    const first = ask(host, 'note.renderInclude', [includeRequest(noteSource('Notes/Secret.md'), 1)])
    await awaitRenders(store, 1)
    const childRunId = store.renders[0]!.context.runId
    // The child's own stack of 9 puts its render at level 10 — upstream's tenth include works and its
    // eleventh throws (`InternalModuleFile.ts:162-166`), and the page owns the ceiling because each run's
    // counters see only their own interpreter.
    const second = ask(host, 'note.renderInclude', [includeRequest(noteSource('Notes/Secret.md'), 9)], childRunId)
    await awaitRenders(store, 2)
    expect(store.renders[1]!.context.runId.startsWith('include-')).toBe(true)
    expect(refused(await ask(host, 'note.renderInclude', [includeRequest(noteSource('Notes/Secret.md'), 10)], childRunId)))
      .toEqual({ code: 'template-recursion', detail: 'depth:11' })
    store.resolveRenders.forEach((resolve) => resolve({ ok: true, output: 'done', durationMs: 1 }))
    expect(answered(await first)).toEqual({ content: 'done' })
    expect(answered(await second)).toEqual({ content: 'done' })
  })

  it('cancels a child render when its parent run is released, and does not leave it registered', async () => {
    const { host, store } = started('local')
    store.renderHold = true
    const call = ask(host, 'note.renderInclude', [includeRequest(noteSource('Notes/Secret.md'))])
    await awaitRenders(store, 1)
    const childRunId = store.renders[0]!.context.runId
    host.endRun('run-1')
    // A cancelled or failed parent must not leave its child rendering text nobody will answer.
    expect(store.cancelled).toEqual([childRunId])
    expect(host.liveRuns()).toBe(0)
    store.resolveRenders?.forEach((resolve) => resolve({ ok: false, code: 'render-failed', detail: 'cancelled' }))
    expect(refused(await call)).toEqual({ code: 'render-failed', detail: `include:${childRunId}:cancelled` })
  })

  it('gives a create-new render the note being made as its whole world, and the include the parent', async () => {
    const { host, store, context } = started('local')
    answered(await ask(host, 'note.renderInclude', [includeRequest(
      noteSource('Templates/Daily.md'),
      1,
      { path: 'Notes/Child.md', title: 'Child', templatePath: 'Templates/Daily.md' },
    )]))
    // Upstream gives a `create_new` child its own running config, with the created note as the target and
    // `RunMode.CreateNewFromTemplate` (`Templater.ts:194-214`): the child prints the new note title, its
    // folder, and the source template as `tp.config.template_file`.
    const child = store.renders[0]!.context
    expect(child.mode).toBe('create-new')
    expect(child.frozenTitle).toBe('Child')
    expect(child.target).toMatchObject({ title: 'Child', content: '', isEmpty: true, folderId: NOTES_FOLDER.id })
    expect(child.active).toEqual(child.target)
    expect(child.template).toEqual({ id: 'template-daily', name: 'Daily', content: 'daily template text' })
    expect(child.index).toContainEqual(expect.objectContaining({ path: 'Notes/Child.md' }))
    // Never wider than the parent, and the shared facts still carry over untouched.
    expect(child.capabilities).toBe(context.capabilities)
    expect(child.startedAt).toBe(context.startedAt)
    expect(child.locale).toBe(context.locale)
    expect(child.selection).toBe(context.selection)
  })

  it('answers a text-sourced create with no template file, the way upstream leaves it undefined', async () => {
    const { host, store } = started('local')
    answered(await ask(host, 'note.renderInclude', [includeRequest(
      { kind: 'text', text: 'raw body' },
      1,
      { path: 'Fresh.md', title: 'Fresh' },
    )]))
    const child = store.renders[0]!.context
    expect(child.template).toBeNull()
    expect(child.target).toMatchObject({ title: 'Fresh', folderId: null, isEmpty: true })
    expect(child.target?.id.startsWith('templater:pending:')).toBe(true)
  })

  it('refuses a request that is not the contract shape, naming the field', async () => {
    const { host, store } = started('local')
    expect(refused(await ask(host, 'note.renderInclude', [42]))).toEqual({ code: 'render-failed', detail: 'note.renderInclude:shape' })
    expect(refused(await ask(host, 'note.renderInclude', [{ source: { kind: 'other' }, depth: 1 }])))
      .toEqual({ code: 'render-failed', detail: 'note.renderInclude:source' })
    expect(refused(await ask(host, 'note.renderInclude', [{ source: { kind: 'text', text: 'x' }, depth: 0 }])).code)
      .toBe('render-failed')
    expect(refused(await ask(host, 'note.renderInclude', [{ source: { kind: 'text', text: 'x' }, depth: 1, asCreate: { path: 'a.md' } }])).code)
      .toBe('render-failed')
    // Nothing was read, compiled or started for any of them.
    expect(store.calls).toEqual([])
  })
})

describe('note.open', () => {
  it('shows the note through the store own open path and answers nothing else', async () => {
    const { host, store } = started('local')
    const result = await ask(host, 'note.open', ['Notes/Secret.md'])
    expect(result).toMatchObject({ ok: true, value: undefined })
    expect(store.calls).toEqual(['editor.open'])
  })

  it('refuses a note the run index does not carry, without touching the editor', async () => {
    const { host, store } = started('local')
    expect(refused(await ask(host, 'note.open', ['Notes/Gone.md']))).toEqual({ code: 'note-not-found', detail: 'Notes/Gone.md' })
    expect(refused(await ask(host, 'note.open', ['../Escape.md']))).toEqual({ code: 'path-invalid', detail: 'escape' })
    expect(store.calls).toEqual([])
  })

  it('refuses to open a library template row', async () => {
    const { host } = started('local')
    expect(refused(await ask(host, 'note.open', ['Templates/Daily.md'])))
      .toEqual({ code: 'not-supported', detail: 'note.open:template-row' })
  })

  it('refuses with a named cause when no pane can show the note', async () => {
    const { host, store } = started('local')
    store.openAnswer = false
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(refused(await ask(host, 'note.open', ['Notes/Secret.md']))).toEqual({ code: 'render-failed', detail: 'note.open:no-leaf' })
    expect(warned).toHaveBeenCalledWith('[inkstone] templater note.open found no pane to show the note in', 'Notes/Secret.md')
    warned.mockRestore()
  })
})

describe('cursor.append', () => {
  it('appends at the selection through the editor port and always answers', async () => {
    const { host, store } = started('local')
    const result = await ask(host, 'cursor.append', [{ text: 'appended' }])
    expect(result).toMatchObject({ ok: true, value: undefined })
    expect(store.appended).toEqual(['appended'])
    // The worker does not await this call, but it does wait for the answer to arrive before reporting the
    // run done (`SYNC_METHODS`), so an answer in both outcomes is the contract.
    store.appendAnswer = false
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const noEditor = await ask(host, 'cursor.append', [{ text: 'still answered' }])
    expect(noEditor).toMatchObject({ ok: true, value: undefined })
    expect(warned).toHaveBeenCalledWith('[inkstone] templater cursor_append found no active editor to append to')
    warned.mockRestore()
    expect(store.appended).toEqual(['appended', 'still answered'])
  })

  it('refuses an argument that is not the { text } the prelude sends', async () => {
    const { host, store } = started('local')
    expect(refused(await ask(host, 'cursor.append'))).toEqual({ code: 'render-failed', detail: 'cursor.append:arg:0:type' })
    expect(refused(await ask(host, 'cursor.append', ['appended'])))
      .toEqual({ code: 'render-failed', detail: 'cursor.append:arg:0:type' })
    expect(refused(await ask(host, 'cursor.append', [{ text: 7 }])))
      .toEqual({ code: 'render-failed', detail: 'cursor.append:arg:0:type' })
    expect(store.appended).toEqual([])
  })
})

/**
 * `createTarget` is `note.create`'s path logic handed to the write pipeline, which creates its row with the
 * finished document already in it and therefore cannot ask `note.create` twice. These four cases are the
 * reason it is a call rather than a copy: the same refusals, the same folder chain, one rule.
 */
describe('createTarget', () => {
  it('answers the title and folder a path files into, creating the chain it names', async () => {
    const { host, store, context } = started('local')
    const target = await host.createTarget(context, 'Journal/2026/Today.md')
    if (!target.ok) throw new Error(`refused: ${target.code} ${target.detail}`)
    expect(target.title).toBe('Today')
    expect(store.folders.find((folder) => folder.id === target.folderId)?.name).toBe('2026')
    expect(store.folders.map((folder) => folder.name)).toContain('Journal')
  })

  it('refuses a taken path and a traversal without touching the tree', async () => {
    const { host, store, context } = started('local')
    const folders = store.folders.length
    expect(await host.createTarget(context, 'Target.md')).toEqual({ ok: false, code: 'note-conflict', detail: 'Target.md' })
    expect(await host.createTarget(context, '../Secret.md')).toEqual({ ok: false, code: 'path-invalid', detail: 'escape' })
    expect(store.folders.length).toBe(folders)
  })

  it('answers the destination `note.create` then uses, so the two cannot drift', async () => {
    const { host, store, context } = started('local')
    const target = await host.createTarget(context, 'Journal/Today.md')
    if (!target.ok) throw new Error(`refused: ${target.code} ${target.detail}`)
    const created = answered(await ask(host, 'note.create', ['Journal/Today.md', 'body'])) as { path: string; title: string }
    expect(created).toMatchObject({ path: 'Journal/Today.md', title: 'Today' })
    const row = [...store.notes.values()].find((note) => note.title === 'Today')
    expect(row?.folderId).toBe(target.folderId)
  })

  it('answers a run the page has already released, because the pipeline applies after the render', async () => {
    // The reader's own "new note from a Templater template" is applied from `host/run-template.ts` once
    // `renderTemplate` has returned, and the door releases the run in its `finally`. Measured in a real
    // browser on 2026-10-21: the destination came back as `render-failed` and no note was made. A released
    // run is not a refusal.
    const { host, context } = started('local')
    host.endRun(context.runId)
    const target = await host.createTarget(context, 'Journal/Today.md')
    if (!target.ok) throw new Error(`refused: ${target.code} ${target.detail}`)
    expect(target.title).toBe('Today')
  })

  it('refuses a path that escapes the tree whatever the run was registered as', async () => {
    const { host, context } = started('local')
    expect(await host.createTarget({ ...context, runId: 'never-registered' }, '../Secret.md'))
      .toEqual({ ok: false, code: 'path-invalid', detail: 'escape' })
  })
})
