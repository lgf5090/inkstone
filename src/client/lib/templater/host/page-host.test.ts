import { describe, expect, it, vi } from 'vitest'
import type { Folder, Note, NoteTemplate } from '@shared/types'
import { HOST_METHOD_CAPABILITY, HOST_METHODS, capabilitiesFor, type CapabilityProfile, type HostResult, type TemplateRunContext } from '../protocol'
import { MAX_HOST_ARG_CHARS } from '../limits'
import { buildRunSnapshot, type RunSnapshotInput } from '../context/snapshot'
import { createPageHost, MAX_TRACKED_RUNS, OWNED_METHODS, type PageHost, type PageHostDeps } from './page-host'

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
    },
    notes,
    folders,
    templates,
    calls,
    raceNextWrite: false,
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
