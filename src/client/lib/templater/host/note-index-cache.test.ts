import { describe, expect, it } from 'vitest'
import type { Folder, Note, NoteTemplate } from '@shared/types'
import type { FolderIndexEntry, NoteIndexEntry, TemplateRunContext } from '../protocol'
import { TEMPLATES_FOLDER_ID } from '../context/file-wrapper'
import { buildNoteIndex, type NoteIndex, type NoteIndexInput } from '../context/note-index'
import { buildRunSnapshot, noteIndexFor, type RunSnapshotInput } from '../context/snapshot'
import {
  MAX_TRACKED_INDEXES,
  createNoteIndexCache,
  libraryVersion,
  runIndexRows,
  runProjectionIds,
  type LibraryRows,
  type NoteIndexBuilder,
  type NoteIndexCache,
} from './note-index-cache'
import { createPageHost, type PageHostDeps } from './page-host'

/**
 * The cache exists because building an index is the expensive thing a template run does: 20,000 rows measured
 * at 214.6 ms on this machine, paid once by `context/snapshot.ts` to freeze the run's rows, and paid again by
 * `./page-host.ts` for a library that had not moved in between. So the cases here are about the two things that
 * have to be true at once, and neither of them is the speed:
 *
 * - **a run gets the index of its own rows.** The library is shared; the target, the active note and the applied
 *   template are not, and a run that cannot see the note it was pointed at is a note somebody loses.
 * - **a library that moved is not the library cached.** Four ways the rows move, each its own case, because a
 *   cache that never invalidates is worse than no cache at all: it answers from a tree the reader has already
 *   changed, and a path that resolved last minute is the wrong path this one.
 *
 * Nothing asserts on time. The win is how many times the builder ran, which is exact; a stopwatch on a shared
 * machine is a report somebody has to re-run.
 */

const F_ROOT: Folder = { id: 'f-root', parentId: null, name: 'notes', icon: null, color: null, position: 0, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 }
const F_ARCHIVE: Folder = { id: 'f-archive', parentId: null, name: 'archive', icon: null, color: null, position: 1, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 }

function note(overrides: Partial<Note> & { id: string; title: string }): Note {
  return {
    excerpt: '',
    content: `body of ${overrides.id}`,
    folderId: F_ROOT.id,
    tags: [],
    isPinned: false,
    isStarred: false,
    isArchived: false,
    wordCount: 1,
    charCount: 4,
    rev: 1,
    position: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    deletedAt: null,
    ...overrides,
  }
}

function template(overrides: Partial<NoteTemplate> & { id: string; name: string }): NoteTemplate {
  return {
    categoryId: null,
    description: '',
    content: `template ${overrides.name}`,
    builtin: false,
    isPinned: false,
    isStarred: false,
    tags: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

/** The library every small case starts from: two notes in two folders, one library template. */
function library(): LibraryRows {
  return {
    notes: [
      note({ id: 'n-target', title: 'Target' }),
      note({ id: 'n-other', title: 'Other', folderId: F_ARCHIVE.id }),
    ],
    folders: [{ ...F_ROOT }, { ...F_ARCHIVE }],
    templates: [template({ id: 't-daily', name: 'Daily' })],
  }
}

/** A run's context, built the way the page builds one — which is what makes the rows under test real rows. */
function snapshotOf(rows: LibraryRows, overrides: Partial<RunSnapshotInput> = {}): TemplateRunContext {
  return buildRunSnapshot({
    runId: 'run-1',
    notes: rows.notes,
    folders: rows.folders,
    templates: rows.templates,
    target: rows.notes[0] ?? null,
    active: rows.notes[0] ?? null,
    template: null,
    mode: 'overwrite-active',
    capabilities: 'local',
    locale: 'en-US',
    startedAt: 1_700_000_000_000,
    ...overrides,
  })
}

/** The builder, wrapped so the number of indexes it made is a fact a test can read rather than infer. */
function countingBuilder(): { build: NoteIndexBuilder; sizes: number[] } {
  const sizes: number[] = []
  return {
    sizes,
    build: (input: NoteIndexInput) => {
      sizes.push(input.notes.length + (input.templates?.length ?? 0))
      return buildNoteIndex(input)
    },
  }
}

/** The index one run resolves through, asked for exactly the way `./page-host.ts` asks for it. */
function indexOfRun(cache: NoteIndexCache, context: TemplateRunContext): NoteIndex {
  return cache.indexFor(runIndexRows(context), runProjectionIds(context))
}

function entry(id: string, path: string, overrides: Partial<NoteIndexEntry> = {}): NoteIndexEntry {
  const slash = path.lastIndexOf('/')
  return {
    id,
    title: (slash === -1 ? path : path.slice(slash + 1)).replace(/\.md$/, ''),
    folderId: null,
    path,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

const CACHE_FOLDERS: FolderIndexEntry[] = [
  { id: F_ROOT.id, name: F_ROOT.name, parentId: null, path: 'notes' },
  { id: F_ARCHIVE.id, name: F_ARCHIVE.name, parentId: null, path: 'archive' },
  { id: TEMPLATES_FOLDER_ID, name: 'Templates', parentId: null, path: 'Templates' },
]

describe('a shared library, a run of one', () => {
  it('builds one index for two runs of one library and gives each run its own rows', () => {
    const rows = library()
    const builder = countingBuilder()
    const cache = createNoteIndexCache({ build: builder.build, version: () => libraryVersion(rows) })

    // One run over a library that already lists its note; one started a frame after a note was made, so that
    // note is in its snapshot and nowhere in the page's list yet, applying a template lifted out of the
    // gallery rather than imported into the reader's library.
    const first = snapshotOf(rows, { runId: 'run-first' })
    const made = note({ id: 'n-made', title: 'Made', content: '' })
    const gallery = template({ id: 't-gallery', name: 'Gallery' })
    const second = snapshotOf(rows, { runId: 'run-second', target: made, active: rows.notes[1]!, template: gallery })

    const firstIndex = indexOfRun(cache, first)
    const secondIndex = indexOfRun(cache, second)

    // One index, over the library with the first run's own note taken out of it — what every later run of the
    // same library projects back on.
    expect(builder.sizes).toEqual([2])
    expect(cache.builds()).toBe(1)

    expect(firstIndex.getByPath('notes/Target.md')?.id).toBe('n-target')
    expect(secondIndex.getByPath('notes/Made.md')?.id).toBe('n-made')
    expect(secondIndex.getByPath('Templates/Gallery.md')?.id).toBe('t-gallery')
    expect(secondIndex.getByPath('archive/Other.md')?.id).toBe('n-other')
    expect(secondIndex.existsPath('notes/Made.md')).toBe(true)

    // A row belonging to one run is not a row of the next: the cached library holds neither run's projections.
    expect(firstIndex.getByPath('notes/Made.md')).toBeNull()
    expect(firstIndex.getByPath('Templates/Gallery.md')).toBeNull()
    // And a projection the library *does* hold survives the base being stripped of it, because the run puts it
    // back: `n-other` is the second run's active note and a library row, and it is still there to resolve.
    expect(firstIndex.getByPath('archive/Other.md')?.id).toBe('n-other')
    expect(secondIndex.allTemplates().map((item) => item.id)).toEqual(expect.arrayContaining(['t-daily', 't-gallery']))
  })

  it('answers the same paths as an index built over the run alone', () => {
    const rows = library()
    const cache = createNoteIndexCache({ version: () => libraryVersion(rows) })
    const made = note({ id: 'n-made', title: 'Made', content: '' })
    const gallery = template({ id: 't-gallery', name: 'Gallery' })
    const context = snapshotOf(rows, { runId: 'run-1', target: made, active: rows.notes[1]!, template: gallery })

    const cached = indexOfRun(cache, context)
    const fresh = noteIndexFor(context)

    for (const path of ['notes/Target.md', 'archive/Other.md', 'notes/Made.md', 'Templates/Gallery.md', 'Templates/Daily.md', 'nowhere.md']) {
      expect(cached.resolvePath(path), path).toEqual(fresh.resolvePath(path))
    }
    expect(cached.getById('n-made')).toEqual(fresh.getById('n-made'))
    expect(cached.getById('t-daily')).toEqual(fresh.getById('t-daily'))
    expect(cached.getTemplateByName('Gallery')).toEqual(fresh.getTemplateByName('Gallery'))
    expect(cached.getTemplateByName('Daily')).toEqual(fresh.getTemplateByName('Daily'))
    expect(cached.entries.map((item) => item.id).sort()).toEqual(fresh.entries.map((item) => item.id).sort())
    expect(cached.folders).toEqual(fresh.folders)
  })

  it('keeps a path two rows claim ambiguous, whichever run one of them belongs to', () => {
    const rows = library()
    const cache = createNoteIndexCache({ version: () => libraryVersion(rows) })
    // The library has a note at `notes/Target.md`, and the run is about a different row that lands on it too.
    const twin = note({ id: 'n-twin', title: 'Target', content: 'a second row at one path' })
    const context = snapshotOf(rows, { runId: 'run-1', target: twin, active: twin })

    const cached = indexOfRun(cache, context).resolvePath('notes/Target.md')
    const fresh = noteIndexFor(context).resolvePath('notes/Target.md')

    expect(cached.ambiguous).toBe(true)
    expect(cached.matches.map((item) => item.id)).toEqual(fresh.matches.map((item) => item.id))
    expect(cached.entry?.id).toBe(fresh.entry?.id)
  })
})

describe('a version names the library, and every way it moves', () => {
  /** One library before and after one change, so each case compares the same two row sets. */
  function changed(change: (rows: LibraryRows) => void): { before: LibraryRows; after: LibraryRows } {
    const before = library()
    const after = library()
    change(after)
    return { before, after }
  }

  it('takes a new note as a new version, and answers it as soon as the version moves', () => {
    const { before, after } = changed((rows) => rows.notes.push(note({ id: 'n-new', title: 'Fresh' })))
    expect(libraryVersion(after)).not.toBe(libraryVersion(before))

    let live = before
    const cache = createNoteIndexCache({ version: () => libraryVersion(live) })
    const first = indexOfRun(cache, snapshotOf(live))
    expect(first.getByPath('notes/Fresh.md')).toBeNull()

    // A row that arrived is not a row that moved: the library the cache holds is still inside this run's rows,
    // so the cache projects the new note onto it instead of indexing the library again. Same answer, one less
    // rebuild — which is what a run that creates notes as it goes would otherwise pay for every note.
    live = after
    const index = indexOfRun(cache, snapshotOf(live))
    expect(cache.builds()).toBe(1)
    expect(index.getByPath('notes/Fresh.md')?.id).toBe('n-new')
    expect(index.getByPath('notes/Target.md')?.id).toBe('n-target')
  })

  it('rebuilds when a note the cached library holds is written, because that row changed under it', () => {
    const { before, after } = changed((rows) => {
      rows.notes[1] = { ...rows.notes[1], rev: 2, updatedAt: 1_700_000_000_500, content: 'a different body' }
    })
    expect(libraryVersion(after)).not.toBe(libraryVersion(before))

    let live = before
    const cache = createNoteIndexCache({ version: () => libraryVersion(live) })
    indexOfRun(cache, snapshotOf(live))
    // The note written is not the one either run is about, so it is in the cached library as a row the index
    // holds wrong. `rev` is what tells the page a body was written and `updatedAt` is the field the index row
    // carries, and a store write moves both together — so the library is indexed again rather than trusted.
    live = after
    const index = indexOfRun(cache, snapshotOf(live))
    expect(cache.builds()).toBe(2)
    expect(index.getByPath('archive/Other.md')?.id).toBe('n-other')
    expect(index.getById('n-other')?.updatedAt).toBe(1_700_000_000_500)
  })

  it('projects a changed row the run is about instead of rebuilding the library for it', () => {
    const { before, after } = changed((rows) => {
      rows.notes[0] = { ...rows.notes[0], rev: 2, updatedAt: 1_700_000_000_500, content: 'a different body' }
    })
    expect(libraryVersion(after)).not.toBe(libraryVersion(before))

    let live = before
    const cache = createNoteIndexCache({ version: () => libraryVersion(live) })
    indexOfRun(cache, snapshotOf(live))
    // The other half of the same rule: the note this run is about was never part of the cached library, so
    // the row the run carries is the row the index answers with, and the version moving does not cost a
    // rebuild of 20,000 rows that are all still right.
    live = after
    const index = indexOfRun(cache, snapshotOf(live))
    expect(cache.builds()).toBe(1)
    expect(index.getByPath('notes/Target.md')?.id).toBe('n-target')
    expect(index.getById('n-target')?.updatedAt).toBe(1_700_000_000_500)
  })

  it('rebuilds when a folder is renamed, and the old path is gone from the new index', () => {
    const { before, after } = changed((rows) => {
      rows.folders = rows.folders.map((folder) => (folder.id === F_ROOT.id ? { ...folder, name: 'journals' } : folder))
    })
    expect(libraryVersion(after)).not.toBe(libraryVersion(before))

    let live = before
    const cache = createNoteIndexCache({ version: () => libraryVersion(live) })
    const first = indexOfRun(cache, snapshotOf(live))
    expect(first.getByPath('notes/Target.md')?.id).toBe('n-target')

    live = after
    const index = indexOfRun(cache, snapshotOf(live))
    expect(cache.builds()).toBe(2)
    expect(index.getByPath('journals/Target.md')?.id).toBe('n-target')
    expect(index.getByPath('notes/Target.md')).toBeNull()
  })

  it('rebuilds when a library template is edited', () => {
    const { before, after } = changed((rows) => {
      rows.templates = rows.templates.map((item) => (item.id === 't-daily' ? { ...item, name: 'Daily note', updatedAt: 1_700_000_000_500 } : item))
    })
    expect(libraryVersion(after)).not.toBe(libraryVersion(before))

    let live = before
    const cache = createNoteIndexCache({ version: () => libraryVersion(live) })
    const first = indexOfRun(cache, snapshotOf(live))
    expect(first.getTemplateByName('Daily')?.id).toBe('t-daily')

    live = after
    const index = indexOfRun(cache, snapshotOf(live))
    expect(cache.builds()).toBe(2)
    expect(index.getTemplateByName('Daily note')?.id).toBe('t-daily')
    expect(index.getTemplateByName('Daily')).toBeNull()
  })

  it('reads a body edit that moved no row as the same library, because no index row holds a body', () => {
    // The one change a version deliberately lets through, and the reason it can: an index carries no body for
    // any note, which is the only reason 20,000 of them are affordable at all. `rev` is the page's signal that
    // a body moved; a caller that rewrote a body without touching `rev`, the title, the folder or either
    // timestamp changed nothing an index reads — and every read of the note itself still goes to the store by
    // row id, so the text a template gets is the text the note has.
    const before = library()
    const after = library()
    after.notes = after.notes.map((row) => ({ ...row, content: `${row.content} and more` }))
    expect(libraryVersion(after)).toBe(libraryVersion(before))
  })

  it('reads a reorder of the same rows as the same library', () => {
    const before = library()
    const after = library()
    after.notes = [...after.notes].reverse()
    expect(libraryVersion(after)).toBe(libraryVersion(before))
  })
})

describe('the bound', () => {
  /** Six distinct libraries, one per version the cases below walk through. */
  function libraries(): LibraryRows[] {
    return Array.from({ length: 6 }, (_, index) => ({
      notes: [note({ id: `n-${index}`, title: `Note ${index}` })],
      folders: [{ ...F_ROOT }],
      templates: [template({ id: `t-${index}`, name: `Template ${index}` })],
    }))
  }

  it('keeps the versions in use, drops the oldest, and stays right about every one of them', () => {
    const sets = libraries()
    let live = sets[0]
    const cache = createNoteIndexCache({ version: () => libraryVersion(live) })

    for (const [index, rows] of sets.entries()) {
      live = rows
      const asked = indexOfRun(cache, snapshotOf(rows))
      expect(asked.getByPath(`notes/Note ${index}.md`)?.id).toBe(`n-${index}`)
    }
    expect(cache.sizes()).toHaveLength(MAX_TRACKED_INDEXES)
    expect(cache.builds()).toBe(sets.length)

    // The first version was the one dropped. Asking it again rebuilds it rather than answering from a
    // library that happens to share a slot, and it never sees the rows of the version that replaced it.
    live = sets[0]
    const revived = indexOfRun(cache, snapshotOf(live))
    expect(cache.builds()).toBe(sets.length + 1)
    expect(revived.getByPath('notes/Note 0.md')?.id).toBe('n-0')
    expect(revived.getByPath('notes/Note 5.md')).toBeNull()
  })

  it('rebuilds a row the cached library holds wrongly, even when the version the page gave never moved', () => {
    // The silent-staleness case, and the reason a version is only a way of finding a library: a page whose key
    // did not move for a rename still cannot be answered from an index that holds the old name, because the
    // run's own rows say what the library is.
    const rows = library()
    const cache = createNoteIndexCache({ version: () => 'a-counter-that-never-moves' })
    const first = indexOfRun(cache, snapshotOf(rows))
    expect(first.getByPath('archive/Other.md')?.id).toBe('n-other')

    const renamed = library()
    renamed.notes[1] = { ...renamed.notes[1], title: 'Renamed', updatedAt: 1_700_000_000_500 }
    const index = indexOfRun(cache, snapshotOf(renamed))

    expect(cache.builds()).toBe(2)
    expect(index.getByPath('archive/Renamed.md')?.id).toBe('n-other')
    expect(index.getByPath('archive/Other.md')).toBeNull()
    // The next run of the same rows reads the rebuilt library rather than indexing it a third time.
    expect(indexOfRun(cache, snapshotOf(renamed)).getByPath('archive/Renamed.md')?.id).toBe('n-other')
    expect(cache.builds()).toBe(2)
  })

  it('answers every run correctly with nothing stored at all', () => {
    const rows = library()
    const cache = createNoteIndexCache({ version: () => libraryVersion(rows), maxTracked: 0 })
    const first = indexOfRun(cache, snapshotOf(rows))
    const second = indexOfRun(cache, snapshotOf(rows, { runId: 'run-2' }))

    expect(cache.builds()).toBe(2)
    expect(cache.sizes()).toEqual([])
    expect(first.getByPath('notes/Target.md')?.id).toBe('n-target')
    expect(second.getByPath('archive/Other.md')?.id).toBe('n-other')
  })

  it('keys itself off the rows when the page reports no version at all', () => {
    const rows = library()
    const cache = createNoteIndexCache({ version: () => null })
    const first = indexOfRun(cache, snapshotOf(rows))
    const second = indexOfRun(cache, snapshotOf(rows, { runId: 'run-2' }))

    // `null` is the page saying it cannot name a version, not the cache saying it cannot answer: the rows
    // describe the library well enough to share it, and to rebuild the moment they stop describing it.
    expect(cache.builds()).toBe(1)
    expect(first.getByPath('notes/Target.md')?.id).toBe('n-target')
    expect(second.getTemplateByName('Daily')?.id).toBe('t-daily')
  })
})

describe('a version the rows do not agree with', () => {
  it('rebuilds instead of answering from a library larger than the rows asked about', () => {
    // A counter that moved faster than the rows a run carries is the version this cache refuses to lean on:
    // the stored index would know rows the run never saw, and a run's answers come from its own snapshot.
    const cache = createNoteIndexCache({ version: () => 'the-same-whatever-happens' })
    const wide: NoteIndexInput = {
      notes: [entry('n1', 'notes/One.md'), entry('n2', 'notes/Two.md'), entry('n3', 'notes/Three.md')],
      templates: [templateRow('t1', 'Daily')],
      folders: CACHE_FOLDERS,
    }
    const narrow: NoteIndexInput = { notes: [entry('n2', 'notes/Two.md')], templates: [], folders: CACHE_FOLDERS }

    const first = cache.indexFor(wide)
    const second = cache.indexFor(narrow)

    expect(cache.builds()).toBe(2)
    expect(second.getByPath('notes/One.md')).toBeNull()
    expect(second.getByPath('notes/Two.md')?.id).toBe('n2')
    // And the wide library is still there to be asked again: the refused entry was not overwritten by the
    // narrow one, which is the difference between a slow run and a wrong one.
    expect(first.getByPath('notes/Three.md')?.id).toBe('n3')
    expect(cache.indexFor(wide).getByPath('Templates/Daily.md')?.id).toBe('t1')
    expect(cache.builds()).toBe(2)
  })

  it('still projects a run\'s own rows when the version is one it cannot lean on', () => {
    const rows = library()
    const cache = createNoteIndexCache({ version: () => 'always-this-one' })
    const made = note({ id: 'n-made', title: 'Made', content: '' })
    const first = indexOfRun(cache, snapshotOf(rows, { runId: 'run-1' }))
    const second = indexOfRun(cache, snapshotOf(rows, { runId: 'run-2', target: made, active: made }))

    expect(first.getByPath('notes/Made.md')).toBeNull()
    expect(second.getByPath('notes/Made.md')?.id).toBe('n-made')
    // The base was stripped of `n-target` when the first run stored it, and every run puts its own rows back.
    expect(second.getByPath('notes/Target.md')?.id).toBe('n-target')
    expect(second.existsPath('archive/Other.md')).toBe(true)
  })

  it('shares one library between two runs when the page keeps no version', () => {
    const rows = library()
    const builder = countingBuilder()
    const cache = createNoteIndexCache({ build: builder.build })
    const made = note({ id: 'n-made', title: 'Made', content: '' })

    indexOfRun(cache, snapshotOf(rows, { runId: 'run-1' }))
    indexOfRun(cache, snapshotOf(rows, {
      runId: 'run-2',
      target: made,
      active: made,
      template: template({ id: 't-gallery', name: 'Gallery' }),
    }))
    expect(builder.sizes).toEqual([2])

    // The same rows under a moved folder are a different key, because the key is the rows.
    const renamed: LibraryRows = {
      notes: rows.notes,
      folders: rows.folders.map((folder) => ({ ...folder, name: `journals-${folder.name}` })),
      templates: rows.templates,
    }
    const index = indexOfRun(cache, snapshotOf(renamed, { runId: 'run-3' }))
    expect(builder.sizes).toHaveLength(2)
    expect(index.getByPath('journals-notes/Target.md')?.id).toBe('n-target')
  })
})

describe('the cost, counted', () => {
  it('indexes a 20,000-row library once and then answers five runs without reaching the builder', () => {
    const folders: Folder[] = Array.from({ length: 40 }, (_, index) => ({
      id: `f${index}`,
      parentId: null,
      name: `folder-${index}`,
      icon: null,
      color: null,
      position: index,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    }))
    const notes: Note[] = Array.from({ length: 20_000 }, (_, index) => note({
      id: `n${index}`,
      title: `Note ${index}`,
      folderId: folders[index % folders.length].id,
      content: `body ${index}`,
    }))
    const rows = { notes, folders, templates: [template({ id: 't-daily', name: 'Daily' })] }
    // A counter standing in for the store's own revision: the library does not move during these six runs, so
    // the page says so once per run by naming the version, and the cache answers without rebuilding.
    let counter = 'library-1'
    const builder = countingBuilder()
    const cache = createNoteIndexCache({ build: builder.build, version: () => counter })

    // The contexts are the page's own work — `context/snapshot.ts` paying for the index it ships to the worker
    // — and they are built before the timer runs, so what is measured below is the cache and nothing else.
    const made = note({ id: 'n-made', title: 'Made', folderId: folders[7].id, content: '' })
    const chosen = [0, 5_000, 10_000, 15_000, 19_999]
    const contexts = [
      ...chosen.map((index, position) => snapshotOf(rows, {
        runId: `run-${index}`,
        target: notes[index],
        active: notes[(index + 1) % notes.length],
        template: position % 2 === 0 ? null : rows.templates[0],
      })),
      snapshotOf(rows, { runId: 'run-made', target: made, active: notes[3] }),
    ]

    const started = performance.now()
    const first = indexOfRun(cache, contexts[0])
    const rebuildMs = performance.now() - started
    expect(first.getByPath('folder-0/Note 0.md')?.id).toBe('n0')
    // One rebuild, over the library with this run's two rows taken out of it — 20,000 library rows, two of
    // them the rows the run is about, and the base is the library alone.
    expect(builder.sizes).toEqual([19_999])

    const asked = performance.now()
    for (const [position, context] of contexts.entries()) {
      const index = indexOfRun(cache, context)
      if (position < chosen.length) {
        expect(index.getByPath(`folder-${chosen[position] % 40}/Note ${chosen[position]}.md`)?.id).toBe(`n${chosen[position]}`)
      } else {
        expect(index.getByPath('folder-7/Made.md')?.id).toBe('n-made')
      }
      expect(index.getByPath('folder-0/Note 0.md')?.id).toBe('n0')
      expect(index.getByPath('Templates/Daily.md')?.id).toBe('t-daily')
      // The invariant behind all of it, read once so the timer below measures a hit the way the page has one:
      // a run's index holds its snapshot's rows, no more and none missing.
      if (position === contexts.length - 1) expect(index.entries).toHaveLength(context.index.length)
    }
    const hitMs = (performance.now() - asked) / contexts.length

    expect(builder.sizes).toHaveLength(1)
    expect(cache.builds()).toBe(1)

    // A version taken off the rows instead of a counter is the other shape the page can hand over, and it is
    // the slower of the two: recorded here so the number is known rather than argued about later.
    const keyed = performance.now()
    const version = libraryVersion(rows)
    const fingerprintMs = performance.now() - keyed
    expect(libraryVersion({ ...rows, notes: [...rows.notes].reverse() })).toBe(version)

    // Recorded, not asserted: the machine is shared, and the bound this card has to hold is the builder count.
    console.info(
      `templater note-index cache: 20,000 rows rebuilt in ${rebuildMs.toFixed(1)} ms, `
      + `a counter-keyed hit answered in ${hitMs.toFixed(1)} ms, `
      + `a fingerprint of the same rows costs ${fingerprintMs.toFixed(1)} ms`,
    )
  })
})

describe('through the page host', () => {
  /** The store the host reads, which may hold more rows than the run\'s library list did. */
  function hostDeps(store: LibraryRows, cache: NoteIndexCache): PageHostDeps {
    const notes = new Map(store.notes.map((row) => [row.id, row]))
    return {
      notes: {
        async read(id) {
          const row = notes.get(id)
          return row && row.deletedAt === null ? row : null
        },
        async write(id, content) {
          const current = notes.get(id)
          if (!current) return { ok: false, reason: 'not-found' }
          const next = { ...current, content, rev: current.rev + 1 }
          notes.set(id, next)
          return { ok: true, note: next }
        },
        async update(id, changes) {
          const current = notes.get(id)
          if (!current) return { ok: false, reason: 'not-found' }
          const next = { ...current, ...changes, rev: current.rev + 1 }
          notes.set(id, next)
          return { ok: true, note: next }
        },
        async create({ title, content, folderId }) {
          const created = note({ id: `n-created-${notes.size + 1}`, title, folderId, content })
          notes.set(created.id, created)
          return { ok: true, note: created }
        },
        async remove(id) {
          const current = notes.get(id)
          if (!current) return { ok: false, reason: 'not-found' }
          const trashed = { ...current, deletedAt: 1_700_000_000_001 }
          notes.set(id, trashed)
          return { ok: true, note: trashed }
        },
      },
      folders: {
        list: () => store.folders.map((folder) => ({ ...folder })),
        async create() {
          return null
        },
      },
      templates: {
        async byName(name) {
          return store.templates.find((item) => item.name.trim().toLowerCase() === name.trim().toLowerCase()) ?? null
        },
      },
      editor: {
        async open() {
          return true
        },
        appendAtCursor: () => true,
      },
      nested: {
        async render() {
          return { ok: true, output: '', durationMs: 0 }
        },
        cancel: () => {},
      },
      indexCache: cache,
    }
  }

  it('answers two runs through one index, each about its own note', async () => {
    const rows = library()
    const made = note({ id: 'n-made', title: 'Made', content: '' })
    const builder = countingBuilder()
    const cache = createNoteIndexCache({ build: builder.build, version: () => libraryVersion(rows) })
    // The note the second run writes is in the store and not in the page's library list: the list is what the
    // version is taken from, and the run's own projection is what makes the note resolvable.
    const host = createPageHost(hostDeps({ ...rows, notes: [...rows.notes, made] }, cache))
    host.beginRun(snapshotOf(rows, { runId: 'run-library-note' }))
    host.beginRun(snapshotOf(rows, { runId: 'run-made-note', target: made, active: made }))

    const readLibrary = await host({ runId: 'run-library-note', callId: 'c1', method: 'note.read', args: ['notes/Target.md'] })
    const existsMade = await host({ runId: 'run-made-note', callId: 'c2', method: 'note.exists', args: ['notes/Made.md'] })
    const readMade = await host({ runId: 'run-made-note', callId: 'c3', method: 'note.read', args: ['notes/Made.md'] })
    const existsLibraryRow = await host({ runId: 'run-made-note', callId: 'c4', method: 'note.exists', args: ['archive/Other.md'] })
    const notForTheOtherRun = await host({ runId: 'run-library-note', callId: 'c5', method: 'note.exists', args: ['notes/Made.md'] })

    expect(readLibrary.ok && readLibrary.value).toEqual({ content: 'body of n-target' })
    expect(existsMade.ok && existsMade.value).toBe(true)
    expect(readMade.ok && readMade.value).toEqual({ content: '' })
    expect(existsLibraryRow.ok && existsLibraryRow.value).toBe(true)
    expect(notForTheOtherRun.ok && notForTheOtherRun.value).toBe(false)
    expect(builder.sizes).toHaveLength(1)
  })

  it('refuses the path two rows claim, through the cached index as through a fresh one', async () => {
    const rows = library()
    const cache = createNoteIndexCache({ version: () => libraryVersion(rows) })
    const twin = note({ id: 'n-twin', title: 'Target', content: 'a second row at one path' })
    const host = createPageHost(hostDeps({ ...rows, notes: [...rows.notes, twin] }, cache))
    host.beginRun(snapshotOf(rows, { runId: 'run-1', target: twin, active: twin }))

    const result = await host({ runId: 'run-1', callId: 'c1', method: 'note.write', args: ['notes/Target.md', 'text'] })

    expect(!result.ok && result.code).toBe('note-conflict')
  })

  it('answers a host that was given no cache at all exactly the same', async () => {
    // The other half of the seam: `PageHostDeps.indexCache` is optional, and a host built without one indexes
    // its own context per run, which is what every case above did before this cache existed. Same answers,
    // paid for again — the fallback is a slower correct one, never a different one.
    const rows = library()
    const cache = createNoteIndexCache({ version: () => libraryVersion(rows) })
    const made = note({ id: 'n-made', title: 'Made', content: '' })
    const twin = note({ id: 'n-twin', title: 'Target', content: 'a second row at one path' })
    const store = { ...rows, notes: [...rows.notes, made, twin] }
    const shared = createPageHost(hostDeps(store, cache))
    const plain = createPageHost({ ...hostDeps(store, cache), indexCache: undefined })

    const first = snapshotOf(rows, { runId: 'run-1', target: made, active: made })
    const second = snapshotOf(rows, { runId: 'run-2', target: twin, active: rows.notes[1] })
    for (const context of [first, second]) {
      shared.beginRun(context)
      plain.beginRun(context)
    }
    for (const [method, args] of [
      ['note.exists', ['notes/Made.md']],
      ['note.exists', ['archive/Other.md']],
      ['note.exists', ['Templates/Daily.md']],
      ['note.read', ['notes/Made.md']],
      ['note.write', ['notes/Target.md', 'text']],
      ['note.delete', ['archive/Other.md']],
    ] as const) {
      for (const runId of ['run-1', 'run-2']) {
        const asked = { runId, callId: 'c1', method, args: [...args] }
        expect(await plain(asked), `${runId} ${method} ${args}`).toEqual(await shared(asked))
      }
    }
    // One index for the two runs through the cache, two rebuilds through the plain path — the difference the
    // card is about, and the reason the answers above had to be compared before it was accepted.
    expect(cache.builds()).toBe(1)
  })
})

/** A library template row, projected onto the path the reader reads it through. */
function templateRow(id: string, name: string): NoteIndexEntry {
  return entry(id, `Templates/${name}.md`, { title: name, folderId: TEMPLATES_FOLDER_ID })
}
