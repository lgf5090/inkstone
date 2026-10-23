import { describe, expect, it } from 'vitest'
import type { FolderIndexEntry, NoteIndexEntry } from '../protocol'
import { TEMPLATES_FOLDER_ID } from './file-wrapper'
import {
  buildNoteIndex,
  normalizeVirtualPath,
  parseLinkText,
  parseWikiLinkText,
  stripMarkdownExtension,
  type NoteIndex,
} from './note-index'

const ROOT: FolderIndexEntry = { id: 'f-root', name: 'notes', parentId: null, path: 'notes' }
const SUB: FolderIndexEntry = { id: 'f-sub', name: 'sub', parentId: 'f-root', path: 'notes/sub' }
const TEMPLATES: FolderIndexEntry = {
  id: TEMPLATES_FOLDER_ID,
  name: 'Templates',
  parentId: null,
  path: 'Templates',
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

function inFolder(id: string, folder: FolderIndexEntry, title: string): NoteIndexEntry {
  return entry(id, `${folder.path}/${title}.md`, { folderId: folder.id, title })
}

function index(notes: NoteIndexEntry[], templates: NoteIndexEntry[] = []): NoteIndex {
  return buildNoteIndex({ notes, templates, folders: [ROOT, SUB, TEMPLATES] })
}

describe('path normalisation', () => {
  it('folds the shapes a template can type into one form', () => {
    expect(normalizeVirtualPath('  /notes//sub/note.md  ')).toBe('notes/sub/note.md')
    expect(normalizeVirtualPath('notes\\sub\\note.md')).toBe('notes/sub/note.md')
    expect(normalizeVirtualPath('note.md/')).toBe('note.md')
    expect(stripMarkdownExtension('Notes/Meeting.md')).toBe('Notes/Meeting')
    expect(stripMarkdownExtension('Notes/Meeting')).toBe('Notes/Meeting')
  })
})

describe('exact path lookup', () => {
  const notes = [
    inFolder('n1', ROOT, 'note'),
    inFolder('n2', SUB, 'note'),
    entry('n3', 'exists.md'),
  ]

  it('matches a whole path, extension included', () => {
    expect(index(notes).getByPath('notes/note.md')?.id).toBe('n1')
    expect(index(notes).getByPath('/notes/note.md')?.id).toBe('n1')
  })

  it('does not match a path that is missing its extension', () => {
    // Upstream: `tp.file.exists("exists")` is false for `exists.md` (`file.e2e.ts:478`).
    expect(index(notes).existsPath('exists')).toBe(false)
    expect(index(notes).existsPath('exists.md')).toBe(true)
  })

  it('does not match a basename where a full path is required', () => {
    // Upstream: `tp.file.exists("exists.md")` is false when the file sits in `notes/` (`file.e2e.ts:463`).
    const nested = index([entry('n4', 'notes/exists.md')])
    expect(nested.existsPath('exists.md')).toBe(false)
    expect(nested.existsPath('notes/exists.md')).toBe(true)
  })

  it('is case-sensitive, because a virtual path is something the reader types back', () => {
    expect(index(notes).existsPath('Notes/Note.md')).toBe(false)
    expect(index(notes).findByLinkpath('Notes/Note')?.id).toBe('n1')
  })

  it('answers null and an empty match list for a path that is not there', () => {
    const resolution = index(notes).resolvePath('notes/ghost.md')
    expect(resolution.entry).toBeNull()
    expect(resolution.matches).toEqual([])
    expect(resolution.ambiguous).toBe(false)
  })
})

describe('link text lookup', () => {
  const notes = [
    inFolder('n1', ROOT, 'findme'),
    inFolder('n2', SUB, 'deep'),
    entry('n3', 'other.md'),
  ]
  const templates = [entry('t1', 'Templates/findme.md', { folderId: TEMPLATES_FOLDER_ID, title: 'findme' })]

  it('resolves a bare name, as `tp.file.find_tfile` does', () => {
    // Upstream: `find_tfile("findme").path` is `notes/findme.md` (`file.e2e.ts:512`).
    expect(index(notes, templates).findByLinkpath('findme')?.path).toBe('notes/findme.md')
  })

  it('resolves a folder-qualified name with and without the extension', () => {
    // Upstream: `find_tfile("notes/findme").path` is the same file (`file.e2e.ts:530`).
    const built = index(notes, templates)
    expect(built.findByLinkpath('notes/findme')?.path).toBe('notes/findme.md')
    expect(built.findByLinkpath('notes/findme.md')?.path).toBe('notes/findme.md')
  })

  it('resolves a folder suffix the reader did not spell out in full', () => {
    expect(index(notes).findByLinkpath('sub/deep')?.path).toBe('notes/sub/deep.md')
  })

  it('answers null for a name nothing has', () => {
    // Upstream: `find_tfile("nonexistent")` prints `null` (`file.e2e.ts:548`); nothing is invented.
    expect(index(notes).findByLinkpath('nonexistent')).toBeNull()
    expect(index(notes).findByLinkpath('')).toBeNull()
  })

  it('prefers a note over a library template at the same name', () => {
    // The plan's D4 rule: find the note first, the template folder is the fallback.
    expect(index(notes, templates).findByLinkpath('findme')?.id).toBe('n1')
    expect(index([], templates).findByLinkpath('findme')?.id).toBe('t1')
  })

  it('prefers the candidate closest to the note the link is written in', () => {
    // `createdAt` is set apart so the no-source answer is the rule, not the accident of an id order.
    const near = entry('a', 'notes/note.md', { folderId: 'f-root', title: 'note', createdAt: 1_700_000_000_001 })
    const deeper = entry('b', 'notes/sub/note.md', { folderId: 'f-sub', title: 'note', createdAt: 1_700_000_000_002 })
    const atRoot = entry('c', 'note.md', { createdAt: 1_600_000_000_000 })
    const built = index([near, deeper, atRoot])
    expect(built.findByLinkpath('note', 'notes/elsewhere.md')?.id).toBe('a')
    expect(built.findByLinkpath('note', 'notes/sub/elsewhere.md')?.id).toBe('b')
    // With no source — what `find_tfile` passes upstream — nothing is closest, so creation time decides.
    expect(built.findByLinkpath('note')?.id).toBe('c')
  })

  it('lists every candidate a collision puts in play', () => {
    const built = index([inFolder('a', ROOT, 'note'), inFolder('b', ROOT, 'note')])
    const resolution = built.resolvePath('notes/note.md')
    expect(resolution.ambiguous).toBe(true)
    expect(resolution.matches.map((item) => item.id)).toEqual(['a', 'b'])
    expect(resolution.entry?.id).toBe('a')
  })

  it('names a template by the name the gallery shows, with or without the extension', () => {
    const built = index([], [entry('t2', 'Templates/Daily note.md', { folderId: TEMPLATES_FOLDER_ID, title: 'Daily note' })])
    expect(built.getTemplateByName('Daily note')?.id).toBe('t2')
    expect(built.getTemplateByName('Daily note.md')?.id).toBe('t2')
    expect(built.getTemplateByName('daily NOTE')?.id).toBe('t2')
    expect(built.getTemplateByName('nope')).toBeNull()
  })
})

describe('duplicate paths', () => {
  const first = entry('bbb', 'same.md', { title: 'same', createdAt: 1_600_000_000_000 })
  const second = entry('aaa', 'same.md', { title: 'same', createdAt: 1_600_000_000_000 })

  it('picks the earliest created, then the lower id, and never the list order', () => {
    const a = index([first, second])
    const b = index([second, first])
    expect(a.resolvePath('same.md').entry?.id).toBe('aaa')
    expect(b.resolvePath('same.md').entry?.id).toBe('aaa')
    expect(a.entries.length).toBe(2)
  })

  it('reports the collision instead of hiding the choice', () => {
    expect(index([first, second]).ambiguities()).toEqual([
      { kind: 'file', path: 'same.md', ids: ['aaa', 'bbb'] },
    ])
  })

  it('reports a folder two rows claim, and a folder id the page never loaded', () => {
    const duplicated = buildNoteIndex({
      notes: [entry('n1', 'x.md', { folderId: 'f1' })],
      folders: [
        { id: 'f1', name: 'a', parentId: null, path: 'dup' },
        { id: 'f2', name: 'a', parentId: null, path: 'dup' },
      ],
    })
    expect(duplicated.ambiguities()).toEqual([{ kind: 'folder', path: 'dup', ids: ['f1', 'f2'] }])
    expect(duplicated.unresolvedFolderIds()).toEqual([])

    const missing = buildNoteIndex({ notes: [entry('n1', 'x.md', { folderId: 'gone' })], folders: [] })
    expect(missing.unresolvedFolderIds()).toEqual(['gone'])
    expect(missing.getFolderById('gone')).toBeNull()
    // A root note and a template have no folder row to be missing.
    expect(index([entry('n2', 'plain.md'), entry('t9', 'Templates/t.md', { folderId: TEMPLATES_FOLDER_ID })]).unresolvedFolderIds()).toEqual([])
  })

  it('indexes a row listed twice only once', () => {
    const built = index([first, first])
    expect(built.entries.length).toBe(1)
    expect(built.ambiguities()).toEqual([])
  })
})

describe('link text parsing', () => {
  it('splits the anchor at the first hash and the alias at the first pipe', () => {
    expect(parseLinkText('notes/note')).toEqual({ linkpath: 'notes/note', subpath: null, alias: null })
    expect(parseLinkText('note#Section 1')).toEqual({ linkpath: 'note', subpath: { kind: 'heading', heading: 'Section 1' }, alias: null })
    expect(parseLinkText('note#Parent/Child')).toEqual({
      linkpath: 'note',
      subpath: { kind: 'heading', heading: 'Parent/Child' },
      alias: null,
    })
    expect(parseLinkText('note#^block-id')).toEqual({ linkpath: 'note', subpath: { kind: 'block', blockId: 'block-id' }, alias: null })
    expect(parseLinkText('note|display')).toEqual({ linkpath: 'note', subpath: null, alias: 'display' })
    expect(parseLinkText('note#Heading|display')).toEqual({
      linkpath: 'note',
      subpath: { kind: 'heading', heading: 'Heading' },
      alias: 'display',
    })
  })

  it('drops an anchor that names nothing', () => {
    expect(parseLinkText('note#').linkpath).toBe('note')
    expect(parseLinkText('note#').subpath).toBeNull()
    expect(parseLinkText('note#^').subpath).toBeNull()
  })

  it('reads a title containing a hash the way the app link parser does', () => {
    // `wikiNoteTarget` in `@shared/markdown-utils` has the same rule, so the backlinks panel and a
    // template agree that `C# language` is a link to `C` with an anchor, not a note. As a path it is
    // still exactly where the reader put it.
    const built = index([entry('n1', 'C# language.md')])
    expect(parseLinkText('C# language').linkpath).toBe('C')
    expect(built.resolveWikiLink('[[C# language]]')?.entry).toBeNull()
    expect(built.resolveWikiLink('[[C# language]]')?.subpath).toEqual({ kind: 'heading', heading: 'language' })
    expect(built.getByPath('C# language.md')?.id).toBe('n1')
    expect(built.findByLinkpath('C# language')?.id).toBe('n1')
  })

  it('accepts only the bracketed link form', () => {
    expect(parseWikiLinkText('[[note#Heading]]')?.linkpath).toBe('note')
    expect(parseWikiLinkText('note')).toBeNull()
    expect(parseWikiLinkText('![[note]]')).toBeNull()
    expect(parseWikiLinkText('[[note]] extra')).toBeNull()
  })
})

describe('sub-path resolution', () => {
  it('finds the note and hands the anchor back unresolved', () => {
    const built = index([inFolder('n1', ROOT, 'section-source')])
    const resolved = built.resolveWikiLink('[[notes/section-source#Section1]]')
    expect(resolved?.entry?.path).toBe('notes/section-source.md')
    expect(resolved?.subpath).toEqual({ kind: 'heading', heading: 'Section1' })
    // The literal type is the promise: the body is not here, so nothing was sliced.
    expect(resolved?.subpathResolved).toBe(false)
  })

  it('resolves a block anchor to the note that holds it', () => {
    const built = index([inFolder('n1', ROOT, 'source')])
    const resolved = built.resolveWikiLink('[[source#^block-id]]')
    expect(resolved?.entry?.id).toBe('n1')
    expect(resolved?.subpath).toEqual({ kind: 'block', blockId: 'block-id' })
  })

  it('marks a link with no note part as the current note', () => {
    const resolved = index([entry('n1', 'other.md')]).resolveWikiLink('[[#Section]]')
    expect(resolved?.entry).toBeNull()
    expect(resolved?.selfReference).toBe(true)
    expect(resolved?.subpath).toEqual({ kind: 'heading', heading: 'Section' })
  })

  it('reports a missing link as missing, anchor and all', () => {
    const resolved = index([]).resolveWikiLink('[[ghost#Section]]')
    expect(resolved?.entry).toBeNull()
    expect(resolved?.ambiguous).toBe(false)
    expect(resolved?.subpath?.kind).toBe('heading')
  })
})

describe('listing', () => {
  it('keeps notes and templates apart, and the shipped list as notes then templates', () => {
    const built = index([entry('n1', 'a.md')], [entry('t1', 'Templates/b.md', { folderId: TEMPLATES_FOLDER_ID })])
    expect(built.allNotes().map((item) => item.id)).toEqual(['n1'])
    expect(built.allTemplates().map((item) => item.id)).toEqual(['t1'])
    expect(built.entries.map((item) => item.id)).toEqual(['n1', 't1'])
    expect(built.getById('t1')?.path).toBe('Templates/b.md')
    expect(built.getById('nope')).toBeNull()
  })

  it('finds a folder by id and by path', () => {
    const built = index([])
    expect(built.getFolderById('f-sub')?.name).toBe('sub')
    expect(built.getFolderByPath('notes/sub')?.id).toBe('f-sub')
    expect(built.getFolderByPath('Templates')?.id).toBe(TEMPLATES_FOLDER_ID)
    expect(built.getFolderByPath('notes/ghost')).toBeNull()
  })
})

describe('index cost', () => {
  it('builds a 20,000-note index in a single pass', () => {
    // Generated, not committed: the fixture is three lines and the number it produces is the point.
    const notes: NoteIndexEntry[] = []
    const folders: FolderIndexEntry[] = []
    for (let folder = 0; folder < 50; folder++) {
      folders.push({ id: `f${folder}`, name: `folder-${folder}`, parentId: null, path: `folder-${folder}` })
    }
    for (let index = 0; index < 20_000; index++) {
      const folder = folders[index % folders.length]!
      notes.push({
        id: `n${index}`,
        title: `Note ${index}`,
        folderId: folder.id,
        path: `${folder.path}/Note ${index}.md`,
        createdAt: 1_700_000_000_000 + index,
        updatedAt: 1_700_000_000_000 + index,
      })
    }

    const started = performance.now()
    const built = buildNoteIndex({ notes, templates: [], folders })
    const elapsed = performance.now() - started

    // The evidence line this test exists to produce; the bound is loose enough for a busy machine and
    // tight enough that a quadratic rebuild would break it.
    console.info(`templater note-index: built ${built.entries.length} entries in ${elapsed.toFixed(1)} ms`)
    expect(built.entries.length).toBe(20_000)
    expect(elapsed).toBeLessThan(1_000)
    expect(built.findByLinkpath('Note 19999')?.id).toBe('n19999')
    expect(built.getByPath('folder-0/Note 0.md')?.id).toBe('n0')
  })
})
