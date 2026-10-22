import { describe, expect, it } from 'vitest'
import type { HostCall, HostResult, RunRequest, TemplateRunContext, WorkerMessage } from '../protocol'
import { TemplateRun } from './vm'
import { DEFAULT_RUN_DEADLINE_MS } from '../limits'

/**
 * The `tp.app` / `tp.obsidian` compatibility facade, run through the real interpreter.
 *
 * The harness is `./vm.test.ts`'s: a QuickJS context built by `TemplateRun`, a scripted page that answers
 * the calls the run posts, and assertions read off the text the program left in `tR`. That shape is the
 * point — the facade's whole job is to hand back objects whose prototype chains are the interpreter's own
 * (`instanceof tp.obsidian.TFolder`), which a fake namespace could not show, and to reach the page through
 * the calls the capability gate already governs, which a unit test of the object alone would not exercise.
 *
 * The rows are the plan's A1 to A7 (`reports/templater-port-plan.md`, §5.7).
 */

/** The target note's body: one heading, one link, one embed, and a fenced block that is neither. */
const TARGET_BODY = '# Heading one\n\nText with [[Other]] and ![[Cover]] and more.\n\n```text\n# not a heading\n```\n'

/** The note the run found open in the editor, and the third note in the tree. */
const ACTIVE_BODY = 'the open note'

type Reply = { value?: unknown } | { code: string; detail?: string }

function context(overrides: Partial<TemplateRunContext> = {}): TemplateRunContext {
  return {
    runId: 'run-1',
    mode: 'append-active',
    capabilities: 'local',
    template: { id: 'tpl-1', name: 'Idea', content: 'from the library' },
    startedAt: Date.parse('2026-01-01T00:00:00Z'),
    target: {
      id: 'note-1',
      title: 'Target',
      content: TARGET_BODY,
      folderId: 'folder-1',
      tagNames: ['reading'],
      frontmatter: { level: 3 },
      createdAt: Date.parse('2026-01-01T00:00:00Z'),
      updatedAt: Date.parse('2026-01-02T00:00:00Z'),
      isEmpty: false,
    },
    active: {
      id: 'note-2',
      title: 'Other',
      content: ACTIVE_BODY,
      folderId: null,
      tagNames: [],
      frontmatter: {},
      createdAt: Date.parse('2026-01-01T00:00:00Z'),
      updatedAt: Date.parse('2026-01-02T00:00:00Z'),
      isEmpty: false,
    },
    frozenTitle: 'Target',
    index: [
      { id: 'note-1', title: 'Target', folderId: 'folder-1', path: 'Reading/Target.md', updatedAt: 2, createdAt: 1 },
      { id: 'note-2', title: 'Other', folderId: null, path: 'Other.md', updatedAt: 2, createdAt: 1 },
      { id: 'note-3', title: 'Old Note', folderId: 'folder-2', path: 'Archive/Old Note.md', updatedAt: 2, createdAt: 1 },
    ],
    folders: [
      { id: 'folder-1', name: 'Reading', parentId: null, path: 'Reading' },
      { id: 'folder-2', name: 'Archive', parentId: null, path: 'Archive' },
    ],
    libraryTemplates: [{ id: 'tpl-1', name: 'Idea', content: 'from the library' } as never],
    locale: 'en-US',
    selection: 'the picked text',
    userScripts: [],
    ...overrides,
  }
}

interface Seen {
  output: string | null
  failure: { code: string; detail?: string } | null
  calls: HostCall[]
}

/**
 * Start the run, answer every call the page would answer, and read the outcome.
 *
 * `deliver` settles the interpreter's promise and pumps its job queue synchronously, which is why this can
 * be a loop rather than a race: a call is answered as soon as it appears, and the run finishes in the same
 * turn it was started in.
 */
async function render(
  source: string,
  reply: (call: HostCall) => Reply = () => ({ value: null }),
  overrides: Partial<TemplateRunContext> = {},
): Promise<Seen> {
  const messages: WorkerMessage[] = []
  const request: RunRequest = {
    kind: 'run',
    runId: 'run-1',
    context: context(overrides),
    source: `(async () => {\n  let tR = ''\n  ${source}\n  return tR\n})()`,
    deadlineMs: DEFAULT_RUN_DEADLINE_MS,
  }
  const run = await TemplateRun.open(request, (message) => messages.push(message))
  run.start()
  const calls: HostCall[] = []
  let answered = 0
  for (let guard = 0; guard < 400; guard += 1) {
    calls.length = 0
    for (const message of messages) {
      if (message.kind === 'host-call') calls.push(message.call)
    }
    while (answered < calls.length) {
      const call = calls[answered]
      const given = reply(call)
      const result: HostResult = 'code' in given
        ? { runId: 'run-1', callId: call.callId, ok: false, code: given.code, detail: given.detail }
        : { runId: 'run-1', callId: call.callId, ok: true, value: given.value }
      run.deliver(result)
      answered += 1
    }
    if (run.currentState === 'finished') break
  }
  const done = messages.find((message) => message.kind === 'done')
  const failed = messages.find((message) => message.kind === 'failed')
  return {
    output: done && done.kind === 'done' ? done.output : null,
    failure: failed && failed.kind === 'failed' ? { code: failed.code, detail: failed.detail } : null,
    calls,
  }
}

/** Answer one page method and ignore the rest, for a body that only makes that call. */
function answered(method: string, value: unknown): (call: HostCall) => Reply {
  return (call) => (call.method === method ? { value } : { value: null })
}

/** Answer one page method with the refusal the page would send, so the code travels unchanged. */
function refused(method: string, code: string, detail: string): (call: HostCall) => Reply {
  return (call) => (call.method === method ? { code, detail } : { value: null })
}

describe('tp.app.vault', () => {
  it('reads a note through the page and answers its text', async () => {
    const seen = await render('tR += await tp.app.vault.read(tp.config.target_file)', answered('note.read', { content: 'the body' }))
    expect(seen.output).toBe('the body')
    expect(seen.calls.map((call) => call.method)).toEqual(['note.read'])
    expect(seen.calls[0].args).toEqual(['Reading/Target.md'])
  })

  it('takes a path where Obsidian takes a file', async () => {
    const seen = await render("tR += await tp.app.vault.read('Archive/Old Note.md')", answered('note.read', { content: 'filed away' }))
    expect(seen.output).toBe('filed away')
    expect(seen.calls[0].args).toEqual(['Archive/Old Note.md'])
  })

  it('names the member when the argument cannot be a note', async () => {
    const seen = await render('await tp.app.vault.read(42)')
    expect(seen.failure).toMatchObject({ code: 'path-invalid', detail: 'tp.app.vault.read' })
  })

  it('answers a cached read of a note the run carries without leaving the interpreter', async () => {
    const seen = await render('tR += await tp.app.vault.cachedRead(tp.config.target_file)')
    expect(seen.output).toBe(TARGET_BODY)
    expect(seen.calls).toEqual([])
    // A note the snapshot does not carry is still a read, and the page is asked for it.
    const other = await render('tR += await tp.app.vault.cachedRead(tp.file.find_tfile("Old Note"))', answered('note.read', { content: 'filed away' }))
    expect(other.output).toBe('filed away')
    expect(other.calls.map((call) => call.method)).toEqual(['note.read'])
  })

  it('creates through the page and keeps the new note addressable', async () => {
    const created = { id: 'note-7', title: 'Fresh', folderId: null, path: 'Fresh.md', updatedAt: 5, createdAt: 4 }
    const seen = await render(`
  const made = await tp.app.vault.create('Fresh.md', 'hello')
  tR += [made instanceof tp.obsidian.TFile, made.path, made.basename, made.content,
    String(tp.app.vault.getAbstractFileByPath('Fresh.md') === made), made.parent instanceof tp.obsidian.TFolder].join('|')`, answered('note.create', created))
    expect(seen.calls[0].args).toEqual(['Fresh.md', 'hello'])
    expect(seen.output).toBe('true|Fresh.md|Fresh|hello|true|true')
  })

  it('refuses to overwrite a path that is already taken', async () => {
    const seen = await render(
      "await tp.app.vault.create('Reading/Target.md', 'x')",
      refused('note.create', 'note-conflict', 'Reading/Target.md'),
    )
    expect(seen.failure).toMatchObject({ code: 'note-conflict', detail: 'Reading/Target.md' })
  })

  it('writes a note through the page and answers nothing', async () => {
    const seen = await render(
      "tR += String(await tp.app.vault.modify(tp.config.target_file, 'a new body'))",
      answered('note.write', null),
    )
    expect(seen.calls[0].args).toEqual(['Reading/Target.md', 'a new body'])
    expect(seen.output).toBe('undefined')
  })

  it('deletes through the page and drops the note from the tree', async () => {
    const seen = await render(`
  await tp.app.vault.delete(tp.config.target_file)
  tR += [String(tp.app.vault.getAbstractFileByPath('Reading/Target.md')), String(tp.app.vault.exists('Reading/Target.md')),
    tp.app.vault.getMarkdownFiles().length].join('|')`, answered('note.delete', null))
    expect(seen.calls.map((call) => call.method)).toEqual(['note.delete'])
    expect(seen.calls[0].args).toEqual(['Reading/Target.md'])
    expect(seen.output).toBe('null|false|2')
  })

  it('answers exists and the path lookups from the snapshot, without a round trip', async () => {
    const seen = await render(`
  tR += [tp.app.vault.exists('Other.md'), tp.app.vault.exists('Archive'), tp.app.vault.exists('Nope.md'),
    tp.app.vault.getAbstractFileByPath('Archive') instanceof tp.obsidian.TFolder,
    tp.app.vault.getAbstractFileByPath('Other.md') instanceof tp.obsidian.TFile].join(',')`)
    expect(seen.calls).toEqual([])
    expect(seen.output).toBe('true,true,false,true,true')
  })

  it('lists the tree in Obsidian’s shapes', async () => {
    const seen = await render(`
  const root = tp.app.vault.getRoot()
  tR += [tp.app.vault.getFiles().length, tp.app.vault.getMarkdownFiles().length,
    tp.app.vault.getMarkdownFiles().every((file) => file instanceof tp.obsidian.TFile),
    root.path === '' && root instanceof tp.obsidian.TFolder,
    tp.app.vault.getAbstractFileByPath('').name === '',
    tp.app.vault.getFileByPath('Archive') === null,
    tp.app.vault.getFolderByPath('Archive') instanceof tp.obsidian.TFolder,
    tp.app.vault.getFileByPath('Other.md').basename].join('|')`)
    expect(seen.calls).toEqual([])
    expect(seen.output).toBe('3|3|true|true|true|true|true|Other')
  })

  it('creates a folder through the page and knows the chain it made', async () => {
    const created = { id: 'folder-9', name: 'Deep', parentId: null, path: 'Plans/Deep' }
    const seen = await render(`
  const folder = await tp.app.vault.createFolder('Plans/Deep')
  tR += [folder instanceof tp.obsidian.TFolder, folder.path, folder.name,
    tp.app.vault.getFolderByPath('Plans') instanceof tp.obsidian.TFolder,
    tp.app.vault.exists('Plans/Deep')].join('|')`, answered('folder.create', created))
    expect(seen.calls[0].args).toEqual(['Plans/Deep'])
    expect(seen.output).toBe('true|Plans/Deep|Deep|true|true')
  })

  it('refuses the root as a folder to create', async () => {
    const seen = await render("await tp.app.vault.createFolder('')")
    expect(seen.failure).toMatchObject({ code: 'path-invalid', detail: 'tp.app.vault.createFolder' })
  })

  it('fails a façade read the same way the module beside it does when the profile lacks the right', async () => {
    const read = await render('await tp.app.vault.read("Other.md")', () => ({ value: null }), { capabilities: 'community' })
    expect(read.failure).toMatchObject({ code: 'capability-blocked', detail: 'note.read' })
    const write = await render("await tp.app.vault.create('Fresh.md', 'x')", () => ({ value: null }), { capabilities: 'community' })
    expect(write.failure).toMatchObject({ code: 'capability-blocked', detail: 'note.create' })
    const open = await render("await tp.app.workspace.openFile(tp.config.target_file)", () => ({ value: null }), { capabilities: 'community' })
    expect(open.failure).toMatchObject({ code: 'capability-blocked', detail: 'note.open' })
    const web = await render('await tp.obsidian.requestUrl({ url: "https://example.com" })', () => ({ value: null }), { capabilities: 'community' })
    expect(web.failure).toMatchObject({ code: 'capability-blocked', detail: 'web.request' })
    // The same call under the reader's own profile is answered, so the refusal above is the gate and not
    // this facade deciding for it.
    const allowed = await render(
      "tR += (await tp.app.vault.create('Fresh.md', 'x')).path",
      answered('note.create', { id: 'note-7', title: 'Fresh', folderId: null, path: 'Fresh.md' }),
    )
    expect(allowed.output).toBe('Fresh.md')
  })

  it('answers a page failure with the page’s own code, not a re-labelled one', async () => {
    const seen = await render("await tp.app.vault.read('Other.md')", refused('note.read', 'note-not-found', 'Other.md'))
    expect(seen.failure).toMatchObject({ code: 'note-not-found', detail: 'Other.md' })
  })
})

describe('tp.app.fileManager', () => {
  it('renames and moves a note in one call, and the run sees where it went', async () => {
    const moved = { id: 'note-1', title: 'Renamed', folderId: 'folder-2', path: 'Archive/Renamed.md', updatedAt: 9, createdAt: 1 }
    const seen = await render(`
  const before = tp.config.target_file.path
  await tp.app.fileManager.renameFile(tp.config.target_file, 'Archive/Renamed.md')
  tR += [before, tp.config.target_file.path,
    tp.app.vault.getAbstractFileByPath('Archive/Renamed.md').basename,
    String(tp.app.vault.getAbstractFileByPath('Reading/Target.md'))].join('|')`, answered('note.move', moved))
    expect(seen.calls[0].args).toEqual(['Reading/Target.md', 'Archive/Renamed.md'])
    expect(seen.output).toBe('Reading/Target.md|Archive/Renamed.md|Renamed|null')
  })

  it('adds the extension a destination written without one needs', async () => {
    const moved = { id: 'note-3', title: 'Filed', folderId: 'folder-2', path: 'Archive/Filed.md', updatedAt: 9, createdAt: 1 }
    const seen = await render(
      "await tp.app.fileManager.renameFile(tp.file.find_tfile('Old Note'), 'Archive/Filed')",
      answered('note.move', moved),
    )
    expect(seen.calls[0].args).toEqual(['Archive/Old Note.md', 'Archive/Filed.md'])
    expect(seen.output).toBe('')
  })

  it('refuses a destination that names no path', async () => {
    const seen = await render("await tp.app.fileManager.renameFile(tp.config.target_file, '')")
    expect(seen.failure).toMatchObject({ code: 'path-invalid', detail: 'tp.app.fileManager.renameFile' })
  })
})

describe('tp.app.metadataCache', () => {
  it('resolves a link to a note, and to nothing', async () => {
    const seen = await render(`
  const found = tp.app.metadataCache.getFirstLinkpathDest('Other', tp.config.target_file.path)
  const filed = tp.app.metadataCache.getFirstLinkpathDest('Old Note', '')
  const missing = tp.app.metadataCache.getFirstLinkpathDest('No Such Note', '')
  tR += [found instanceof tp.obsidian.TFile, found.path, filed.path, String(missing)].join('|')`)
    // A link resolution is a read of the run's own index, so nothing goes to the page.
    expect(seen.calls).toEqual([])
    expect(seen.output).toBe('true|Other.md|Archive/Old Note.md|null')
  })

  it('drops a heading or block suffix before looking the link up', async () => {
    const seen = await render(`
  tR += tp.app.metadataCache.getFirstLinkpathDest('Other#Section', '').path + '|'
    + String(tp.app.metadataCache.getFirstLinkpathDest('', ''))`)
    expect(seen.output).toBe('Other.md|null')
  })

  it('answers the target note in full and another note lightly', async () => {
    const seen = await render(`
  const cache = tp.app.metadataCache.getFileCache(tp.config.target_file)
  tR += [JSON.stringify(cache.frontmatter), cache.tags.join(','), cache.headings.length,
    cache.headings[0].heading, cache.headings[0].level,
    cache.links.map((link) => link.link).join(','), cache.embeds.length].join('|')`)
    expect(seen.calls).toEqual([])
    expect(seen.output).toBe('{"level":3}|#reading|1|Heading one|1|Other|1')
  })

  it('says nothing it does not know about a note the snapshot carries no text for', async () => {
    const seen = await render(`
  const light = tp.app.metadataCache.getCache('Archive/Old Note.md')
  tR += [light !== null, light.frontmatter === null, light.tags.length, light.headings.length,
    String(tp.app.metadataCache.getCache('Nope.md')),
    String(tp.app.metadataCache.getCache('Archive'))].join('|')`)
    expect(seen.output).toBe('true|true|0|0|null|null')
  })

  it('hands its tags to getAllTags unchanged', async () => {
    const seen = await render(`
  tR += tp.obsidian.getAllTags(tp.app.metadataCache.getFileCache(tp.config.target_file)).join(',')
    + '|' + String(tp.obsidian.getAllTags(tp.app.metadataCache.getCache('Archive/Old Note.md')))`)
    expect(seen.output).toBe('#reading|null')
  })

  it('refuses a file argument that is not a note', async () => {
    const seen = await render('tp.app.metadataCache.getFileCache(7)')
    expect(seen.failure).toMatchObject({ code: 'path-invalid', detail: 'tp.app.metadataCache.getFileCache' })
  })
})

describe('tp.app.workspace', () => {
  it('wraps the run’s selection as the active editor and the active note as its file', async () => {
    const seen = await render(`
  const active = tp.app.workspace.activeEditor
  tR += [active.file === tp.app.workspace.getActiveFile(), active.file.basename,
    active.editor.getSelection(), active.editor.hasSelection(), active.editor.getValue(),
    active.view].join('|')`)
    expect(seen.calls).toEqual([])
    // `join` renders a null as nothing between the separators, which is the point: the view is absent.
    expect(seen.output).toBe('true|Other|the picked text|true|the open note|')
  })

  it('answers no active note with null on both doors', async () => {
    const seen = await render(
      'tR += [String(tp.app.workspace.getActiveFile()), String(tp.app.workspace.activeEditor.file)].join("|")',
      () => ({ value: null }),
      { active: null },
    )
    expect(seen.output).toBe('null|null')
  })

  it('refuses to write through the editor rather than pretend to', async () => {
    const seen = await render("tp.app.workspace.activeEditor.editor.replaceSelection('x')")
    expect(seen.failure).toMatchObject({
      code: 'not-supported',
      detail: 'tp.app.workspace.activeEditor.editor.replaceSelection',
    })
  })

  it('has no leaf to hand out, and opens a note through the page', async () => {
    const seen = await render(`
  tR += String(tp.app.workspace.getLeaf()) + '|' + String(await tp.app.workspace.openFile(tp.config.target_file))`,
      answered('note.open', undefined))
    expect(seen.calls.map((call) => call.method)).toEqual(['note.open'])
    expect(seen.calls[0].args).toEqual(['Reading/Target.md'])
    expect(seen.output).toBe('null|undefined')
  })

  it('refuses to fire an event nobody here can listen for, naming the event', async () => {
    const seen = await render("tp.app.workspace.trigger('editor-change', tp.config.target_file)")
    expect(seen.failure).toMatchObject({ code: 'not-supported', detail: 'tp.app.workspace.trigger.editor-change' })
  })
})

describe('tp.obsidian pure helpers', () => {
  it('normalizes paths and link text the way Obsidian does', async () => {
    const seen = await render(`
  tR += [tp.obsidian.normalizePath('/a//b/'), tp.obsidian.normalizePath('a\\\\b\\\\c.md'),
    tp.obsidian.parseLinktext('Note#Heading').path, tp.obsidian.parseLinktext('Note#Heading').subpath.type,
    tp.obsidian.parseLinktext('Note#^abc123').subpath.target, String(tp.obsidian.parseLinktext('Note').subpath)].join('|')`)
    expect(seen.output).toBe('a/b|a/b/c.md|Note|heading|abc123|null')
  })

  it('reports front matter the way Obsidian’s own helper does, edges included', async () => {
    const seen = await render(`
  const withBlock = tp.obsidian.getFrontMatterInfo('---\\ntitle: x\\n---\\nbody')
  const unclosed = tp.obsidian.getFrontMatterInfo('---\\ntitle: x\\nbody')
  const emptyBlock = tp.obsidian.getFrontMatterInfo('---\\n---\\nbody')
  const dotted = tp.obsidian.getFrontMatterInfo('---\\na: 1\\n...\\n')
  const none = tp.obsidian.getFrontMatterInfo('body')
  tR += [withBlock.exists, withBlock.frontmatter, withBlock.from, withBlock.to, withBlock.end,
    withBlock.lastFrontmatterLine, unclosed.exists, emptyBlock.exists, emptyBlock.frontmatter,
    emptyBlock.lastFrontmatterLine === '', dotted.exists, dotted.frontmatter, none.exists, none.from].join('|')`)
    expect(seen.output).toBe('true|title: x|13|17|2|title: x|false|true||true|true|a: 1|false|0')
  })

  it('writes an object as a YAML block this app’s merge reads back', async () => {
    const seen = await render(`
  tR += tp.obsidian.stringifyYaml({ title: 'A note', level: 3, tags: ['one', 'two'], done: false, cleared: null,
    nested: { a: 1, b: 'two words' }, list: [], map: {}, note: 'Note: keep', numberish: '12' })`)
    expect(seen.output).toBe([
      'title: A note',
      'level: 3',
      'tags:',
      '  - one',
      '  - two',
      'done: false',
      'cleared: null',
      'nested:',
      '  a: 1',
      '  b: two words',
      'list: []',
      'map: {}',
      'note: "Note: keep"',
      'numberish: "12"',
    ].join('\n'))
  })

  it('reads back what it wrote, and reports what it cannot round-trip', async () => {
    const text = [
      'title: A note',
      'level: 3',
      'tags:',
      '  - one',
      '  - two',
      'nested:',
      '  a: 1',
      'flow: [x, 2, "three words"]',
      '# a comment',
      'cleared:',
      'quoted: "said: hi"',
    ].join('\n')
    const seen = await render(`
  const read = tp.obsidian.parseYaml(${JSON.stringify(text)})
  tR += [read.title, read.level, typeof read.level, read.tags.join(','), read.nested.a,
    read.flow.join('|'), read.cleared === null, read.quoted,
    String(tp.obsidian.parseYaml('')), String(tp.obsidian.parseYaml('[]')),
    tp.obsidian.stringifyYaml({}), tp.obsidian.stringifyYaml([])].join('|')`)
    expect(seen.output).toBe('A note|3|number|one,two|1|x|2|three words|true|said: hi|null||{}|[]')
  })

  it('refuses a YAML construct it would otherwise read wrong', async () => {
    const cases = [
      ['anchor: &a text', 'obsidian.parseYaml.scalar'],
      ['alias: *a', 'obsidian.parseYaml.scalar'],
      ['tag: !!str 1', 'obsidian.parseYaml.scalar'],
      ['block: |\n  line', 'obsidian.parseYaml.scalar'],
      ['flow: {a: 1}', 'obsidian.parseYaml.flow-mapping'],
      ['- one:\n    two: 3', 'obsidian.parseYaml.sequence-of-mappings'],
      ['- - a', 'obsidian.parseYaml.nested-sequence'],
      ['---\na: 1', 'obsidian.parseYaml.document'],
    ]
    for (const [text, detail] of cases) {
      const seen = await render(`tp.obsidian.parseYaml(${JSON.stringify(text)})`)
      expect(seen.failure, text).toMatchObject({ code: 'not-supported', detail })
    }
    const refused = await render("tp.obsidian.parseYaml('a: 1\\n b: 2')")
    expect(refused.failure).toMatchObject({ code: 'parse-invalid', detail: 'obsidian.parseYaml.indent:2' })
    const tab = await render("tp.obsidian.parseYaml('a:\\n\\t b: 1')")
    expect(tab.failure).toMatchObject({ code: 'parse-invalid', detail: 'obsidian.parseYaml.tab:2' })
  })

  it('refuses a value it cannot write as YAML text', async () => {
    const fn = await render('tp.obsidian.stringifyYaml({ thing: () => 1 })')
    expect(fn.failure).toMatchObject({ code: 'not-supported', detail: 'obsidian.stringifyYaml.function' })
    const circular = await render('const node = {}\nnode.self = node\ntp.obsidian.stringifyYaml(node)')
    expect(circular.failure).toMatchObject({ code: 'not-supported', detail: 'obsidian.stringifyYaml.circular' })
    const nested = await render("tp.obsidian.stringifyYaml({ list: [['a']] })")
    expect(nested.failure).toMatchObject({ code: 'not-supported', detail: 'obsidian.stringifyYaml.nested-sequence' })
    const infinite = await render('tp.obsidian.stringifyYaml({ n: Infinity })')
    expect(infinite.failure).toMatchObject({ code: 'not-supported', detail: 'obsidian.stringifyYaml.number' })
  })

  it('writes a date as the text the app’s own YAML reader resolves', async () => {
    const seen = await render('tR += tp.obsidian.stringifyYaml({ day: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)) })')
    expect(seen.output).toBe('day: 2026-01-02T03:04:05.000Z')
  })
})

describe('tp.obsidian platform members', () => {
  it('answers the platform flags the plan fixes, and no others', async () => {
    const seen = await render(`
  tR += [tp.obsidian.Platform.isDesktop, tp.obsidian.Platform.isDesktopApp,
    tp.obsidian.Platform.isMobile, tp.obsidian.Platform.isMobileApp].join('|')`)
    expect(seen.output).toBe('true|false|false|false')
  })

  it('carries the response shape Obsidian documents, over the app’s own proxy', async () => {
    const reply = { status: 200, ok: true, contentType: 'application/json', text: '{"value":7}' }
    const seen = await render(`
  const response = await tp.obsidian.requestUrl({ url: 'https://example.com/data' })
  tR += [response.status, response.ok, response.headers['content-type'], response.text,
    response.json.value, String(response.arrayBuffer)].join('|')`, answered('web.request', reply))
    expect(seen.calls[0].args).toEqual([{ url: 'https://example.com/data' }])
    expect(seen.output).toBe('200|true|application/json|{"value":7}|7|undefined')
  })

  it('leaves a non-2xx answer for the template to judge, unless it asks for the throw', async () => {
    const reply = { status: 404, ok: false, contentType: 'text/plain', text: 'missing' }
    const quiet = await render(`
  const response = await tp.obsidian.requestUrl({ url: 'https://example.com/gone' })
  tR += [response.status, response.ok, response.text, String(response.json)].join('|')`, answered('web.request', reply))
    expect(quiet.output).toBe('404|false|missing|null')
    // Obsidian's own option: a failed request throws instead of answering.
    const strict = await render("await tp.obsidian.requestUrl({ url: 'https://example.com/gone', throw: true })", answered('web.request', reply))
    expect(strict.failure).toMatchObject({ code: 'web-request-failed', detail: '404' })
  })

  it('refuses the request fields its GET-only door cannot carry', async () => {
    for (const member of ['method', 'headers', 'body']) {
      const seen = await render(`await tp.obsidian.requestUrl({ url: 'https://example.com', ${member}: 'x' })`)
      expect(seen.failure, member).toMatchObject({ code: 'not-supported', detail: 'tp.obsidian.requestUrl.' + member })
    }
    const missing = await render('await tp.obsidian.requestUrl({})')
    expect(missing.failure).toMatchObject({ code: 'path-invalid', detail: 'tp.obsidian.requestUrl.url' })
  })

  it('keeps the classes and the date library reachable, as the upstream examples assume', async () => {
    const seen = await render(`
  const folders = tp.app.vault.getAllLoadedFiles().filter((x) => x instanceof tp.obsidian.TFolder)
  tR += [folders.length, folders[0] instanceof tp.obsidian.TAbstractFile,
    tp.moment === moment && moment(0).format('YYYY'),
    tp.config.target_file instanceof tp.obsidian.TFile,
    tp.app.vault.getMarkdownFiles().every((f) => f instanceof tp.obsidian.TFile)].join('|')`)
    // The root folder is one of the loaded files, as it is in Obsidian's own list.
    expect(seen.output).toBe('3|true|1970|true|true')
  })

  it('refuses a Notice instead of swallowing the message', async () => {
    const seen = await render('new tp.obsidian.Notice("done")')
    expect(seen.failure).toMatchObject({ code: 'not-supported', detail: 'obsidian.Notice' })
  })
})

describe('unknown members of the facades', () => {
  it('names the member path the template wrote, for every object on the table', async () => {
    const cases = [
      ['tp.app.vault.getReadonlyFiles()', 'tp.app.vault.getReadonlyFiles'],
      ['tp.app.metadataCache.getHeaderCacheForPath("x")', 'tp.app.metadataCache.getHeaderCacheForPath'],
      ['tp.app.workspace.iterateAllLeaves()', 'tp.app.workspace.iterateAllLeaves'],
      ['tp.app.fileManager.getNewFileParent()', 'tp.app.fileManager.getNewFileParent'],
      ['tp.app.templateRegistry.getTemplateInfo()', 'tp.app.templateRegistry.getTemplateInfo'],
      ['tp.app.vault.adapter.exists("Other.md")', 'tp.app.vault.adapter.exists'],
      ['tp.obsidian.MarkdownView()', 'tp.obsidian.MarkdownView'],
      ['tp.obsidian.debounce.Debounce()', 'tp.obsidian.debounce.Debounce'],
    ]
    for (const [call, detail] of cases) {
      const seen = await render(`await ${call}`)
      expect(seen.failure, call).toMatchObject({ code: 'not-supported', detail })
    }
  })

  it('stays a plain probe for the engine and for a template that only asks', async () => {
    const seen = await render(`
  tR += [tp.app.vault.then === undefined, tp.app.then === undefined, tp.obsidian.then === undefined,
    typeof tp.app.vault.getMarkdownFiles, Symbol.iterator in tp.obsidian].join('|')`)
    expect(seen.output).toBe('true|true|true|function|false')
  })
})
