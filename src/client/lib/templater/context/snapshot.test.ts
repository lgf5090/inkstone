import { describe, expect, it } from 'vitest'
import type { Folder, Note, NoteTemplate } from '@shared/types'
import { TEMPLATES_FOLDER_ID } from './file-wrapper'
import { buildRunSnapshot, folderPathsOf, noteIndexFor, type RunSnapshotInput } from './snapshot'

function note(overrides: Partial<Note> & { id: string }): Note {
  return {
    title: 'note',
    excerpt: '',
    folderId: null,
    tags: [],
    isPinned: false,
    isStarred: false,
    isArchived: false,
    wordCount: 0,
    charCount: 0,
    rev: 1,
    position: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    deletedAt: null,
    content: '',
    ...overrides,
  }
}

function folder(overrides: Partial<Folder> & { id: string; name: string }): Folder {
  return {
    parentId: null,
    icon: null,
    color: null,
    position: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

function template(overrides: Partial<NoteTemplate> & { id: string; name: string }): NoteTemplate {
  return {
    categoryId: null,
    description: '',
    content: '',
    builtin: false,
    isPinned: false,
    isStarred: false,
    tags: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

const NOTES = folder({ id: 'f-notes', name: 'notes' })
const SUB = folder({ id: 'f-sub', name: 'sub', parentId: 'f-notes' })

function snapshot(overrides: Partial<RunSnapshotInput> = {}): RunSnapshotInput {
  return {
    runId: 'run-1',
    notes: [
      note({ id: 'n1', title: 'note', folderId: 'f-sub', content: '---\ntags:\n- a\n- b\n---\nbody' }),
      note({ id: 'n2', title: 'root note', folderId: null }),
    ],
    folders: [NOTES, SUB],
    templates: [template({ id: 't1', name: 'Daily note', content: 'hello <% tp.file.title %>' })],
    target: note({ id: 'n1', title: 'note', folderId: 'f-sub', content: '---\ntags:\n- a\n- b\n---\nbody' }),
    active: null,
    template: template({ id: 't1', name: 'Daily note', content: 'hello <% tp.file.title %>' }),
    mode: 'overwrite-active',
    capabilities: 'local',
    locale: 'zh-CN',
    startedAt: 1_700_000_000_000,
    ...overrides,
  }
}

describe('snapshot purity', () => {
  // The boundary the whole package is built on: this directory turns rows into data and touches nothing
  // else. A store import here would make the run's view of the vault change while the run is going on.
  const ALLOWED = [
    '@shared/types',
    '@shared/markdown-utils',
    '@shared/constants',
    '../protocol',
    './file-wrapper',
    './note-index',
    './run-context',
    './snapshot',
    '../errors',
  ]

  // Read as source text, not as a module: the point is what these files *import*, which an ESM graph
  // would have resolved — and half of it would not even load outside a browser.
  const sources = import.meta.glob('./*.ts', { query: '?raw', import: 'default', eager: true }) as Record<
    string,
    string
  >

  it('imports only shared types, the wire contract and itself', () => {
    const modules = ['run-context.ts', 'snapshot.ts', 'note-index.ts', 'file-wrapper.ts']
    for (const name of modules) {
      const source = sources[`./${name}`]
      expect(source, `${name} was not read`).toBeTruthy()
      const specifiers = [...source!.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]!)
      expect(specifiers.length, `${name} declares no imports`).toBeGreaterThan(0)
      for (const specifier of specifiers) {
        expect(ALLOWED, `${name} imports ${specifier}`).toContain(specifier)
      }
    }
  })
})

describe('snapshot shape', () => {
  it('returns exactly the fields the wire contract declares', () => {
    const context = buildRunSnapshot(snapshot())
    expect(Object.keys(context).sort()).toEqual([
      'active',
      'capabilities',
      'folders',
      'frozenTitle',
      'index',
      'libraryTemplates',
      'locale',
      'mode',
      'runId',
      'startedAt',
      'target',
      'template',
    ])
    expect(context.runId).toBe('run-1')
    expect(context.mode).toBe('overwrite-active')
    expect(context.capabilities).toBe('local')
    expect(context.locale).toBe('zh-CN')
    expect(context.startedAt).toBe(1_700_000_000_000)
    expect(context.template).toEqual({ id: 't1', name: 'Daily note', content: 'hello <% tp.file.title %>' })
  })

  it('is what a structured clone can carry: a JSON round trip changes nothing', () => {
    const context = buildRunSnapshot(snapshot())
    expect(JSON.parse(JSON.stringify(context))).toEqual(context)
  })

  it('projects notes, folders and templates onto the paths the API expects', () => {
    const context = buildRunSnapshot(snapshot())
    const byPath = new Map(context.index.map((item) => [item.path, item]))
    expect(byPath.get('notes/sub/note.md')?.id).toBe('n1')
    expect(byPath.get('root note.md')?.id).toBe('n2')
    expect(byPath.get('Templates/Daily note.md')?.id).toBe('t1')
    expect(byPath.get('Templates/Daily note.md')?.folderId).toBe(TEMPLATES_FOLDER_ID)
    const folders = new Map(context.folders.map((item) => [item.path, item]))
    expect(folders.get('notes')?.id).toBe('f-notes')
    expect(folders.get('notes/sub')?.id).toBe('f-sub')
    expect(folders.get('Templates')?.id).toBe(TEMPLATES_FOLDER_ID)
  })

  it('indexes the target, the active note and the applied template even when the lists have not caught up', () => {
    // A note created one frame before the run and a gallery template that is not in the reader's
    // library must both still answer `tp.file.exists`, or the template cannot name the file it writes.
    const context = buildRunSnapshot(snapshot({
      notes: [],
      templates: [],
      active: note({ id: 'n9', title: 'fresh', folderId: 'f-notes' }),
    }))
    const paths = context.index.map((item) => item.path)
    expect(paths).toContain('notes/sub/note.md')
    expect(paths).toContain('notes/fresh.md')
    expect(paths).toContain('Templates/Daily note.md')
    expect(context.libraryTemplates).toEqual([])
  })

  it('does not alias the rows it was handed', () => {
    const input = snapshot()
    const context = buildRunSnapshot(input)
    const before = JSON.stringify(context.libraryTemplates)
    input.templates[0]!.name = 'renamed'
    input.templates[0]!.tags.push('leaked')
    expect(JSON.stringify(context.libraryTemplates)).toBe(before)
  })

  it('resolves the target ref from the note it was given, tags and frontmatter included', () => {
    const context = buildRunSnapshot(snapshot())
    expect(context.target?.id).toBe('n1')
    expect(context.target?.tagNames).toEqual(['a', 'b'])
    expect(context.target?.frontmatter).toEqual({ tags: ['a', 'b'] })
    expect(context.active).toBeNull()
  })

  it('reports a folder two rows share rather than choosing a tree silently', () => {
    const context = buildRunSnapshot(snapshot({ folders: [NOTES, folder({ id: 'f-notes-2', name: 'notes' })] }))
    const index = noteIndexFor(context)
    expect(index.ambiguities()).toEqual([{ kind: 'folder', path: 'notes', ids: ['f-notes', 'f-notes-2'] }])
  })
})

describe('folder tree projection', () => {
  it('gives the root no path and joins ancestors with a slash', () => {
    const paths = folderPathsOf([NOTES, SUB, folder({ id: 'f-deep', name: 'deep', parentId: 'f-sub' })])
    expect(paths.get('f-notes')).toBe('notes')
    expect(paths.get('f-sub')).toBe('notes/sub')
    expect(paths.get('f-deep')).toBe('notes/sub/deep')
  })

  it('stops at a parent that is not in the list instead of looping', () => {
    const paths = folderPathsOf([
      folder({ id: 'a', name: 'a', parentId: 'b' }),
      folder({ id: 'b', name: 'b', parentId: 'a' }),
      folder({ id: 'orphan', name: 'orphan', parentId: 'missing' }),
    ])
    expect(paths.get('orphan')).toBe('orphan')
    // A cycle is corrupt data; it must produce a path and a finite run, not a hang.
    expect(paths.get('a')).toBeTypeOf('string')
    expect(paths.get('b')).toBeTypeOf('string')
  })

  it('rebuilds the same lookups from a context alone', () => {
    const context = buildRunSnapshot(snapshot())
    const index = noteIndexFor(context)
    expect(index.findByLinkpath('note')?.path).toBe('notes/sub/note.md')
    expect(index.getTemplateByName('Daily note')?.path).toBe('Templates/Daily note.md')
    expect(index.allTemplates().map((item) => item.id)).toEqual(['t1'])
    expect(index.allNotes().map((item) => item.id)).toEqual(['n1', 'n2'])
  })
})

describe('snapshot cost', () => {
  it('takes a realistic 20,000-note library in one linear pass', () => {
    const folders: Folder[] = []
    const notes: Note[] = []
    for (let index = 0; index < 40; index++) {
      folders.push(folder({ id: `f${index}`, name: `folder-${index}` }))
    }
    for (let index = 0; index < 20_000; index++) {
      const parent = folders[index % folders.length]!
      notes.push(note({ id: `n${index}`, title: `Note ${index}`, folderId: parent.id, content: `body ${index}` }))
    }
    const input = snapshot({ notes, folders, target: notes[0], active: notes[1] })

    const started = performance.now()
    const context = buildRunSnapshot(input)
    const elapsed = performance.now() - started

    console.info(`templater snapshot: 20,000 notes projected and indexed in ${elapsed.toFixed(1)} ms`)
    expect(context.index.length).toBe(20_001)
    expect(elapsed).toBeLessThan(3_000)
  })
})
