import { describe, expect, it } from 'vitest'
import type { Folder, Note, NoteTemplate } from '@shared/types'
import {
  epochMillis,
  folderIndexEntry,
  frontmatterErrors,
  frontmatterValues,
  joinVirtualPath,
  noteIndexEntry,
  runNoteRef,
  tagNamesOf,
  templateIndexEntry,
  templateRunRef,
  virtualBasename,
  virtualFolderSegment,
  virtualNotePath,
  virtualTemplatePath,
} from './file-wrapper'

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
    updatedAt: 1_700_000_060_000,
    deletedAt: null,
    content: '',
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

describe('virtual path projection', () => {
  it('puts a note at the root without a leading slash', () => {
    // Upstream: `folder()` is `''` for a root file (`file.e2e.ts:151`) and `path(true)` is the vault
    // path with no prefix (`file.e2e.ts:187`), so the root contributes nothing to either.
    expect(virtualNotePath('', 'note')).toBe('note.md')
    expect(joinVirtualPath('', 'note.md')).toBe('note.md')
  })

  it('joins folder segments with a slash and appends the extension', () => {
    expect(virtualNotePath('notes/sub', 'note')).toBe('notes/sub/note.md')
  })

  it('takes the characters a file name cannot hold out of a title', () => {
    expect(virtualBasename('A/B')).toBe('A-B')
    expect(virtualBasename('C:\\Users')).toBe('C-Users')
    expect(virtualBasename('a:b')).toBe('a-b')
    expect(virtualBasename('  spaced  ')).toBe('spaced')
    expect(virtualBasename('tab\there')).toBe('tab here')
  })

  it('names a note with no usable title the way the app names a new one', () => {
    expect(virtualNotePath('', '')).toBe('Untitled.md')
    expect(virtualNotePath('', '   ')).toBe('Untitled.md')
    // The two names that mean "somewhere else" to a path reader.
    expect(virtualNotePath('notes', '.')).toBe('notes/Untitled.md')
    expect(virtualNotePath('notes', '..')).toBe('notes/Untitled.md')
  })

  it('does not double an extension a title already carries', () => {
    // Obsidian reads `Guide.md` as the file `Guide.md` with basename `Guide`, and a template writing
    // `[[Guide.md]]` has to reach it.
    expect(virtualNotePath('notes', 'Guide.md')).toBe('notes/Guide.md')
    expect(virtualNotePath('notes', 'Guide.MD')).toBe('notes/Guide.md')
  })

  it('sanitises a folder name for the path but keeps the name a folder reports', () => {
    expect(virtualFolderSegment('a/b')).toBe('a-b')
    expect(virtualFolderSegment('Notes.md')).toBe('Notes.md')
    expect(virtualFolderSegment('')).toBe('Untitled')
    expect(folderIndexEntry(folder({ id: 'f1', name: 'a/b' }), 'a-b').name).toBe('a/b')
  })

  it('projects library templates onto the templates folder', () => {
    expect(virtualTemplatePath('Daily note')).toBe('Templates/Daily note.md')
    expect(virtualTemplatePath('daily.md')).toBe('Templates/daily.md')
    expect(virtualTemplatePath('')).toBe('Templates/Untitled.md')
  })
})

describe('index entries', () => {
  it('carries exactly the fields the protocol declares', () => {
    const entry = noteIndexEntry(note({ id: 'n1', title: 'Meeting', folderId: 'f1' }), 'notes/Meeting.md')
    expect(Object.keys(entry).sort()).toEqual(['createdAt', 'folderId', 'id', 'path', 'title', 'updatedAt'])
    expect(typeof entry.createdAt).toBe('number')
  })

  it('gives a template a folder id no real folder can have', () => {
    const entry = templateIndexEntry(template({ id: 't1', name: 'Daily note' }), 'Templates/Daily note.md')
    expect(entry.folderId).toBe('templater:templates')
    expect(entry.title).toBe('Daily note')
  })

  it('reads a missing timestamp as no timestamp rather than as today', () => {
    // Epoch 0 formats as 1970-01-01, which a reader can see is wrong; a fallback to `Date.now()` would
    // look plausible and be invented.
    expect(epochMillis(undefined)).toBe(0)
    expect(epochMillis(Number.NaN)).toBe(0)
    expect(epochMillis(1_700_000_000_000)).toBe(1_700_000_000_000)
  })
})

describe('note refs', () => {
  it('parses frontmatter into values, not into the raw block', () => {
    const ref = runNoteRef(note({ id: 'n1', content: '---\nname: Alice\n---\nbody' }))
    expect(ref.frontmatter).toEqual({ name: 'Alice' })
    expect(ref.content).toBe('---\nname: Alice\n---\nbody')
  })

  it('handles a note with no frontmatter and an empty block', () => {
    expect(runNoteRef(note({ id: 'n1', content: 'just body\n' })).frontmatter).toEqual({})
    expect(frontmatterValues('---\n---\nbody')).toEqual({})
    expect(frontmatterErrors('---\n---\nbody')).toEqual([])
  })

  it('keeps a YAML list as a list and a scalar as a scalar', () => {
    // `tp.frontmatter.items` renders a list as `a,b,c` upstream, which needs the array, not the text.
    expect(frontmatterValues('---\nitems:\n- a\n- b\n---\n')).toEqual({ items: ['a', 'b'] })
    expect(frontmatterValues('---\nitems: [a, b]\npriority: 42\nflag: true\n---\n')).toEqual({
      items: ['a', 'b'],
      priority: 42,
      flag: true,
    })
  })

  it('keeps a null key and does not invent a missing one', () => {
    const data = frontmatterValues('---\narchived:\nname: Bob\n---\n')
    expect(data).toEqual({ archived: null, name: 'Bob' })
    expect('missing' in data).toBe(false)
  })

  it('treats a leading rule that is not a block as body, not as broken frontmatter', () => {
    const content = '---\nJust prose that never closes\n'
    expect(frontmatterValues(content)).toEqual({})
    expect(frontmatterErrors(content)).toEqual([])
  })

  it('reports why a closed block parsed to nothing', () => {
    const content = '---\nbad: [unclosed\n---\nbody'
    expect(frontmatterValues(content)).toEqual({})
    expect(frontmatterErrors(content).length).toBeGreaterThan(0)
    // A YAML list at the root is not a mapping, so there are no keys to hand a template.
    expect(frontmatterValues('---\n- a\n- b\n---\n')).toEqual({})
    expect(frontmatterErrors('---\n- a\n- b\n---\n').length).toBeGreaterThan(0)
  })

  it('turns a tagged YAML date into text, never into a host Date', () => {
    // `yaml` leaves an untagged `2024-05-01` as text and turns `!!timestamp` into a `Date`; the second
    // is the one that would otherwise cross the worker boundary as another realm's object.
    const untagged = frontmatterValues('---\nday: 2024-05-01\n---\n')
    expect(untagged.day).toBe('2024-05-01')
    const tagged = frontmatterValues('---\nday: !!timestamp 2024-05-01\nstamp: !!timestamp 2024-05-01T07:30:00Z\n---\n')
    expect(tagged.day).toBe('2024-05-01')
    expect(tagged.stamp).toBe('2024-05-01T07:30:00.000Z')
    expect(tagged.stamp instanceof Date).toBe(false)
  })

  it('keeps a binary tag visible instead of letting a class instance through', () => {
    const data = frontmatterValues('---\nblob: !!binary aGVsbG8=\n---\n')
    expect(typeof data.blob).toBe('string')
    expect(JSON.parse(JSON.stringify(data))).toEqual(data)
  })

  it('holds no class instance, so a structured clone is a round trip', () => {
    const ref = runNoteRef(note({
      id: 'n1',
      title: 'Meeting',
      content: '---\nday: 2024-05-01\nnested:\n  list:\n  - 1\n---\ntext #work',
    }))
    expect(JSON.parse(JSON.stringify(ref))).toEqual(ref)
    expect(ref.frontmatter.nested).toEqual({ list: [1] })
  })

  it('names tags without the hash and reports an empty note as empty', () => {
    const ref = runNoteRef(note({ id: 'n1', content: '---\ntags:\n- tag1\n- tag2\n---\nbody' }))
    expect(ref.tagNames).toEqual(['tag1', 'tag2'])
    expect(ref.isEmpty).toBe(false)
    expect(runNoteRef(note({ id: 'n2', content: '\n' })).isEmpty).toBe(true)
    expect(runNoteRef(note({ id: 'n3', content: '   ' })).isEmpty).toBe(true)
  })

  it('reads body tags the same way a note listing does', () => {
    expect(tagNamesOf('see #work/meeting and #idea')).toEqual(['idea', 'work/meeting'])
  })

  it('reads a library template as a file, so its gallery labels are not its tags', () => {
    const ref = templateRunRef(template({ id: 't1', name: 'Recipe', tags: ['dinner'], content: 'made with #cooking' }))
    expect(ref.tagNames).toEqual(['cooking'])
    expect(ref.folderId).toBe('templater:templates')
    expect(ref.content).toBe('made with #cooking')
  })
})
